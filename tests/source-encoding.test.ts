import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Text that was read in the wrong encoding and saved again turns "👏" into "ðŸ‘" and "–" into "â€“"
 * (22 Nov 2026: the bell's cheer line shipped that way). No source file may carry those marks.
 */
const BROKEN = /ðŸ|â€|Ã©|Ã¨|Â·|Â /;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|css|md)$/.test(name) ? [path] : [];
  });
}

describe('source text', () => {
  it('has no characters garbled by a wrong encoding', () => {
    const bad = files('src').filter((f) => BROKEN.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
