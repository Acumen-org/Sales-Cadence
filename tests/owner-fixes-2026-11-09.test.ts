import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { removeContact } from '@/lib/sandbox/contacts';
import { pendingFormCount, pendingForms } from '@/lib/calls/form';
import { GONE_CONTACT_DISCARD } from '@/lib/outreach/transitions';
import { numberRows, isCountedDay, NUMBERING_STARTS } from '@/lib/meetings/numbering';
import { meetingDayInstant } from '@/lib/meetings/day';
import { accountOf, refreshMeetingAccounts } from '@/lib/meetings/account';
import { startingTeam } from '@/lib/meetings/people-search';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/** The owner's changes of 9 Nov 2026: forms of removed contacts, counting from October, accounts, the team. */
let b: Basics;
beforeEach(async () => { await resetDb(); b = await seedBasics(); });

describe('a removed contact\'s calls stop waiting for their form', () => {
  it('removing the contact discards the waiting form, so the notice and the Call wait end', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const call = await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', statusRank: 4, userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: new Date(), audience: 'SANDBOX', podId: b.pods.Alisa.id, formDueAt: new Date() } });
    const done = await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', statusRank: 4, userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: new Date(), audience: 'SANDBOX', podId: b.pods.Alisa.id, formDueAt: new Date(), formDoneAt: new Date() } });
    expect(await pendingFormCount(b.users.alisa.id)).toBe(1);

    expect(await removeContact(c.id, userActor(b.users.alisa), new Date(), { reason: 'Imported by mistake' })).toEqual({ ok: true, id: c.id });

    expect(await pendingFormCount(b.users.alisa.id)).toBe(0);
    expect(await pendingForms(b.users.alisa.id)).toEqual([]);
    expect(await prisma.callLog.findUniqueOrThrow({ where: { id: call.id } })).toEqual(expect.objectContaining({ discardReason: GONE_CONTACT_DISCARD, discardedAt: expect.any(Date) }));
    // A call whose form was filled keeps it and counts as before.
    expect((await prisma.callLog.findUniqueOrThrow({ where: { id: done.id } })).discardedAt).toBeNull();
  });
});

describe('meetings are counted from 1 October 2026', () => {
  const row = (id: string, day: string, meetingId = id) => ({ id, personId: 'p1', meetingId, meetingNumber: null, occurredAt: meetingDayInstant(day), createdAt: new Date('2026-11-01T00:00:00Z'), approved: true });

  it('a meeting before October has no number, and the first one from October is the 1st', () => {
    expect(NUMBERING_STARTS).toBe('2026-10-01');
    expect(isCountedDay('2026-09-30')).toBe(false);
    expect(isCountedDay('2026-10-01')).toBe(true);
    const n = numberRows([row('a', '2026-08-12'), row('b', '2026-09-30'), row('c', '2026-10-01'), row('d', '2026-10-20')]);
    expect(Object.fromEntries(n)).toEqual({ a: null, b: null, c: 1, d: 2 });
  });

  it('a number Biz Ops set on a September meeting is ignored with it', () => {
    const n = numberRows([{ ...row('a', '2026-09-10'), numberSetTo: 4 }, row('b', '2026-10-03')]);
    expect(Object.fromEntries(n)).toEqual({ a: null, b: 1 });
  });
});

describe('a meeting\'s account', () => {
  it('is the account every prospect works at, and none when they work at different ones', () => {
    expect(accountOf([{ companyId: 'c1', companyName: 'Harbor' }, { companyId: 'c1', companyName: 'Harbor' }])).toEqual({ companyId: 'c1', name: 'Harbor' });
    expect(accountOf([{ companyId: 'c1', companyName: 'Harbor' }, { companyId: 'c2', companyName: 'Light' }, { companyId: 'c1', companyName: 'Harbor' }])).toEqual({ companyId: null, name: null });
    // A prospect the CRM has no account for does not decide it.
    expect(accountOf([{ companyId: 'c1', companyName: 'Harbor' }, { companyId: null, companyName: null }])).toEqual({ companyId: 'c1', name: 'Harbor' });
    expect(accountOf([{ companyId: null, companyName: 'Harbor ' }, { companyId: null, companyName: 'harbor' }])).toEqual({ companyId: null, name: 'Harbor' });
    expect(accountOf([{ companyId: null, companyName: 'Harbor' }, { companyId: null, companyName: 'Light' }])).toEqual({ companyId: null, name: null });
  });

  it('is filled in for older meetings that have none, and cleared on one whose prospects differ', async () => {
    const people = await prisma.personCache.findMany({ where: { companyId: { not: null }, deletedAt: null }, select: { id: true, companyId: true }, orderBy: { id: 'asc' } });
    const [p1] = people;
    const p2 = people.find((p) => p.companyId === p1.companyId && p.id !== p1.id) ?? null;
    const other = people.find((p) => p.companyId !== p1.companyId)!;
    const company = await prisma.companyCache.findUniqueOrThrow({ where: { id: p1.companyId! } });
    const meeting = (title: string, ids: string[], companyId: string | null = null, companyName: string | null = null) => prisma.meeting.create({ data: { title, sourceUrl: '', occurredAt: meetingDayInstant('2026-10-05'), review: 'APPROVED', companyId, companyName, attendees: { create: ids.map((personId) => ({ personId, prospect: true, name: personId })) } } });
    const same = await meeting('Same account', p2 ? [p1.id, p2.id] : [p1.id]);
    const mixed = await meeting('Mixed', [p1.id, other.id], company.id, company.name);
    expect((await refreshMeetingAccounts()).sort()).toEqual([same.id, mixed.id].sort());
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: same.id } })).toEqual(expect.objectContaining({ companyId: company.id, companyName: company.name }));
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: mixed.id } })).toEqual(expect.objectContaining({ companyId: null, companyName: null }));
    // A second pass changes nothing.
    expect(await refreshMeetingAccounts()).toEqual([]);
  });
});

describe('a new meeting\'s team', () => {
  it('starts with whoever adds it and the Sales Leader of their pod', async () => {
    const leader = await prisma.user.create({ data: { email: 'lead@cadence.local', name: 'Lena Lead', role: 'SALES_LEADER', passwordHash: 'x', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    await prisma.user.create({ data: { email: 'gone@cadence.local', name: 'Gone Lead', role: 'SALES_LEADER', passwordHash: 'x', active: false, pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    await prisma.user.create({ data: { email: 'other@cadence.local', name: 'Other Lead', role: 'SALES_LEADER', passwordHash: 'x', pods: { create: [{ podId: b.pods.Leigh.id }] } } });
    expect(await startingTeam({ id: b.users.karson.id, podIds: [b.pods.Alisa.id] })).toEqual([b.users.karson.id, leader.id]);
    // The leader adding it is not listed twice; an admin in no pod starts alone.
    expect(await startingTeam({ id: leader.id, podIds: [b.pods.Alisa.id] })).toEqual([leader.id]);
    expect(await startingTeam({ id: b.users.ria.id, podIds: [] })).toEqual([b.users.ria.id]);
  });
});
