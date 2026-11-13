import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { buildReports, reportingRange } from '@/lib/reports-query';
import { processPendingEvents, storeEvents } from '@/lib/linkedin/events';
import { ReportDocument } from '@/components/reports/report-document';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * Reports' LinkedIn figures (reports-linkedin.ts), fed through the Console's own event pipeline:
 * requests sent (a request seen twice counts once, a resend after a withdrawal counts again),
 * accepted of our own requests, the acceptance rate, messages sent, replies (the LinkedIn part of
 * Replies, never added twice) and LinkedIn tasks open and overdue, per rep and audience.
 */

// Friday 6 Nov 2026, midday in Chicago. The week is Mon 2 to Sun 8 Nov.
const NOW = new Date('2026-11-06T18:00:00Z');
const TODAY = '2026-11-06';
const WEEK = reportingRange('2026-11-02', '2026-11-08', TODAY);

let b: Basics;
let seq = 0;
const session = (u: { id: string; email: string; name: string; role: Role; timezone: string; twentyMemberId: string | null; dailyCap: number | null }, podIds: string[]): SessionUser => ({ id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds, pods: podIds.map((id) => ({ id, name: id })) });

function ev(type: string, at: string, publicId: string, who: 'alisa' | 'leigh', data: Record<string, unknown> = {}) {
  return {
    seq: ++seq, type, at: new Date(at).toISOString(),
    account: { id: `acc-${who}`, linkedinName: who === 'alisa' ? 'Alisa Account' : 'Leigh Account' },
    user: { email: `${who}@cadence.local`, name: who },
    person: { memberUrn: `urn:li:fsd_profile:${publicId}`, publicId, profileUrl: `https://www.linkedin.com/in/${publicId}/`, name: publicId },
    data,
  };
}

async function crmPerson(id: string, publicId: string, owner: string | null) {
  await prisma.personCache.update({ where: { id }, data: { linkedinUrl: `https://www.linkedin.com/in/${publicId}`, linkedinKey: `linkedin.com/in/${publicId}`, ownerMemberId: owner, dnd: false, optedOut: false } });
}

async function seedWeek() {
  await crmPerson('person-01', 'jane-crm', b.users.alisa.twentyMemberId);
  await crmPerson('person-02', 'bob-crm', b.users.alisa.twentyMemberId);
  await crmPerson('person-03', 'old-crm', b.users.alisa.twentyMemberId);
  await crmPerson('person-04', 'asked-us', b.users.alisa.twentyMemberId);
  const sam = await readyContact(b.users.leigh.id, b.pods.Leigh.id, { linkedinUrl: 'linkedin.com/in/sam-cold' });
  await storeEvents([
    // The week before: not this period's.
    ev('invitation.sent', '2026-10-27T15:00:00Z', 'old-crm', 'alisa'),
    // Alisa to Jane (CRM): the click, then the Sent list: one request. Accepted, messaged, replied.
    ev('invitation.sent', '2026-11-03T15:00:00Z', 'jane-crm', 'alisa'),
    ev('invitation.sent', '2026-11-03T15:05:00Z', 'jane-crm', 'alisa'),
    // Leigh to Sam (cold): sent, withdrawn, sent again: two requests, the second accepted.
    ev('invitation.sent', '2026-11-03T16:00:00Z', 'sam-cold', 'leigh'),
    ev('connection.accepted', '2026-11-04T14:00:00Z', 'jane-crm', 'alisa', { invitedByUs: true }),
    ev('invitation.sent', '2026-11-04T15:00:00Z', 'bob-crm', 'alisa'),
    ev('invitation.withdrawn', '2026-11-04T16:00:00Z', 'sam-cold', 'leigh'),
    // They asked us: an acceptance that is not of our request.
    ev('connection.accepted', '2026-11-04T17:00:00Z', 'asked-us', 'alisa', { invitedByUs: false }),
    ev('message.sent', '2026-11-05T14:00:00Z', 'jane-crm', 'alisa'),
    ev('invitation.sent', '2026-11-05T15:00:00Z', 'sam-cold', 'leigh'),
    ev('message.received', '2026-11-05T18:00:00Z', 'jane-crm', 'alisa'),
    ev('connection.accepted', '2026-11-06T14:00:00Z', 'sam-cold', 'leigh', { invitedByUs: true }),
    ev('message.received', '2026-11-06T15:00:00Z', 'sam-cold', 'leigh'),
  ], 'test');
  await processPendingEvents(new Date());

  // LinkedIn tasks as they stand now: made here, so the figures do not hang on the follow-up rules.
  await prisma.linkedInFollowUp.deleteMany({});
  const jane = await prisma.linkedInLink.findFirstOrThrow({ where: { profileKey: 'linkedin.com/in/jane-crm' } });
  const samLink = await prisma.linkedInLink.findFirstOrThrow({ where: { profileKey: 'linkedin.com/in/sam-cold' } });
  const bob = await prisma.linkedInLink.findFirstOrThrow({ where: { profileKey: 'linkedin.com/in/bob-crm' } });
  await prisma.linkedInFollowUp.createMany({ data: [
    { kind: 'MESSAGE', trigger: 'replied', triggeredAt: new Date('2026-11-05T18:00:00Z'), linkId: jane.id, accountId: jane.accountId, personId: 'person-01', foUserId: b.users.alisa.id, dueDate: '2026-11-04', audience: 'CRM' },
    { kind: 'WITHDRAW', trigger: 'pending', triggeredAt: new Date('2026-11-05T18:00:00Z'), linkId: bob.id, accountId: bob.accountId, personId: 'person-02', foUserId: b.users.alisa.id, dueDate: '2026-11-09', audience: 'CRM' },
    { kind: 'MESSAGE', trigger: 'accepted', triggeredAt: new Date('2026-11-06T14:00:00Z'), linkId: samLink.id, accountId: samLink.accountId, sandboxContactId: sam.id, foUserId: b.users.leigh.id, dueDate: '2026-11-05', audience: 'SANDBOX' },
    // Done: not open.
    { kind: 'MESSAGE', trigger: 'accepted', triggeredAt: new Date('2026-11-04T14:00:00Z'), linkId: jane.id, accountId: jane.accountId, personId: 'person-01', foUserId: b.users.alisa.id, dueDate: '2026-11-04', audience: 'CRM', state: 'DONE', completedAt: new Date('2026-11-05T14:00:00Z') },
  ] });
  return sam;
}

