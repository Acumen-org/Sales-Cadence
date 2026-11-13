import { describe, expect, it } from 'vitest';
import { runTool } from '../scripts/local-runtime';

/**
 * T34: a database built by the migrations is what schema.prisma describes (columns, types, indexes,
 * keys). Prisma does not compare the hand-written partial unique indexes, which live only in the
 * migrations (see the note above Enrollment in schema.prisma).
 */
describe('T34: schema.prisma and the migrations agree', () => {
  it('finds nothing to change between the migrated test database and schema.prisma', () => {
    const out = runTool(process.cwd(), 'prisma', ['migrate', 'diff', '--from-url', process.env.DATABASE_URL!, '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { ...process.env }, 'pipe');
    expect(out.status, out.stderr).toBe(0);
    const statements = out.stdout.split('\n').filter((line) => line.trim() && !line.trim().startsWith('--'));
    expect(statements).toEqual([]);
  });
});
