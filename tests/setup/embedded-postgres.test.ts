import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('embedded database test runner exit handling', () => {
  it.each([0, 17])('preserves exit code %i and pre-existing exit listeners', (code) => {
    const loader = pathToFileURL(path.resolve('tests/setup/embedded-postgres.ts')).href;
    const script = `
      process.on('exit', code => process.stdout.write('preserved:' + code));
      import(${JSON.stringify(loader)}).then(async module => {
        const load = module.loadTestPostgres ?? module.default.loadTestPostgres;
        await load();
        process.exitCode = ${code};
      });
    `;
    // Importing the driver is sufficient to exercise its exit hooks; no cluster is started.
    const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], { encoding: 'utf8', timeout: 20000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(code);
    expect(result.stdout).toBe(`preserved:${code}`);
    expect(result.stderr).toBe('');
  });
});
