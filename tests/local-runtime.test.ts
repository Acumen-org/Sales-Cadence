import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareDatabaseDirectory } from '../scripts/local-runtime';

const roots: string[] = [];
const workspace = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-runtime-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('local database startup', () => {
  it('refuses paths outside the workspace and the workspace itself', () => {
    const root = workspace();
    for (const value of ['.', '..', '../elsewhere', path.parse(root).root]) expect(() => prepareDatabaseDirectory(root, value)).toThrow('direct subdirectory');
  });
  it('preserves nonempty directories that are not databases', () => {
    const root = workspace(); const target = path.join(root, 'data'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'important.txt'), 'keep');
    expect(() => prepareDatabaseDirectory(root, 'data')).toThrow('non-empty');
    expect(fs.readFileSync(path.join(target, 'important.txt'), 'utf8')).toBe('keep');
  });
  it('preserves the lock of a database that really is running', () => {
    const root = workspace(); const target = path.join(root, 'db'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'PG_VERSION'), '18');
    fs.writeFileSync(path.join(target, 'postmaster.pid'), `${process.pid}
${target}
`);
    expect(() => prepareDatabaseDirectory(root, 'db')).toThrow('already running');
    expect(fs.existsSync(path.join(target, 'postmaster.pid'))).toBe(true);
  });

  it('clears a lock left by a hard exit instead of refusing to start for ever', () => {
    const root = workspace(); const target = path.join(root, 'db'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'PG_VERSION'), '18');
    // A process id that no longer exists: the launcher must recover on its own.
    fs.writeFileSync(path.join(target, 'postmaster.pid'), `4294967
${target}
`);
    expect(prepareDatabaseDirectory(root, 'db')).toEqual({ databaseDir: fs.realpathSync(target), fresh: false });
    expect(fs.existsSync(path.join(target, 'postmaster.pid'))).toBe(false);
  });

  it('treats a recycled process id as stale, because the lock names another directory', () => {
    const root = workspace(); const target = path.join(root, 'db'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'PG_VERSION'), '18');
    // This process is alive, but it is not the database that wrote this lock.
    fs.writeFileSync(path.join(target, 'postmaster.pid'), `${process.pid}
${path.join(root, 'some-other-db')}
`);
    expect(() => prepareDatabaseDirectory(root, 'db')).not.toThrow();
    expect(fs.existsSync(path.join(target, 'postmaster.pid'))).toBe(false);
  });
});
