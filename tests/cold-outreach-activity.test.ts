import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { logAudit, SYSTEM_ACTOR, userActor } from '@/lib/audit';
import { describeAudit } from '@/lib/audit-format';
import { listActivity } from '@/lib/activity-query';
import { CLEARED_ACTION, FLAGGED_ACTION } from '@/lib/sandbox/crm-check';
import { DRY_RUN_ACTION, KEPT_ACTION, REMOVED_ACTION } from '@/lib/sandbox/crm-cleanup';
import { EMAIL_TO_DO_NOT_CONTACT } from '@/lib/mail/cold-email';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * S8 (cold outreach PLAN 6, W9): the Activity page is one feed of CRM and cold work, with a "Cold
 * outreach" chip and a CRM / Cold / All filter (N005), and every audit action reads in plain words.
 */

const session = (u: { id: string; email: string; name: string; role: Role; timezone: string; twentyMemberId: string | null; dailyCap: number | null }, podIds: string[]): SessionUser => ({ id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds, pods: podIds.map((id) => ({ id, name: id })) });

/** Every action name Cadence writes to the audit log: each logAudit call, each direct insert, each migration. */
function auditActions(): Set<string> {
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const constants: Record<string, string> = { FLAGGED_ACTION, CLEARED_ACTION, KEPT_ACTION, DRY_RUN_ACTION, REMOVED_ACTION, EMAIL_TO_DO_NOT_CONTACT };
  const found = new Set<string>();
  for (const file of files(path.join(process.cwd(), 'src'))) {
    const s = fs.readFileSync(file, 'utf8');
    for (const start of ['logAudit(', 'auditLog.create(']) {
      let i = 0;
      while ((i = s.indexOf(start, i)) >= 0) {
        let depth = 0, j = i + start.length - 1;
        for (; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')' && --depth === 0) break; }
        const call = s.slice(i, j + 1);
        const expr = /action:\s*([^,}\n]+(?:\?[^,}\n]+)?)/.exec(call)?.[1] ?? '';
        // A ternary's test (x === 'move') is not an action; its answers are.
        for (const m of expr.matchAll(/(?<!=== )'([a-z_]+)'/g)) found.add(m[1]);
        for (const [name, value] of Object.entries(constants)) if (expr.includes(name)) found.add(value);
        i = j;
      }
    }
  }
  // Actions passed in a variable: a transfer's kind, a possible bounce settled, a campaign re-planned.
  for (const a of ['claimed', 'assigned', 'released', 'reassigned', 'possible_bounce_cleared', 'possible_bounce_confirmed', 'people_added', 'people_removed', 'stopped']) found.add(a);
  const migrations = path.join(process.cwd(), 'prisma/migrations');
  for (const dir of fs.readdirSync(migrations)) {
    const file = path.join(migrations, dir, 'migration.sql');
    if (fs.existsSync(file)) for (const m of fs.readFileSync(file, 'utf8').matchAll(/'([a-z_]+)',\s*'(?:SYSTEM|WORKER|USER)'/g)) found.add(m[1]);
  }
  found.delete('none');
  return found;
}