beforeEach(async () => {
  await resetDb();
  b = await seedBasics();
  seq = 0;
});

describe('Reports: LinkedIn', () => {
  it('counts requests, acceptances, messages, replies and open tasks per rep and in total', async () => {
    await seedWeek();
    const admin = session(b.users.ria, []);
    const r = await buildReports(admin, TODAY, { range: WEEK, audience: 'all' }, NOW);
    const li = r.linkedin;
    expect(li.totals).toEqual({ requests: 4, accepted: 2, acceptanceRate: 0.5, messages: 1, replies: 2, open: 3, overdue: 2 });
    const alisa = li.byRep.find((x) => x.key === b.users.alisa.id)!;
    const leigh = li.byRep.find((x) => x.key === b.users.leigh.id)!;
    expect(alisa).toMatchObject({ requests: 2, accepted: 1, acceptanceRate: 0.5, messages: 1, replies: 1, open: 2, overdue: 1 });
    expect(leigh).toMatchObject({ requests: 2, accepted: 1, acceptanceRate: 0.5, messages: 0, replies: 1, open: 1, overdue: 1 });

    // Per rep adds up to the total.
    for (const k of ['requests', 'accepted', 'messages', 'replies', 'open', 'overdue'] as const) expect(li.byRep.reduce((n, x) => n + x[k], 0)).toBe(li.totals[k]);

    // LinkedIn replies are part of Replies, not added to them; requests and messages are not Sent.
    expect(r.totals.replies).toBe(2);
    expect(r.totals.sent).toBe(0);
    expect(r.totals.linkedin).toBe(0);
    expect(r.parts.crm.replies + r.parts.cold.replies).toBe(r.totals.replies);
  });

  it('splits by audience: All outreach is CRM plus Cold outreach', async () => {
    await seedWeek();
    const admin = session(b.users.ria, []);
    const [all, crm, cold] = await Promise.all((['all', 'crm', 'cold'] as const).map((audience) => buildReports(admin, TODAY, { range: WEEK, audience }, NOW)));
    expect(crm.linkedin.totals).toEqual({ requests: 2, accepted: 1, acceptanceRate: 0.5, messages: 1, replies: 1, open: 2, overdue: 1 });
    expect(cold.linkedin.totals).toEqual({ requests: 2, accepted: 1, acceptanceRate: 0.5, messages: 0, replies: 1, open: 1, overdue: 1 });
    for (const k of ['requests', 'accepted', 'messages', 'replies', 'open', 'overdue'] as const) expect(crm.linkedin.totals[k] + cold.linkedin.totals[k]).toBe(all.linkedin.totals[k]);
    // Replies agree with the main Replies figure in each audience.
    expect(crm.linkedin.totals.replies).toBe(crm.totals.replies);
    expect(cold.linkedin.totals.replies).toBe(cold.totals.replies);
    expect(cold.linkedin.byRep.map((x) => x.key)).toEqual([b.users.leigh.id]);
  });

  it('follows the pod and FO filters, and the period', async () => {
    await seedWeek();
    const admin = session(b.users.ria, []);
    const leighOnly = await buildReports(admin, TODAY, { range: WEEK, audience: 'all', foUserId: b.users.leigh.id }, NOW);
    expect(leighOnly.linkedin.totals).toMatchObject({ requests: 2, accepted: 1, messages: 0, replies: 1, open: 1 });
    const alisaPod = await buildReports(admin, TODAY, { range: WEEK, audience: 'all', podId: b.pods.Alisa.id }, NOW);
    expect(alisaPod.linkedin.totals).toMatchObject({ requests: 2, accepted: 1, messages: 1, replies: 1, open: 2 });
    expect(alisaPod.linkedin.byRep.map((x) => x.key)).toEqual([b.users.alisa.id]);
    // The week before holds only the old request to person-03, not accepted.
    const before = await buildReports(admin, TODAY, { range: reportingRange('2026-10-26', '2026-11-01', TODAY), audience: 'all' }, NOW);
    expect(before.linkedin.totals).toMatchObject({ requests: 1, accepted: 0, acceptanceRate: 0, messages: 0, replies: 0 });
    // A junior reads their own work only.
    const karson = await buildReports(session(b.users.karson, [b.pods.Alisa.id]), TODAY, { range: WEEK, audience: 'all' }, NOW);
    expect(karson.linkedin.totals).toMatchObject({ requests: 0, messages: 0, replies: 0, open: 0 });
  });

  it('shows the LinkedIn table on the report and in the export', async () => {
    await seedWeek();
    const admin = session(b.users.ria, []);
    const r = await buildReports(admin, TODAY, { range: WEEK, audience: 'all' }, NOW);
    const html = renderToStaticMarkup(createElement(ReportDocument, { reports: r, previous: null, range: { from: WEEK.from, to: WEEK.to }, scope: 'All outreach', campaigns: [] }));
    expect(html).toContain('LinkedIn');
    expect(html).toContain('Requests sent');
    expect(html).toContain('Acceptance rate');
    expect(html).toContain('Open tasks');
    expect(html).toContain('50%');
  });
});
