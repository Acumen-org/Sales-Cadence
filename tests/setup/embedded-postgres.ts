/**
 * embedded-postgres installs async-exit-hook, whose beforeExit handler always
 * calls process.exit(0). That masks Vitest's nonzero exitCode after failed tests.
 * Vitest explicitly stops this database in teardown; preserve its own exit code
 * by removing only the natural-exit handlers added by this import. Its exit
 * handler also invokes asynchronous cleanup without a callback. Signal cleanup
 * and handlers belonging to Vitest or other packages remain intact.
 */
export async function loadTestPostgres() {
  const beforeExit = new Set(process.listeners('beforeExit'));
  const exit = new Set(process.listeners('exit'));
  const mod = await import('embedded-postgres');
  for (const listener of process.listeners('beforeExit')) {
    if (!beforeExit.has(listener)) process.removeListener('beforeExit', listener);
  }
  for (const listener of process.listeners('exit')) {
    if (!exit.has(listener)) process.removeListener('exit', listener);
  }
  return mod.default ?? mod;
}
