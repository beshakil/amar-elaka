import { defineConfig, devices } from '@playwright/test';
import { STUB_PORT, STUB_URL } from './stub-api/fixtures';

const WEB_PORT = 3001;
const ADMIN_PORT = 3002;

/**
 * Runtime configuration for the apps under test — the same variables a
 * deployment sets. Nothing is baked in at build time, so the production builds
 * `turbo run test:e2e` makes are the ones a real deployment would run.
 */
const appEnv = {
  API_BASE_URL: `${STUB_URL}/api/v1`,
  APP_ROOT_DOMAIN: 'localhost',
  SITE_ORIGIN: `http://localhost:${WEB_PORT}`,
  STORAGE_PUBLIC_URL: `${STUB_URL}/media`,
  NODE_ENV: 'production',
};

/**
 * End-to-end suite: the production builds of apps/web and apps/admin
 * (`next start`), driven in a real browser, against the contract-typed stub API
 * in ./stub-api. Tests share the stub's state and reset it per test, so they
 * run serially.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'bn-BD',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Chromium already resolves every *.localhost to loopback, which is
        // what tenant subdomains use; this maps the custom-domain fixture too.
        launchOptions: { args: ['--host-resolver-rules=MAP mirpur-bazaar.test 127.0.0.1'] },
      },
    },
  ],
  webServer: [
    {
      command: 'tsx stub-api/server.ts',
      url: `${STUB_URL}/__stats`,
      env: { STUB_PORT: String(STUB_PORT) },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `pnpm --filter @amar-elaka/web exec next start --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}/robots.txt`,
      env: appEnv,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `pnpm --filter @amar-elaka/admin exec next start --port ${ADMIN_PORT}`,
      url: `http://127.0.0.1:${ADMIN_PORT}/login`,
      env: appEnv,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
