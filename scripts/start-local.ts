import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

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
const databaseUrl = `postgresql://postgres:postgres@localhost:${dbPort}/cadence`;
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
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
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
  const databaseDir = path.resolve(root, process.env.DEV_DB_DIR ?? '.pgdata-dev');
  const fresh = !fs.existsSync(path.join(databaseDir, 'PG_VERSION'));
  if (!fresh) fs.rmSync(path.join(databaseDir, 'postmaster.pid'), { force: true }); // stale lock from a hard exit
  const mod = await import('embedded-postgres');
  const EmbeddedPostgres = (mod.default ?? mod) as unknown as new (opts: Record<string, unknown>) => { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; createDatabase(n: string): Promise<void> };
  const instance = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'postgres', port: dbPort, persistent: true, onLog: () => {} });
  log(fresh ? 'creating the local database...' : 'starting the local database...');
  if (fresh) {
    fs.rmSync(databaseDir, { recursive: true, force: true });
    await instance.initialise();
  }
  await instance.start();
  pg = instance;
  if (fresh) await instance.createDatabase('cadence');

  // 2. schema + seed
  run(bin('prisma'), ['migrate', 'deploy'], env, 'applying migrations');
  run(bin('tsx'), ['prisma/seed.ts'], env, 'seeding (default sequence, admin, demo pods, users, people)');

  // 3. build if needed
  if (!fs.existsSync(path.join(root, '.next', 'BUILD_ID'))) run(bin('next'), ['build'], env, 'building the app (first run only, a minute or two)');

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
  const worker = spawn(process.execPath, [tsxBin, 'src/worker/index.ts'], { stdio: 'inherit', env });
  children.push(worker);

  await waitForHttp(`http://localhost:${port}/api/health`, 120_000);
  const url = `http://localhost:${port}/login`;
  console.log('');
  log('====================================================');
  log(`Cadence is running: ${url}`);
  log('Mock Twenty workspace: 3 pods, 6 FOs, 40 people.');
  log('Use the one-click buttons on the login page, or admin@cadence.local / admin12345.');
  log('Close this window or press Ctrl+C to stop.');
  log('====================================================');
  if (!process.env.CADENCE_NO_BROWSER) openBrowser(url);
}

main().catch(async (err) => {
  console.error('[cadence] failed:', err instanceof Error ? err.message : err);
  await shutdown(1);
});
