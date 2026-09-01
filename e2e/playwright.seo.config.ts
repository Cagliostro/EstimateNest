import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const testResultsDir = path.join(__dirname, 'test-results', 'seo');

export default defineConfig({
  testDir: './tests',
  testMatch: 'seo.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(testResultsDir, 'html-report') }],
  ],
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  outputDir: path.join(testResultsDir, 'traces'),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Requires a production build (npm run build --workspace=frontend) beforehand.
  // The test:seo root script builds first to avoid serving a stale dist.
  webServer: {
    command: 'npm run preview --workspace=frontend',
    port: 4173,
    cwd: path.join(__dirname, '..'),
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
