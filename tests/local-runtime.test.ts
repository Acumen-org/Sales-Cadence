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
  it('preserves the lock of a running process', () => {
    const root = workspace(); const target = path.join(root, 'db'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'PG_VERSION'), '18'); fs.writeFileSync(path.join(target, 'postmaster.pid'), String(process.pid));
    expect(() => prepareDatabaseDirectory(root, 'db')).toThrow('already running');
    expect(fs.existsSync(path.join(target, 'postmaster.pid'))).toBe(true);
  });
});
