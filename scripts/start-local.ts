import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parse } from 'dotenv';
import { prepareDatabaseDirectory } from './local-runtime';

/**
 * One-click local run, no Docker:
 *   1. embedded Postgres (data in .pgdata-dev)
 *   2. .env created from .env.example if missing
 *   3. prisma migrate deploy + seed (default sequence, admin, demo pods/users/people)
 *   4. next start on PORT (default 3100) + the worker
 *   5. opens the browser on the login page (one-click demo sign-in in mock mode)
 * Ctrl+C (or closing the window) stops everything.
 */
const root = process.cwd();
const port = Number.parseInt(process.env.PORT ?? '3100', 10);
const dbPort = Number.parseInt(process.env.DEV_DB_PORT ?? '5434', 10);
// connection_limit matters: Prisma's default pool is (cores * 2 + 1), which on a big desktop
// opens dozens of Postgres backends for a single-user app. Six is plenty for the web app.
const databaseUrl = `postgresql://postgres:postgres@localhost:${dbPort}/cadence?connection_limit=6&pool_timeout=20`;
const workerDatabaseUrl = `postgresql://postgres:postgres@localhost:${dbPort}/cadence?connection_limit=3&pool_timeout=20`;
const isWin = process.platform === 'win32';
const bin = (name: string) => path.join(root, 'node_modules', '.bin', isWin ? `${name}.cmd` : name);
const log = (msg: string) => console.log(`[cadence] ${msg}`);

function ensureEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) {
    let text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    text = text.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${databaseUrl}`).replace(/^APP_URL=.*$/m, `APP_URL=http://localhost:${port}`);
    fs.writeFileSync(envPath, text);
    log('created .env from .env.example (mock Twenty, embedded database)');
  }
}

function readEnvFile(): Record<string, string> {
  return parse(fs.readFileSync(path.join(root, '.env'), 'utf8'));
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, label: string) {
  log(label);
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: isWin });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

const children: ChildProcess[] = [];
let pg: { stop(): Promise<void> } | null = null;
let stopping = false;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  log('stopping...');
  for (const c of children) {
    if (!c.pid) continue;
    if (isWin) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  try {
    await pg?.stop();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error(`server did not answer at ${url}`));
      else setTimeout(attempt, 700);
    };
    attempt();
  });
}

function openBrowser(url: string) {
  if (isWin) spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

async function main() {
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGHUP', () => void shutdown(0));
  // Last resort: if the parent is torn down without a signal handler running, take the children with it.
  process.on('exit', () => {
    for (const c of children) {
      if (!c.pid) continue;
      if (isWin) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGKILL');
    }
  });

  ensureEnv();
  const fileEnv = readEnvFile();
  const env: NodeJS.ProcessEnv = { ...fileEnv, ...process.env, DATABASE_URL: databaseUrl, APP_URL: `http://localhost:${port}`, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
  if (!env.TWENTY_MODE) env.TWENTY_MODE = 'mock';

  // 1. database
  const { databaseDir, fresh } = prepareDatabaseDirectory(root, process.env.DEV_DB_DIR ?? '.pgdata-dev');
  const mod = await import('embedded-postgres');
  const EmbeddedPostgres = (mod.default ?? mod) as unknown as new (opts: Record<string, unknown>) => { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; createDatabase(n: string): Promise<void> };
  const instance = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'postgres', port: dbPort, persistent: true, onLog: () => {} });
  log(fresh ? 'creating the local database...' : 'starting the local database...');
  if (fresh) {
    await instance.initialise();
  }
  await instance.start();
  pg = instance;
  if (fresh) await instance.createDatabase('cadence');

  // 2. schema + seed
  run(bin('prisma'), ['migrate', 'deploy'], env, 'applying migrations');
  run(bin('tsx'), ['prisma/seed.ts'], env, 'seeding (default sequence, admin, demo pods, users, people)');

  // Local launches pick up source changes. Test runs can explicitly reuse a build they just made.
  if (env.CADENCE_SKIP_BUILD !== '1' || !fs.existsSync(path.join(root, env.NEXT_DIST_DIR || '.next', 'BUILD_ID'))) run(bin('next'), ['build'], env, 'building the current app');

  // 4. web + worker
  // Spawn node directly (no shell wrapper) so the pids we track are the real processes and
  // taskkill /T reliably takes the whole tree down on shutdown.
  log(`starting web on http://localhost:${port}`);
  const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  const tsxBin = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const web = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], { stdio: 'inherit', env });
  children.push(web);
  web.on('exit', (code) => {
    if (!stopping) {
      log(`web exited (${code})`);
      void shutdown(code ?? 1);
    }
  });
  const worker = spawn(process.execPath, [tsxBin, 'src/worker/index.ts'], { stdio: 'inherit', env: { ...env, DATABASE_URL: workerDatabaseUrl } });
  children.push(worker);

  await waitForHttp(`http://localhost:${port}/api/health`, 120_000);
  const url = `http://localhost:${port}/login`;
  console.log('');
  log('====================================================');
  log(`Cadence is running: ${url}`);
  log(env.TWENTY_MODE === 'mock' ? 'Built-in sample workspace. Sign in with ADMIN_EMAIL and ADMIN_PASSWORD from .env.' : 'Connected to Twenty. Sign in with your Cadence account.');
  log('Close this window or press Ctrl+C to stop.');
  log('====================================================');
  if (!process.env.CADENCE_NO_BROWSER) openBrowser(url);
}

main().catch(async (err) => {
  console.error('[cadence] failed:', err instanceof Error ? err.message : err);
  await shutdown(1);
});
