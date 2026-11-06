import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eraseConfirm, optOutConfirm, removeConfirm } from '@/lib/outreach/confirm-words';

/** Every file under src, for the checks that read the code itself. */
function sources(dir = path.join(process.cwd(), 'src')): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
}

describe('ConfirmDialog (cold outreach PLAN 4.0)', () => {
  it('ConfirmDialog: no browser confirm is left anywhere in Cadence', () => {
    const left = sources().filter((f) => /window\.confirm\(|(?<![\w.])confirm\(/.test(fs.readFileSync(f, 'utf8')));
    expect(left.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });

  it('ConfirmDialog, N104: Opt out names the person and every effect (the rep must not email, call or message them), and asks why', () => {
    const c = optOutConfirm({ name: 'Jane Doe', campaigns: ['Q4 Harbor'], nextStep: 'Call on Thu 5 Nov', fromBellwether: true });
    expect(c.title).toBe('Opt Jane Doe out?');
    expect(c.effects).toEqual(['Do not email, call or message Jane Doe again. Cadence blocks calls and campaigns.', 'Q4 Harbor ends.', 'The next step (Call on Thu 5 Nov) is cancelled.', 'Bellwether shows them as Do not contact.']);
    expect(c.reason).toEqual(expect.objectContaining({ required: true }));
    expect(c.tone).toBe('danger');
  });

  it('ConfirmDialog: Remove asks a reason, for one contact or many; Erase says how it differs from Remove', () => {
    expect(removeConfirm({ name: 'Jane Doe', campaigns: ['A', 'B'] }).effects).toContain('2 campaigns (A, B) end.');
    expect(removeConfirm(3)).toEqual(expect.objectContaining({ title: 'Remove 3 contacts from Cold outreach?', reason: expect.objectContaining({ required: true }) }));
    expect(eraseConfirm({ name: 'Jane Doe' }).effects?.join(' ')).toMatch(/Unlike Remove/);
  });

  it('ConfirmDialog: no copy says sandbox or Twenty', () => {
    const all = [optOutConfirm({ name: 'J', inCrm: true, fromBellwether: true }), removeConfirm({ name: 'J', fromBellwether: true }), removeConfirm(2), eraseConfirm({ name: 'J' })];
    expect(JSON.stringify(all)).not.toMatch(/sandbox|twenty/i);
  });
});
