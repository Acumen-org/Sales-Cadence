import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { buildHome, type TeamRow } from '@/lib/home-query';
import { logManualCall } from '@/lib/calls/form';
import { dialsByRep, meetingsByRep, meetingsBooked, meetingsHeld, outreachMetrics, replyCount, repliesByRep, type Period } from '@/lib/outreach/metrics';
import { markCrmCopiesOf, recordColdReply, recordColdSent, type SeenMail } from '@/lib/mail/cold-email';
import { ingestEvent } from '@/lib/engine/ingest';
import { rawFromMessage } from '@/lib/engine/reconcile';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';
import { REPORT_DOCUMENT_STYLES } from '@/lib/report-export-styles';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
const { TeamBoard, TEAM_BOARD_WIDTHS } = await import('@/components/home/team-board');

/**
 * S6 (cold outreach PLAN 5, W6): Home shows CRM and cold work together with no distinction, and its
 * figures come from the shared metrics module, so Home and Reports agree. Then the one-email rule
 * the shared metrics now follow (PLAN 6 rule 2, 8.14). Each test is named after its bug.
 */

// Wednesday 4 Nov 2026, midday in London: the week is Mon 2 to Sun 8 Nov.
const NOW = new Date('2026-11-04T12:00:00Z');
const TODAY = '2026-11-04';
const session = (u: { id: string; email: string; name: string; role: Role; timezone: string; twentyMemberId: string | null; dailyCap: number | null }, podIds: string[]): SessionUser => ({ id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds, pods: podIds.map((id) => ({ id, name: id })) });

