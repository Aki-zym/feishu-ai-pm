import { defineConfig, devices } from '@playwright/test';

function e2ePort(name: string, fallback: number) {
  const port = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a valid TCP port.`);
  return port;
}

const desktopPort = e2ePort('E2E_DESKTOP_PORT', 4410);
const mobilePort = e2ePort('E2E_MOBILE_PORT', 4412);
const evidenceReporter = Boolean(process.env.CI || process.env.E2E_EVIDENCE === '1');

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.mjs',
  fullyParallel: false,
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  forbidOnly: true,
  reporter: evidenceReporter
    ? [[process.env.CI ? 'github' : 'list'], ['json', { outputFile: 'tmp/ci-reports/playwright-results.json' }]]
    : 'list',
  use: {
    trace: 'retain-on-first-failure',
    screenshot: 'on-first-failure',
  },
  projects: [
    {
      name: 'browser-desktop-chromium',
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${desktopPort}`, viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'browser-mobile-chromium',
      testIgnore: /desktop-bridge\.spec\.ts/,
      use: { ...devices['Pixel 7'], baseURL: `http://127.0.0.1:${mobilePort}` },
    },
  ],
});
