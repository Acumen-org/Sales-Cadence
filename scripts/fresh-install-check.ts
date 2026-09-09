import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * `pnpm test:fresh` - drive the app as a brand-new deployment.
 *
 * The main browser suite seeds a sample workspace so it has work to act on. This one seeds `core`
 * alone: the default sequence and one admin account, exactly what a real install has on its first
 * morning. It runs on its own port and its own throwaway database so it cannot see the other
 * suite's data, and it is the check that matters before handing the platform to somebody.
 */
const DB_DIR = '.pgdata-fresh';
fs.rmSync(DB_DIR, { recursive: true, force: true });

execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'e2e/fresh-install.spec.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    E2E_SEED: 'core',
    E2E_DB_DIR: DB_DIR,
    E2E_PORT: process.env.E2E_PORT ?? '3113',
    E2E_INCLUDE_FRESH: '1',
  },
});