describe('Activity: one feed, every action in plain words', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('every audit action Cadence writes, the earlier stages\' included, has words of its own', () => {
    const actions = auditActions();
    // The stages' new actions are found, so the scan is reading what it should.
    for (const a of ['approval_removed', 'email_counted_once', 'bellwether_do_not_contact', 'next_action_auto_closed', 'sandbox_moved', 'move_undone', 'opt_out_lifted', 'call_discarded', 'raised', 'reply_counted_once', 'caller_number_released']) expect(actions).toContain(a);
    expect([...actions].filter((a) => !describeAudit(a, {}, null).known)).toEqual([]);
    // Plain words, never the stored name.
    expect(describeAudit('approval_removed', {}, null, 'campaign').title).toBe('Back to draft: cold campaigns need no approval');
    expect(describeAudit('removed', { by: 'retention' }, null, 'sandbox_contact').title).toBe('Removed by retention: no activity for a long time');
    expect(describeAudit('opted_out', { source: 'call_form' }, 'Karson', 'sandbox_contact')).toEqual(expect.objectContaining({ title: 'Opted out by Karson', fields: [{ label: 'From', value: 'the post-call form' }] }));
    expect(describeAudit('closed', { outcome: 'lifted' }, null, 'ticket').fields).toEqual([{ label: 'Opt-out', value: 'Lifted' }]);
    // The UI never says Twenty.
    for (const [action, d] of [['exited', { reason: 'dnd' }], ['exited', { reason: 'person_deleted' }], ['meeting', { evidenceId: 'opportunity:1' }], ['completed', { source: 'OBSERVED_NOTE', evidenceId: 'note:1' }]] as const) expect(JSON.stringify(describeAudit(action, d, null))).not.toContain('Twenty');
  });

  it('N036: a step closed by Outlook reads "seen in Outlook sent items"; one closed from the CRM, "seen in the CRM"', () => {
    expect(describeAudit('completed', { source: 'OBSERVED_MESSAGE', evidenceId: 'graph:<a@x>:sbx:1', chosenAction: 'EMAIL' }, null).title).toBe('Step done: seen in Outlook sent items');
    expect(describeAudit('completed', { source: 'OBSERVED_MESSAGE', evidenceId: 'message:abc' }, null).title).toBe('Step done: seen in the CRM');
    expect(describeAudit('next_action_auto_closed', { evidence: 'graph:<b@x>:sbx:2', label: 'Email' }, null).title).toBe('Task done: the email was seen in Outlook sent items');
  });

  it('N005: cold work is in the feed, with its own pages and a Cold outreach mark, and the filter splits CRM from Cold', async () => {
    const admin = session(b.users.ria, []);
    const at = new Date();
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Cora', lastName: 'Cold' });
    const other = await readyContact(b.users.leigh.id, b.pods.Leigh.id, { firstName: 'Leo', lastName: 'Leigh' });
    await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: 'claimed', actor: userActor(b.users.alisa) });
    await logAudit({ entityType: 'sandbox_contact', entityId: other.id, action: 'pushed', actor: SYSTEM_ACTOR });
    const call = await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', statusRank: 4, userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: at, audience: 'SANDBOX', podId: b.pods.Alisa.id } });
    await logAudit({ entityType: 'call', entityId: call.id, action: 'call_form_submitted', actor: userActor(b.users.alisa), details: { outcome: 'connected' } });
    await prisma.touch.create({ data: { sandboxContactId: c.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: at, summary: 'Reply: Re: Idea', externalId: 'act:cold', audience: 'SANDBOX' } });
    const crm = await prisma.touch.create({ data: { personId: 'person-01', channel: 'EMAIL', direction: 'OUTBOUND', occurredAt: at, summary: 'Email sent: Hello', externalId: 'act:crm', audience: 'CRM' } });
    // The CRM's copy of a cold email is not a second event.
    await prisma.touch.create({ data: { personId: 'person-02', channel: 'EMAIL', direction: 'INBOUND', occurredAt: at, summary: 'Reply: Re: Idea (copy)', externalId: 'act:copy', audience: 'CRM', copyOfTouchId: crm.id } });
    await logAudit({ entityType: 'person', entityId: 'person-01', action: 'opted_out', actor: userActor(b.users.alisa), details: { source: 'person_page' } });

    const all = (await listActivity({ viewer: admin })).items;
    const titles = all.map((i) => i.title);
    expect(titles).toEqual(expect.arrayContaining(['Claimed', 'Sent from Bellwether', 'Call form filled in', 'Reply: Re: Idea', 'Email sent: Hello', 'Opted out']));
    expect(titles).not.toContain('Reply: Re: Idea (copy)');
    const claim = all.find((i) => i.title === 'Claimed')!;
    expect(claim).toEqual(expect.objectContaining({ kind: 'contact', audience: 'cold', subjectName: 'Cora Cold' }));
    expect(claim.subjectHref).not.toMatch(/^\/people\//);
    expect(all.find((i) => i.title === 'Call form filled in')).toEqual(expect.objectContaining({ kind: 'call', audience: 'cold', subjectName: 'Cora Cold' }));

    const cold = (await listActivity({ viewer: admin, audience: 'cold' })).items;
    expect(cold.every((i) => i.audience === 'cold')).toBe(true);
    expect(cold.map((i) => i.title)).toEqual(expect.arrayContaining(['Claimed', 'Call form filled in', 'Reply: Re: Idea']));
    const crmOnly = (await listActivity({ viewer: admin, audience: 'crm' })).items;
    expect(crmOnly.map((i) => i.title).sort()).toEqual(['Email sent: Hello', 'Opted out']);

    // Scoped by the contact's pod: Leigh's pod sees Leo's push, not Cora.
    const leighs = (await listActivity({ viewer: session(b.users.leigh, [b.pods.Leigh.id]), podId: b.pods.Leigh.id })).items.map((i) => i.subjectName);
    expect(leighs).toContain('Leo Leigh');
    expect(leighs).not.toContain('Cora Cold');
  });
});