describe('Home: CRM and cold work together', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });
  const alisa = () => session(b.users.alisa, [b.pods.Alisa.id]);

  async function coldStep(ownerId: string, podId: string, dueDate = TODAY, action: 'EMAIL' | 'CALL' = 'EMAIL') {
    const contact = await readyContact(ownerId, podId, { firstName: 'Jane', lastName: `Cold${Math.floor(Math.random() * 1e6)}` });
    const enrollment = await prisma.enrollment.create({ data: { sandboxContactId: contact.id, foUserId: ownerId, podId, sequenceId: b.sequence.id, startDate: '2026-11-02', audience: 'SANDBOX', currentStep: 0 } });
    const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId: ownerId, stepIndex: 0, stepId: 'step-d1', stepDay: 1, actionIndex: 0, actionId: action === 'EMAIL' ? 'act-email-1' : 'act-call-1', action, label: action === 'EMAIL' ? 'Email 1' : 'Call 1', dueDate, dueAt: new Date(`${dueDate}T09:00:00Z`), plannedDate: dueDate } });
    return { contact, enrollment, task };
  }
  async function crmStep(personId: string, foUserId: string, dueDate = TODAY) {
    const enrollment = await prisma.enrollment.create({ data: { personId, foUserId, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-02', audience: 'CRM', currentStep: 0 } });
    return prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId, stepIndex: 0, stepId: 'step-d1', stepDay: 1, actionIndex: 0, actionId: 'act-email-1', action: 'EMAIL', label: 'Email 1', dueDate, dueAt: new Date(`${dueDate}T09:00:00Z`), plannedDate: dueDate } });
  }

  it('B031: Home counts cold work with CRM work: tiles, channel strip, Up next, the board and My people', async () => {
    const cold = await coldStep(b.users.alisa.id, b.pods.Alisa.id);
    const other = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.nextAction.create({ data: { sandboxContactId: other.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: TODAY, audience: 'SANDBOX' } });
    await crmStep('person-01', b.users.alisa.id);
    const home = await buildHome(alisa(), NOW);
    expect(home.my.todayTotal).toBe(3);
    expect(home.my.today).toEqual({ EMAIL: 2, CALL: 1, LINKEDIN: 0 });
    expect(home.my.peopleToReachToday).toBe(3);
    // Up next merges both kinds, with no tag: a name, what to do, and the firm.
    expect(home.my.nextTasks.map((t) => t.name)).toEqual(expect.arrayContaining([`${cold.contact.firstName} ${cold.contact.lastName}`, `${other.firstName} ${other.lastName}`, 'Nina Halvorsen']));
    expect(home.team.find((r) => r.id === b.users.alisa.id)?.today).toBe(3);
    // D2: "My people" counts the live cold contacts owned too; "My accounts" stays CRM-only.
    expect(home.my.coldContacts).toBe(2);
    expect(home.my.people).toBe(home.my.relationships + 2);
    await prisma.sandboxContact.update({ where: { id: other.id }, data: { status: 'OPTED_OUT' } });
    expect((await buildHome(alisa(), NOW)).my.coldContacts).toBe(1);
  });

  it('B032: nobody is named for having nothing this week: a rep with no work has no row, and there is no idle line', async () => {
    await crmStep('person-01', b.users.alisa.id);
    const home = await buildHome(session(b.users.ria, []), NOW);
    expect(home.team.map((r) => r.id)).toEqual([b.users.alisa.id]);
    const html = renderToStaticMarkup(createElement(TeamBoard, { rows: home.team, week: { from: home.week.from, to: home.week.to }, title: 'The team this week', now: NOW }));
    expect(html).not.toContain('Nothing this week');
    expect(html).not.toContain('Karson');
  });

  it('B094: "All tasks" opens the tab the panel shows, the team\'s when it lists the team\'s', async () => {
    await coldStep(b.users.karson.id, b.pods.Alisa.id, '2026-11-02');
    await crmStep('person-02', b.users.alisa.id, '2026-11-06');
    const admin = await buildHome(session(b.users.ria, []), NOW);
    expect(admin.my.nextForTeam).toBe(true);
    expect(admin.my.nextTasks[0]).toEqual(expect.objectContaining({ due: '2026-11-02', fo: 'Karson Reed' }));
    expect(admin.my.focusTab).toBe('overdue');
    expect((await buildHome(alisa(), NOW)).my.focusTab).toBe('upcoming');
  });

  it('B095: "To reach today" counts the people whose work is overdue, and opens Overdue', async () => {
    await coldStep(b.users.alisa.id, b.pods.Alisa.id, '2026-11-02');
    const home = await buildHome(alisa(), NOW);
    expect(home.my.todayTotal).toBe(0);
    expect(home.my.overdueTotal).toBe(1);
    expect(home.my.peopleToReachToday).toBe(1);
    expect(home.my.peopleDueToday).toBe(0);
    expect(home.my.focusTab).toBe('overdue');
  });

  it('B096: the board\'s replies, meetings and calls are the shared metrics\' figures, so Home and Reports agree', async () => {
    const { contact } = await coldStep(b.users.alisa.id, b.pods.Alisa.id);
    await crmStep('person-01', b.users.alisa.id);
    await prisma.touch.create({ data: { sandboxContactId: contact.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: new Date('2026-11-03T10:00:00Z'), summary: 'Reply: yes', externalId: 'b096-cold', audience: 'SANDBOX' } });
    await prisma.touch.create({ data: { personId: 'person-01', channel: 'EMAIL', direction: 'INBOUND', occurredAt: new Date('2026-11-03T11:00:00Z'), summary: 'Reply: sure', externalId: 'b096-crm', audience: 'CRM' } });
    // A reply from someone nobody reached out to is credited to their owner (person-03 is Alisa's).
    await prisma.touch.create({ data: { personId: 'person-03', channel: 'EMAIL', direction: 'INBOUND', occurredAt: new Date('2026-11-03T12:00:00Z'), summary: 'Reply: hello', externalId: 'b096-owner', audience: 'CRM' } });
    await prisma.meeting.create({ data: { title: 'Intro', sourceUrl: 'https://example.com/rec/b096', occurredAt: new Date('2026-11-04T17:00:00Z'), bookedById: b.users.alisa.id } });
    await prisma.nextAction.create({ data: { sandboxContactId: contact.id, foUserId: b.users.alisa.id, label: 'Meeting', action: 'CALL', kind: 'MEETING', dueDate: TODAY, state: 'DONE', lastDoneAt: new Date('2026-11-04T10:00:00Z'), audience: 'SANDBOX' } });
    await logManualCall({ userId: b.users.alisa.id, sandboxContactId: contact.id, startedAt: new Date('2026-11-03T15:00:00Z') });
    const home = await buildHome(alisa(), NOW);
    const row = home.team.find((r) => r.id === b.users.alisa.id)!;
    const week: Period = { from: home.week.fromInstant, to: home.week.toInstant };
    const rep = { kind: 'rep' as const, userId: b.users.alisa.id };
    const reports = await outreachMetrics(rep, 'all', week, NOW);
    expect(row.replies).toBe(reports.replies);
    expect(row.replies).toBe(3);
    // A meeting carries its day only: today's counts all day, on both screens.
    expect(row.meetings).toBe(reports.meetingsHeld);
    expect(row.meetings).toBe(2);
    expect(row.booked).toBe(reports.meetingsBooked);
    expect(row.calls).toBe(reports.dials);
    // The per-rep batches give each rep exactly the single-rep figure.
    const ids = [b.users.alisa.id, b.users.karson.id, b.users.leigh.id];
    const [replies, meetings, dials] = await Promise.all([repliesByRep(ids, 'all', week), meetingsByRep(ids, 'all', week, NOW), dialsByRep(ids, 'all', week)]);
    for (const id of ids) {
      const one = { kind: 'rep' as const, userId: id };
      expect(replies.get(id) ?? 0).toBe(await replyCount(one, 'all', week));
      expect(meetings.held.get(id) ?? 0).toBe(await meetingsHeld(one, 'all', week, NOW));
      expect(meetings.booked.get(id) ?? 0).toBe(await meetingsBooked(one, 'all', week));
      expect(dials.get(id) ?? 0).toBe((await outreachMetrics(one, 'all', week, NOW)).dials);
    }
  });

  it('N046: the board shows each rep\'s waiting forms, whatever the week, with the oldest one\'s age', async () => {
    const c = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    await logManualCall({ userId: b.users.karson.id, sandboxContactId: c.id, startedAt: new Date('2026-10-20T15:00:00Z') }, new Date('2026-11-02T12:00:00Z'));
    const home = await buildHome(session(b.users.ria, []), NOW);
    const row = home.team.find((r) => r.id === b.users.karson.id)!;
    expect(row).toEqual(expect.objectContaining({ formsWaiting: 1, calls: 0 }));
    expect(row.oldestFormAt?.toISOString()).toBe('2026-11-02T12:00:00.000Z');
    const html = renderToStaticMarkup(createElement(TeamBoard, { rows: home.team, week: { from: home.week.from, to: home.week.to }, title: 'The team this week', now: NOW }));
    expect(html).toContain('Forms waiting');
    expect(html).toContain('oldest 2 d');
  });

  it('B185: the board fits 1280px: the week\'s bar keeps at least 150px and shrinks with its column', () => {
    const fixed = Object.values(TEAM_BOARD_WIDTHS).reduce((a, w) => a + w, 0);
    // 1280px less the 232px sidebar and the page's 32px margins on each side.
    expect(1280 - 232 - 64 - fixed).toBeGreaterThanOrEqual(150);
    const row: TeamRow = { id: 'u1', name: 'Alisa Marsh', pod: 'Pod Alisa', done: 3, overdue: 1, today: 2, later: 4, replies: 1, meetings: 1, booked: 2, calls: 5, formsWaiting: 0, oldestFormAt: null };
    const html = renderToStaticMarkup(createElement(TeamBoard, { rows: [row], week: { from: '2026-11-02', to: '2026-11-08' }, title: 'The team this week', now: NOW }));
    expect(html).not.toContain('min-w-[180px]');
    expect(html).toContain('3</span> of 10 done');
    // Meetings held and booked are two figures, never added together.
    expect(html).toContain('2 booked');
    // Reports' donut legend clips a long label before its figures.
    expect(REPORT_DOCUMENT_STYLES).toContain('.rp-slice .rp-key { overflow: hidden; }');
  });
});

