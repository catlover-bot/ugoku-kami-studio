import { defineConfig } from '@playwright/test';

// Representative browser-engine coverage, not Safari/iPhone hardware validation.
// Own the AI-disabled server rather than reusing a developer's running instance.
export default defineConfig({
  testDir: './tests/webkit',
  testMatch: '**/*.spec.ts',
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  outputDir: 'artifacts/goal005/webkit/test-results',
  reporter: [['list'], ['html', { outputFolder: 'artifacts/goal005/webkit/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4819',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'webkit-narrow',
    use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  }],
  webServer: {
    command: 'npm run build && PORT=4819 AI_ENABLED=false GEMINI_API_KEY= AI_ACCESS_SECRET= LIVE_API_AUTHORIZED= npm start',
    url: 'http://127.0.0.1:4819/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
