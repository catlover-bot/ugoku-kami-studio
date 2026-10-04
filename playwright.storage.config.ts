import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/storage', testMatch: '**/*.spec.ts', fullyParallel: true,
  forbidOnly: !!process.env.CI, retries: 0, workers: 2, timeout: 45_000,
  reporter: [['list']], outputDir: 'artifacts/goal005/storage-test-results',
  use: { baseURL: 'http://127.0.0.1:4805', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: { command: 'npx vite --config apps/web/vite.config.ts --host 127.0.0.1 --port 4805 --strictPort', url: 'http://127.0.0.1:4805', reuseExistingServer: false, timeout: 60_000 },
});
