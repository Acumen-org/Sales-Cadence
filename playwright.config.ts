import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3111);

/**
 * Browser end-to-end tests against the real app: the launcher starts an embedded Postgres,
 * migrates, seeds the demo workspace (mock Twenty) and serves the production build.
 * `pnpm test:e2e` rebuilds, wipes .pgdata-e2e and runs this.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
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
      TWENTY_MODE: 'mock',
      TWENTY_API_URL: 'http://twenty.local:3000',
      APP_URL: `http://localhost:${PORT}`,
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
