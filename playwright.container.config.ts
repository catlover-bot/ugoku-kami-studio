import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.CONTAINER_BASE_URL || 'http://127.0.0.1:8080';
const target = new URL(baseURL);
if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('Container smoke requires a loopback HTTP origin');
}

// No webServer: CI must exercise the image it built, never a host-side substitute.
export default defineConfig({
  testDir: './tests/container',
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  outputDir: 'artifacts/goal004-r/container/test-results',
  reporter: [['list'], ['html', { outputFolder: 'artifacts/goal004-r/container/report', open: 'never' }]],
  use: { baseURL, screenshot: 'only-on-failure', trace: 'off', acceptDownloads: true },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
