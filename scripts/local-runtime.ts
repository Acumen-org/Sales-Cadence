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
    const pid = Number(fs.readFileSync(lock, 'utf8').split(/\r?\n/)[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('The database lock is invalid. Check the local Postgres process before restarting.');
    let running = true;
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') running = false; }
    if (running) throw new Error(`The local database is already running (PID ${pid}). Use the running app or stop that launcher first.`);
    fs.rmSync(lock);
  }
  return { databaseDir, fresh };
}
