import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const testResultsDir = path.join(__dirname, 'test-results');

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(testResultsDir, 'html-report') }],
    ['./reporters/ai-reporter.ts'],
  ],
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  outputDir: path.join(testResultsDir, 'traces'),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: [
    {
      command: 'npm run dev:server --workspace=backend',
      port: 3000,
      cwd: path.join(__dirname, '..'),
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npm run dev --workspace=frontend',
      port: 5173,
      cwd: path.join(__dirname, '..'),
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
