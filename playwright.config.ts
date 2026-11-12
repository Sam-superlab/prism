import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'output/playwright/report', open: 'never' }]],
  outputDir: 'output/playwright/test-results',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:3100',
          localStorage: [
            {
              name: 'prism.getting-started.v1.11111111-1111-4111-8111-111111111111',
              value: '{"status":"hidden"}',
            },
          ],
        },
      ],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'pnpm exec tsx scripts/e2e-api.ts',
      url: 'http://127.0.0.1:4100/health',
      timeout: 120000,
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @prism/web exec next dev --hostname 127.0.0.1 --port 3100',
      url: 'http://127.0.0.1:3100/today',
      timeout: 120000,
      reuseExistingServer: false,
      env: {
        PRISM_API_URL: 'http://127.0.0.1:4100',
        PRISM_AUTH_MODE: 'development',
        PRISM_WEB_ORIGIN: 'http://127.0.0.1:3100',
        PRISM_NEXT_DIST_DIR: '.next-e2e',
      },
    },
  ],
});
