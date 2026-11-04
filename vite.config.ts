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
      registerType: 'autoUpdate',
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
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,wasm,woff2}'],
        navigateFallback: '/index.html',
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
          recharts: ['recharts'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
