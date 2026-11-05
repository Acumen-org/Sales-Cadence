import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodingProblem, LOCAL_TOOLS, prepareDatabaseDirectory, runTool, UTF8_INITDB_FLAGS } from '../scripts/local-runtime';

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

describe('L001: the launcher runs its tools without a shell', () => {
  it('runs a tool from a folder whose path holds spaces', () => {
    const root = path.join(workspace(), 'Tech Projects', 'Seq uencer');
    const entry = path.join(root, LOCAL_TOOLS.prisma);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const r = runTool(root, 'prisma', ['migrate', 'deploy'], process.env, 'pipe');
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(JSON.parse(String(r.stdout))).toEqual(['migrate', 'deploy']);
  });

  it('finds every tool in this checkout', () => {
    for (const entry of Object.values(LOCAL_TOOLS)) expect(fs.existsSync(path.join(process.cwd(), entry))).toBe(true);
    const r = runTool(process.cwd(), 'prisma', ['--version'], process.env, 'pipe');
    expect(r.status).toBe(0);
  });
});

describe('B013: local and test databases are UTF8', () => {
  it('creates every cluster as UTF8 whatever the machine locale', () => {
    expect(UTF8_INITDB_FLAGS).toEqual(expect.arrayContaining(['--encoding=UTF8']));
  });

  it('refuses a cluster made before, in the Windows code page, and says what to do', () => {
    expect(encodingProblem('UTF8', '.pgdata-dev')).toBeNull();
    const problem = encodingProblem('WIN1252', 'C:\Cadence\.pgdata-dev');
    expect(problem).toContain('created as WIN1252, not UTF8');
    expect(problem).toContain('delete that folder');
  });
});
