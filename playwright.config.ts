import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke tests against the production build (`npm run build` first).
 * CI runs them with no Cesium ion token, so they prove the token-free path.
 *
 * Locally: PW_CHROMIUM=/usr/sbin/chromium npx playwright test
 * (PW_GL_ARGS overrides the WebGL flags, e.g. a real GPU via Vulkan.)
 *
 * Project 'show-mode' (e2e/show-mode.spec.ts, CI job 'show-mode') runs
 * headed Chrome (Document Picture-in-Picture has no headless window; use
 * xvfb-run on a server) with Chrome's background throttling left on, so a
 * hidden tab behaves as it does for a rider:
 *   xvfb-run -a -s "-screen 0 2560x1600x24" npx playwright test --project=show-mode
 * (2560 px wide: the second test is a 1280 CSS px screen at DPR 2)
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
      testIgnore: /show-mode\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          args: glArgs,
          ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
        },
      },
    },
    {
      // Launches its own headed Chrome and drives it over the DevTools
      // protocol (see the spec for why); no Playwright browser here.
      name: 'show-mode',
      testMatch: /show-mode\.spec\.ts$/,
    },
  ],
  webServer: {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/app`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