describe('one email counts once in All outreach (PLAN 6 rule 2, 8.14)', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });
  const T0 = new Date('2026-11-04T15:00:00Z');
  const period: Period = { from: new Date('2026-11-04T00:00:00Z'), to: new Date('2026-11-05T00:00:00Z') };
  const outlook = (key: string, subject: string, at: Date): SeenMail => ({ key, conversationId: `conv-${key}`, subject, at, mailboxUserId: b.users.alisa.id, via: 'outlook' });

  /** A cold contact "Also in CRM": a real CRM person has its address, and the contact points to them. */
  async function alsoInCrm() {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.personCache.create({ data: { id: 'person-twin', firstName: c.firstName, lastName: c.lastName, email: c.email, emailNorm: c.email, createdBySource: 'MANUAL' } });
    return prisma.sandboxContact.update({ where: { id: c.id }, data: { crmMatchPersonId: 'person-twin' } });
  }
  const crmReply = (c: { email: string | null }, subject: string, at: Date) => {
    const msg = getMockTwentyClient().addMessage({ subject, receivedAt: at.toISOString(), from: { handle: c.email!, personId: 'person-twin' }, to: [{ handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }] });
    return ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(msg), now: new Date(at.getTime() + 60_000) });
  };
  const replies = async () => ({ all: await replyCount({ kind: 'all' }, 'all', period), cold: await replyCount({ kind: 'all' }, 'cold', period), crm: await replyCount({ kind: 'all' }, 'crm', period) });

  it('a reply from an "Also in CRM" contact, seen by Outlook and then by the CRM\'s mail sync, is one reply, counted as cold', async () => {
    const c = await alsoInCrm();
    await recordColdReply(c.email!, outlook('<r1@x>', 'Re: A quick idea', T0), false);
    await crmReply(c, 'Re: A quick idea', new Date(T0.getTime() + 2 * 60_000));
    // Both records stay: the contact's, and the person's timeline. The person's is the copy.
    const cold = await prisma.touch.findFirstOrThrow({ where: { sandboxContactId: c.id, direction: 'INBOUND' } });
    expect(await prisma.touch.findFirstOrThrow({ where: { personId: 'person-twin', direction: 'INBOUND' } })).toEqual(expect.objectContaining({ audience: 'CRM', copyOfTouchId: cold.id }));
    expect(await replies()).toEqual({ all: 1, cold: 1, crm: 0 });
  });

  it('the same, the other way round: the CRM\'s mail sync first, then Outlook', async () => {
    const c = await alsoInCrm();
    await crmReply(c, 'Re: Pricing', T0);
    expect(await replies()).toEqual({ all: 1, cold: 0, crm: 1 });
    await recordColdReply(c.email!, outlook('<r2@x>', 'Re: Pricing', new Date(T0.getTime() + 3 * 60_000)), false);
    expect(await replies()).toEqual({ all: 1, cold: 1, crm: 0 });
    // All outreach is still CRM + Cold: the activity tiles stay additive.
    const all = await outreachMetrics({ kind: 'all' }, 'all', period);
    const parts = [await outreachMetrics({ kind: 'all' }, 'crm', period), await outreachMetrics({ kind: 'all' }, 'cold', period)];
    expect(all.replies).toBe(parts[0].replies + parts[1].replies);
  });

  it('an email sent to an "Also in CRM" contact is one email: the CRM\'s record of it is its copy', async () => {
    const c = await alsoInCrm();
    await recordColdSent([c.email!], outlook('<s1@x>', 'A quick idea', T0));
    const out = getMockTwentyClient().addMessage({ subject: 'A quick idea', receivedAt: new Date(T0.getTime() + 60_000).toISOString(), from: { handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }, to: [{ handle: c.email!, personId: 'person-twin' }] });
    expect((await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(out), now: new Date(T0.getTime() + 120_000) })).result).toBe('message_outbound_touch');
    const cold = await prisma.touch.findFirstOrThrow({ where: { sandboxContactId: c.id, direction: 'OUTBOUND' } });
    expect(await prisma.touch.findFirstOrThrow({ where: { personId: 'person-twin', direction: 'OUTBOUND' } })).toEqual(expect.objectContaining({ copyOfTouchId: cold.id }));
    // A different email the same day is not a copy.
    const other = getMockTwentyClient().addMessage({ subject: 'Something else', receivedAt: new Date(T0.getTime() + 90_000).toISOString(), from: { handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }, to: [{ handle: c.email!, personId: 'person-twin' }] });
    await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(other), now: new Date(T0.getTime() + 180_000) });
    expect(await prisma.touch.count({ where: { personId: 'person-twin', copyOfTouchId: null } })).toBe(1);
    // A contact with no CRM twin has nothing to mark.
    expect(await markCrmCopiesOf({ ...cold, sandboxContactId: (await readyContact(b.users.alisa.id, b.pods.Alisa.id)).id })).toBe(0);
  });

  it('the release migration links the copies written since 3 Nov, once, and audits each', async () => {
    const c = await alsoInCrm();
    const cold = await prisma.touch.create({ data: { sandboxContactId: c.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: T0, summary: 'Reply: Re: Deck', externalId: 'm-cold', audience: 'SANDBOX' } });
    const crm = await prisma.touch.create({ data: { personId: 'person-twin', channel: 'EMAIL', direction: 'INBOUND', occurredAt: new Date(T0.getTime() + 4 * 60_000), summary: 'Reply: Re: Deck', externalId: 'm-crm', audience: 'CRM' } });
    const far = await prisma.touch.create({ data: { personId: 'person-twin', channel: 'EMAIL', direction: 'INBOUND', occurredAt: new Date(T0.getTime() + 3_600_000), summary: 'Reply: Re: Deck', externalId: 'm-far', audience: 'CRM' } });
    const sql = fs.readFileSync(path.join(process.cwd(), 'prisma/migrations/20261105500000_touch_counted_once/migration.sql'), 'utf8');
    const backfill = sql.slice(sql.indexOf('DO $$'));
    await prisma.$executeRawUnsafe(backfill);
    await prisma.$executeRawUnsafe(backfill);
    expect((await prisma.touch.findUniqueOrThrow({ where: { id: crm.id } })).copyOfTouchId).toBe(cold.id);
    expect((await prisma.touch.findUniqueOrThrow({ where: { id: far.id } })).copyOfTouchId).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'email_counted_once' } })).toBe(1);
  });
});
