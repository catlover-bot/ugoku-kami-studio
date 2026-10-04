import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: true,
  forbidOnly: !!process.env.CI, retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4183', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  // Own a separate, AI-disabled server. Reusing a developer's live-enabled server
  // would allow an unmocked test request to consume their API quota.
  webServer: { command: 'npm run build && PORT=4183 AI_PROVIDER=none GEMINI_API_KEY= AI_ACCESS_SECRET= LIVE_API_AUTHORIZED= npm start', url: 'http://127.0.0.1:4183/api/health', reuseExistingServer: false, timeout: 120000 },
});
