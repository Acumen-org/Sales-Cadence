import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T07: a roll-back (auto_revert) swaps the image, not the schema, so the previous release must run on
 * the new tables. Every migration from here on is additive (DEPLOY.md, "Writing a migration"): no
 * dropped or renamed table or column, no changed column type, no NOT NULL on an existing column and
 * no new NOT NULL column without a default. Removing something is a later release's step, once no
 * running image reads it, and is marked in its file with a line `-- contract: <why it is safe now>`.
 */
const FIRST_CHECKED = '20261113000000';
const RULES: [RegExp, string][] = [
  [/\bDROP\s+(TABLE|COLUMN)\b/i, 'drops a table or column'],
  [/\bRENAME\b/i, 'renames something'],
  [/\bALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i, 'changes a column type'],
  [/\bSET\s+NOT\s+NULL\b/i, 'makes an existing column NOT NULL'],
  [/\bADD\s+COLUMN\b(?![^;]*\bDEFAULT\b)[^;]*\bNOT\s+NULL\b/i, 'adds a NOT NULL column without a default'],
];

describe('T07: migrations stay additive, so the previous release still runs', () => {
  const dir = path.join(process.cwd(), 'prisma', 'migrations');
  const checked = fs.readdirSync(dir).filter((name) => name >= FIRST_CHECKED && fs.existsSync(path.join(dir, name, 'migration.sql')));

  it('has migrations to check', () => {
    expect(checked.length).toBeGreaterThan(0);
  });

  it.each(checked)('%s is additive', (name) => {
    const sql = fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8');
    if (/^--\s*contract:/im.test(sql)) return;
    const code = sql.replace(/--.*$/gm, '');
    const broken = RULES.filter(([rule]) => rule.test(code)).map(([, why]) => why);
    expect(broken).toEqual([]);
  });

  it('catches a destructive statement', () => {
    const code = 'ALTER TABLE "Campaign" DROP COLUMN "window"; ALTER TABLE "Task" ADD COLUMN "x" TEXT NOT NULL;';
    expect(RULES.filter(([rule]) => rule.test(code)).map(([, why]) => why)).toEqual(['drops a table or column', 'adds a NOT NULL column without a default']);
    expect(RULES.some(([rule]) => rule.test('ALTER TABLE "Task" ADD COLUMN "x" INTEGER NOT NULL DEFAULT 0;'))).toBe(false);
  });
});
