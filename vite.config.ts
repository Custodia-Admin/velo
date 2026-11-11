import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    react(),
    cesium({ rebuildCesium: true }),
    VitePWA({
      // 'prompt': the new worker WAITS after a deploy instead of skipping
      // waiting; src/lib/swUpdate.ts activates it only while the rider is off
      // /ride. 'autoUpdate' reloaded the page mid-ride when a deploy landed.
      // The plugin's register helper is not used (it reloads on activation).
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg', 'favicon.ico'],
      manifest: {
        name: 'Velo',
        short_name: 'Velo',
        description: 'Ride real places on your smart trainer: a calm, scenic indoor ride in your browser.',
        theme_color: '#f8f6f2',
        background_color: '#f8f6f2',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Cesium ships some large WASM/JS chunks; bump the precache size limit.
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        // glb: the rider model (public/models/velo-rider.glb). Without it a
        // world ride offline crashes the world renderer (worldCache.test.ts).
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,wasm,woff2,glb}'],
        navigateFallback: '/index.html',
        // Remote world bundles (lib/world/catalog.ts remoteWorldsBaseUrl, an
        // R2 bucket by default) live under content-hashed dirs
        // `…/worlds/<id>/<16 hex>/<file>`: a URL never changes, so the first
        // ride's download serves every later ride, offline included. Same
        // cache name as the loader's own Cache API copy (lib/world/worldCache.ts,
        // WORLD_CACHE_NAME; worldCache.test.ts pins the two together). The
        // pattern is anchored at the scheme: workbox only applies a RegExp to
        // a cross-origin URL when it matches from the first character.
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.+\/worlds\/[a-z0-9-]+\/[0-9a-f]{16}\/[^/?#]+$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'velo-worlds-v1',
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 400, maxAgeSeconds: 180 * 24 * 60 * 60 },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    // Tailnet access (tablet etc.) — allow the machine's ts.net hostnames.
    allowedHosts: ['.ts.net'],
    proxy: {
      // xAI proxy — routes /xai/* → https://api.x.ai/* to avoid CORS in the
      // browser during dev. In production, expose the same /xai path via your
      // hosting proxy (e.g. Vercel rewrites, Cloudflare Workers) or a
      // serverless function that adds the Authorization header server-side
      // so the API key is never sent from the browser to a public endpoint.
      '/xai': {
        target: 'https://api.x.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/xai/, ''),
        secure: true,
      },
    },
  },
  preview: {
    host: true,
    allowedHosts: ['.ts.net'],
    proxy: {
      '/xai': {
        target: 'https://api.x.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/xai/, ''),
        secure: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
