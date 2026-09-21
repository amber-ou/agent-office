import { defineConfig } from '@playwright/test';

// A browser-only contract test: no CLI, hooks, user settings, or model calls.
export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'office-characters.spec.ts',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  outputDir: '../test-results/office-characters',
  use: {
    baseURL: 'http://127.0.0.1:5178',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    viewport: { width: 1100, height: 760 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      'node node_modules/vite/bin/vite.js webview-ui --host 127.0.0.1 --port 5178 --strictPort',
    cwd: '..',
    url: 'http://127.0.0.1:5178',
    reuseExistingServer: !process.env.CI,
  },
});
