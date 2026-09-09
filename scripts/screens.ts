import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `pnpm screens`: capture the app's screens for design review.
 *
 * The browser suite seeds `core,demo-basic` so no case depends on another having run first, but
 * screenshots of an empty Tasks list review nothing. This runs the same launcher on the full demo
 * profile - campaigns, enrollments and live tasks - against a throwaway data directory, so the
 * captures show the app with work in it.
 */
const OUT = path.join(process.cwd(), '.screens');
const DB_DIR = '.pgdata-screens';

fs.rmSync(DB_DIR, { recursive: true, force: true });
fs.rmSync(OUT, { recursive: true, force: true });

execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'e2e/screens.spec.ts'], {
  stdio: 'inherit',
  env: { ...process.env, E2E_SEED: 'core,demo', E2E_DB_DIR: DB_DIR, E2E_PORT: process.env.E2E_PORT ?? '3112' },
});

console.log(`\n${fs.readdirSync(OUT).length} screens in ${OUT}`);
