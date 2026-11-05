import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Flags for every embedded Postgres cluster Cadence creates: the local launcher, `pnpm dev:db` and
 * the test runner. Without them initdb takes the machine's locale, which on Windows is
 * English_United States.1252, so the cluster is WIN1252 and a name outside Latin-1 (Chinese, Greek)
 * fails every write it reaches (B013). Production's postgres image is UTF8 already.
 */
export const UTF8_INITDB_FLAGS = ['--encoding=UTF8', '--locale=C'];

/** Why a database of this encoding cannot be used, or null when it is UTF8. */
export function encodingProblem(encoding: string | null | undefined, databaseDir: string): string | null {
  if ((encoding ?? '').toUpperCase() === 'UTF8') return null;
  return [
    `The local database in ${databaseDir} was created as ${encoding || 'an unknown encoding'}, not UTF8, so names outside Latin-1 would fail to save.`,
    'Stop Cadence and delete that folder (this deletes the local data), or set DEV_DB_DIR to a new folder, then start again: Cadence creates it as UTF8.',
  ].join(' ');
}

type PgClient = { connect(): Promise<unknown>; query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<unknown> };

/** Refuse to go on with a cluster created before the UTF8 flags, rather than fail later on a name. */
export async function assertUtf8Database(pg: { getPgClient(database?: string): PgClient }, database: string, databaseDir: string): Promise<void> {
  const client = pg.getPgClient('postgres');
  await client.connect();
  try {
    const { rows } = await client.query('SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = $1', [database]);
    const problem = encodingProblem(rows.length ? String(rows[0].encoding) : 'UTF8', databaseDir);
    if (problem) throw new Error(problem);
  } finally {
    await client.end();
  }
}

/** The JavaScript entry of each command-line tool the launcher runs. */
export const LOCAL_TOOLS = {
  prisma: path.join('node_modules', 'prisma', 'build', 'index.js'),
  tsx: path.join('node_modules', 'tsx', 'dist', 'cli.mjs'),
  next: path.join('node_modules', 'next', 'dist', 'bin', 'next'),
} as const;

/**
 * Run a tool with this Node and no shell, as the web and worker processes already are. Through a
 * shell (`node_modules/.bin/prisma.cmd` on Windows) an unquoted path is split at its first space, so
 * the launcher failed in any folder such as "Tech Projects" (L001).
 */
export function runTool(root: string, tool: keyof typeof LOCAL_TOOLS, args: string[], env: NodeJS.ProcessEnv, stdio: 'inherit' | 'pipe' = 'inherit') {
  return spawnSync(process.execPath, [path.join(root, LOCAL_TOOLS[tool]), ...args], { stdio, env, shell: false, encoding: 'utf8' });
}

/** Never remove an arbitrary directory or the lock of a database that is still running. */
export function prepareDatabaseDirectory(root: string, configured: string) {
  const workspace = fs.realpathSync(root);
  const databaseDir = path.resolve(workspace, configured);
  const relative = path.relative(workspace, databaseDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(databaseDir) !== workspace) {
    throw new Error('DEV_DB_DIR must name a direct subdirectory of this project.');
  }
  if (fs.existsSync(databaseDir) && fs.lstatSync(databaseDir).isSymbolicLink()) throw new Error('DEV_DB_DIR cannot be a symbolic link.');
  const fresh = !fs.existsSync(path.join(databaseDir, 'PG_VERSION'));
  if (fresh && fs.existsSync(databaseDir)) {
    if (fs.readdirSync(databaseDir).length) throw new Error(`Refusing to replace a non-empty directory: ${databaseDir}`);
    fs.rmdirSync(databaseDir);
  }
  const lock = path.join(databaseDir, 'postmaster.pid');
  if (!fresh && fs.existsSync(lock)) {
    const lines = fs.readFileSync(lock, 'utf8').split(/\r?\n/);
    const pid = Number(lines[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('The database lock is invalid. Check the local Postgres process before restarting.');
    if (livePostgres(pid, lines[1]?.trim(), databaseDir)) {
      throw new Error(`The local database is already running (PID ${pid}). Use the running app or stop that launcher first.`);
    }
    // Left behind by a hard exit. Clearing it is the whole point of the check above.
    fs.rmSync(lock);
  }
  return { databaseDir, fresh };
}

/**
 * Is the process named in the lock really this database?
 *
 * A bare process id is not proof. Windows recycles ids, so a lock left behind by a killed
 * launcher can name a live but unrelated process - and then the launcher refuses to start for
 * good, with nothing the user can do but delete a file they have never heard of. Postgres also
 * records its own data directory on the second line of the lock, so requiring the two to agree
 * rules out a recycled id, and an id we are not allowed to inspect is somebody else's process.
 */
function livePostgres(pid: number, lockedDir: string | undefined, databaseDir: string): boolean {
  if (lockedDir && path.resolve(lockedDir) !== path.resolve(databaseDir)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: the process is gone. EPERM: it is not ours, so it is not this database.
    return false;
  }
}
