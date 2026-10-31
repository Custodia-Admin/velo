import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke tests against the production build (`npm run build` first).
 * CI runs them with no Cesium ion token, so they prove the token-free path.
 *
 * Locally: PW_CHROMIUM=/usr/sbin/chromium npx playwright test
 * (PW_GL_ARGS overrides the WebGL flags, e.g. a real GPU via Vulkan.)
 */
const PORT = Number(process.env.SMOKE_PORT ?? 4199);
const glArgs = (process.env.PW_GL_ARGS ?? '--use-angle=swiftshader --enable-unsafe-swiftshader')
  .split(' ')
  .filter(Boolean);

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          args: glArgs,
          ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
        },
      },
    },
  ],
  webServer: {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/app`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
