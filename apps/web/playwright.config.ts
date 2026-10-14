import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests for WeTa Snap in demo mode (no VITE_API_URL → the in-browser mock backend).
 * Uses the installed Microsoft Edge (no Playwright browser download). Test files are named
 * *.e2e.ts so Vitest (which picks up *.spec/*.test) never runs them.
 */
const PORT = 5199;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: './e2e/.results',
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: true,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 4,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: './e2e/.results/results.json' }],
    ['html', { outputFolder: './e2e/.report', open: 'never' }],
  ],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.PW_CHANNEL ?? 'msedge',
    headless: true,
    viewport: { width: 1366, height: 768 },
    acceptDownloads: true,
    serviceWorkers: 'block',
    locale: 'en-GB',
    timezoneId: 'Europe/Berlin',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    // These tests are written against the demo backend and its seed, so they ignore a local
    // .env.local pointing at the API (services/api). Run the app itself to use that.
    env: { VITE_API_URL: '' },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
