import fs from 'node:fs';
import path from 'node:path';

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
