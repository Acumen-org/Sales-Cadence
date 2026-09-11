import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3111);

/**
 * Browser end-to-end tests against the real app: the launcher starts an embedded Postgres,
 * migrates, seeds the demo workspace (mock Twenty) and serves the production build.
 * `pnpm test:e2e` rebuilds, wipes .pgdata-e2e and runs this.
 */
export default defineConfig({
  testDir: 'e2e',
  // The fresh-install check needs a workspace seeded with `core` alone, so it runs on its own
  // through `pnpm test:fresh` rather than against this suite's sample data.
  testIgnore: process.env.E2E_INCLUDE_FRESH ? [] : ['**/fresh-install.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // One retry on CI only, and never locally. This is a mitigation, not a cure: the suite runs
  // serially against one shared workspace, so a single timing blip on a slower runner turns the
  // whole push red and hides the 44 tests that did pass. A retried test is still reported as
  // "flaky" rather than "passed", so nothing is swept up - see AUDIT.md for the one known flake
  // (an intermittent React hydration error on /activity) that has never reproduced locally.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node node_modules/tsx/dist/cli.mjs scripts/start-local.ts',
    url: `http://localhost:${PORT}/api/health`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      DEV_DB_PORT: '5435',
      DEV_DB_DIR: process.env.E2E_DB_DIR ?? '.pgdata-e2e',
      CADENCE_NO_BROWSER: '1',
      CADENCE_SKIP_BUILD: '1',
      // The lean demo dataset: people, pods and users but no campaigns. Cases that need live work
      // create it themselves, so no case depends on another having run first.
      SEED_PROFILE: process.env.E2E_SEED ?? 'core,demo-basic',
      ADMIN_EMAIL: 'admin@cadence.local',
      ADMIN_PASSWORD: 'admin12345',
      TWENTY_MODE: 'mock',
      CADENCE_ALLOW_MOCK: '1',
      TWENTY_API_URL: 'http://twenty.local:3000',
      APP_URL: `http://localhost:${PORT}`,
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
