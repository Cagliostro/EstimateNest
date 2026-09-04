import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const testResultsDir = path.join(__dirname, 'test-results', 'dev-smoke');

export default defineConfig({
  testDir: './tests',
  testMatch: 'dev-smoke.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 2,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(testResultsDir, 'html-report') }],
    ['./reporters/ai-reporter.ts'],
  ],
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  use: {
    // SMOKE_FRONTEND_URL lets the advanced scenarios run against the local
    // dev servers (http://localhost:5173); the default is deployed dev.
    baseURL: process.env.SMOKE_FRONTEND_URL ?? 'https://dev.estimatenest.net',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  outputDir: path.join(testResultsDir, 'traces'),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // No webServer — tests run against the deployed dev environment
});
