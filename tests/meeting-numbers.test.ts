import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { createMeetingAction, deleteMeetingAction, prospectNumbersAction, toggleMeetingProductAction, updateMeetingAction } from '@/lib/actions/meetings';
import { numberRows, ordinal } from '@/lib/meetings/numbering';
import { closeNumberCheckAction, raiseNumberCheckAction, reopenNumberCheckAction, setMeetingNumberAction } from '@/lib/actions/number-checks';
import { findProspects } from '@/lib/meetings/people-search';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { withPeople } from './helpers/meeting-form';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * Meetings counted per prospect (owner, 29 October 2026): a prospect's earliest meeting in Cadence
 * is their 1st, and a meeting is the highest of its prospects' numbers, so it is a first meeting
 * only when everyone on it is new. The FO who booked it is credited once per meeting.
 */
let b: Basics;
const mock = getMockTwentyClient();
const session = (user: Basics['users']['alisa']): SessionUser => ({ ...user, timezone: WORKSPACE_TIMEZONE, podIds: [], pods: [] });
const add = async (title: string, day: string, prospects: string[]) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ title, sourceUrl: '', occurredAt: day, bookedById: b.users.karson.id })) fd.set(k, v);
  const r = await createMeetingAction(withPeople(fd, b.users.alisa.id, prospects));
  expect(r).toMatchObject({ ok: true });
  return prisma.meeting.findFirstOrThrow({ where: { title } });
};
const numbers = async () => Object.fromEntries((await prisma.meeting.findMany({ include: { attendees: { where: { prospect: true } } } })).map((m) => [m.title, { meeting: m.meetingNumber, ...Object.fromEntries(m.attendees.map((a) => [a.personId, a.meetingNumber])) }]));

beforeEach(async () => {
  await resetDb(); b = await seedBasics(); mock.reset(); mock.writes = [];
  auth.user.mockResolvedValue(session(b.users.ria));
});

describe('which meeting with each prospect this is', () => {
  it('counts by date, then by when it was added, and skips meetings not approved', () => {
    const at = (d: string) => new Date(`${d}T17:00:00Z`);
    const rows = [
      { id: 'a', personId: 'p', meetingId: 'm2', meetingNumber: null, occurredAt: at('2026-10-02'), createdAt: at('2026-10-01'), approved: true },
      { id: 'b', personId: 'p', meetingId: 'm1', meetingNumber: null, occurredAt: at('2026-10-01'), createdAt: at('2026-10-05'), approved: true },
      { id: 'c', personId: 'p', meetingId: 'm3', meetingNumber: null, occurredAt: at('2026-10-02'), createdAt: at('2026-10-03'), approved: true },
      { id: 'd', personId: 'p', meetingId: 'm4', meetingNumber: 9, occurredAt: at('2026-09-01'), createdAt: at('2026-09-01'), approved: false },
      { id: 'e', personId: 'q', meetingId: 'm2', meetingNumber: null, occurredAt: at('2026-10-02'), createdAt: at('2026-10-01'), approved: true },
    ];
    expect(Object.fromEntries(numberRows(rows))).toEqual({ a: 2, b: 1, c: 3, d: null, e: 1 });
    // A number Biz Ops set holds, and the ones after it count on from it.
    expect(Object.fromEntries(numberRows(rows.map((r) => (r.id === 'a' ? { ...r, numberSetTo: 5 } : r))))).toMatchObject({ b: 1, a: 5, c: 6 });
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '103rd']);
  });

  it("numbers each prospect's meetings, and a meeting by the highest of them", async () => {
    await add('Second', '2026-10-08', ['person-01']);
    // Added later but dated earlier: it becomes the first, and the other moves up.
    await add('First', '2026-10-01', ['person-01']);
    // Nina at 3 and Tomas at 1: the meeting is a 3rd meeting, not a first.
    await add('Mixed', '2026-10-15', ['person-01', 'person-02']);
    await add('Both new', '2026-10-16', ['person-03', 'person-04']);
    expect(await numbers()).toEqual({
      First: { meeting: 1, 'person-01': 1 },
      Second: { meeting: 2, 'person-01': 2 },
      Mixed: { meeting: 3, 'person-01': 3, 'person-02': 1 },
      // Two new prospects on one call are one first meeting.
      'Both new': { meeting: 1, 'person-03': 1, 'person-04': 1 },
    });
  });

  it('renumbers when a meeting moves, loses a prospect or is deleted, and tells Twenty about each one that moved', async () => {
    const first = await add('First', '2026-10-01', ['person-01']);
    await add('Second', '2026-10-08', ['person-01']);
    const third = await add('Third', '2026-10-15', ['person-01', 'person-02']);
    // Moved after the third: the others move down.
    const move = new FormData();
    for (const [k, v] of Object.entries({ meetingId: first.id, title: 'First', sourceUrl: '', occurredAt: '2026-10-20', bookedById: b.users.karson.id })) move.set(k, v);
    expect((await updateMeetingAction(withPeople(move, b.users.alisa.id, ['person-01']))).ok).toBe(true);
    expect(await numbers()).toMatchObject({ Second: { meeting: 1 }, Third: { meeting: 2, 'person-01': 2 }, First: { meeting: 3 } });
    mock.writes = [];
    expect((await deleteMeetingAction((() => { const fd = new FormData(); fd.set('meetingId', third.id); return fd; })())).ok).toBe(true);
    expect(await numbers()).toMatchObject({ Second: { meeting: 1 }, First: { meeting: 2, 'person-01': 2 } });
    // The record whose number changed is written again, with its new number.
    const saved = mock.writes.filter((w) => w.op === 'saveMeetingRecord') as Array<{ input: { cadenceId: string; data: Record<string, unknown> } }>;
    expect(saved.find((w) => w.input.cadenceId === first.id)?.input.data).toMatchObject({ meetingNumber: 2, firstMeeting: false });
  });

  it('tells the form which meeting it will be, counting itself, before anything is saved', async () => {
    await add('First', '2026-10-01', ['person-01']);
    const second = await add('Second', '2026-10-08', ['person-01']);
    const [nina, tomas] = await prospectNumbersAction(['person-01', 'person-02'], '2026-10-10', null);
    expect(nina).toEqual({ personId: 'person-01', number: 3, earlier: ['2026-10-01', '2026-10-08'], later: 0 });
    expect(tomas).toMatchObject({ number: 1, earlier: [], later: 0 });
    // Dated between them: the 2nd, and one later meeting moves up.
    expect((await prospectNumbersAction(['person-01'], '2026-10-05', null))[0]).toMatchObject({ number: 2, later: 1 });
    // Editing a meeting does not count it twice; on the same day it keeps its place.
    expect((await prospectNumbersAction(['person-01'], '2026-10-08', second.id))[0]).toMatchObject({ number: 2, later: 0 });
  });

  it('keeps at least one product on a meeting', async () => {
    const m = await add('Products', '2026-10-01', ['person-01']);
    const toggle = (product: string, on: boolean) => { const fd = new FormData(); fd.set('meetingId', m.id); fd.set('product', product); fd.set('on', String(on)); return toggleMeetingProductAction(fd); };
    const refused = await toggle('PHH', false);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatch(/only product on this meeting/);
    expect((await toggle('GLYNAC', true)).ok).toBe(true);
    expect((await toggle('PHH', false)).ok).toBe(true);
  });
});

describe('finding the prospect', () => {
  it('puts the closest match first from a few letters, a last name, a company or an address', async () => {
    await prisma.personCache.createMany({ data: [
      { id: 'x-1', firstName: 'Alex', lastName: 'Metzker', email: 'alex.metzker@prairie.example', companyName: 'Prairie Hill' },
      { id: 'x-2', firstName: 'Sally', lastName: 'Alexander', email: 'sally@north.example', companyName: 'North Co' },
      { id: 'x-3', firstName: 'Grant', lastName: 'Cook', email: 'gc@alexandria.example', companyName: 'Alexandria Bank', additionalEmails: ['grant.cook@home.example'] },
    ] });
    expect((await findProspects('alex')).slice(0, 3).map((p) => p.personId)).toEqual(['x-1', 'x-2', 'x-3']);
    expect((await findProspects('metz'))[0].personId).toBe('x-1');
    expect((await findProspects('cook gr'))[0].personId).toBe('x-3');
    expect((await findProspects('alexandria'))[0].personId).toBe('x-3');
    // Any address they have, not just the first.
    expect((await findProspects('grant.cook@home'))[0].personId).toBe('x-3');
    expect((await findProspects('sally@north.example'))[0]).toMatchObject({ personId: 'x-2', name: 'Sally Alexander', companyName: 'North Co' });
  });

  it('finds someone Twenty has and Cadence had not copied yet, and copies them in', async () => {
    const nina = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } });
    await prisma.meetingAttendee.deleteMany({});
    await prisma.personCache.delete({ where: { id: 'person-01' } });
    const found = await findProspects(nina.firstName.slice(0, 4));
    expect(found.some((p) => p.personId === 'person-01')).toBe(true);
    expect(await prisma.personCache.count({ where: { id: 'person-01', deletedAt: null } })).toBe(1);
  });

  it('includes people at a blocked account, and never our own team', async () => {
    const nina = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } });
    await prisma.blockedAccount.create({ data: { companyId: nina.companyId!, name: 'Blocked' } });
    expect((await findProspects(`${nina.firstName} ${nina.lastName}`))[0].personId).toBe('person-01');
    await prisma.personCache.create({ data: { id: 'x-team', firstName: 'Karson', lastName: 'Junior', email: b.users.karson.email } });
    expect((await findProspects(b.users.karson.email)).some((p) => p.personId === 'x-team')).toBe(false);
  });
});

describe('"Think this is wrong?"', () => {
  const fd = (values: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };

  it('sends what the number should be or what they know, and needs one of them', async () => {
    auth.user.mockResolvedValue(session(b.users.karson));
    expect(await raiseNumberCheckAction({ personId: 'person-01', day: '2026-10-08', shownNumber: 1 })).toEqual({ ok: false, error: 'Say what the number should be, or what you know about it.' });
    const raised = await raiseNumberCheckAction({ personId: 'person-01', day: '2026-10-08', shownNumber: 1, expectedNumber: 3, note: 'We met twice before Cadence' });
    expect(raised.ok).toBe(true);
    expect(await prisma.meetingNumberTicket.findFirstOrThrow()).toMatchObject({ personId: 'person-01', meetingId: null, meetingDay: '2026-10-08', shownNumber: 1, expectedNumber: 3, note: 'We met twice before Cadence', open: true, raisedById: b.users.karson.id });
    // Biz Ops cannot add meetings, so they never raise one; they check them.
    auth.user.mockResolvedValue({ ...session(b.users.karson), role: 'BIZ_OPS' });
    expect((await raiseNumberCheckAction({ personId: 'person-01', day: '2026-10-08', shownNumber: 1, expectedNumber: 2 })).ok).toBe(false);
  });

  it('is attached to the meeting it was raised on once that meeting is saved', async () => {
    auth.user.mockResolvedValue(session(b.users.alisa));
    const raised = await raiseNumberCheckAction({ personId: 'person-01', day: '2026-10-08', shownNumber: 1, expectedNumber: 2 });
    const form = new FormData();
    for (const [k, v] of Object.entries({ title: 'Checked', sourceUrl: '', occurredAt: '2026-10-08', bookedById: b.users.karson.id, numberChecksJson: JSON.stringify([raised.ok ? raised.id : '']) })) form.set(k, v);
    expect((await createMeetingAction(withPeople(form, b.users.alisa.id, ['person-01']))).ok).toBe(true);
    const meeting = await prisma.meeting.findFirstOrThrow({ where: { title: 'Checked' } });
    expect((await prisma.meetingNumberTicket.findFirstOrThrow()).meetingId).toBe(meeting.id);
  });

  it('lets Biz Ops set the number, counts the later meetings on from it, tells Twenty, and closes the check', async () => {
    await add('First', '2026-10-01', ['person-01']);
    const second = await add('Second', '2026-10-08', ['person-01']);
    await add('Third', '2026-10-15', ['person-01']);
    const row = await prisma.meetingAttendee.findFirstOrThrow({ where: { meetingId: second.id, personId: 'person-01' } });
    const raised = await raiseNumberCheckAction({ personId: 'person-01', meetingId: second.id, day: '2026-10-08', shownNumber: 2, expectedNumber: 4, note: 'Two calls before Cadence' });

    // An FO cannot set numbers or close checks.
    auth.user.mockResolvedValue(session(b.users.karson));
    expect(await setMeetingNumberAction(fd({ attendeeId: row.id, number: '4' }))).toEqual({ ok: false, error: 'Only Biz Ops and admins check meeting numbers.' });

    auth.user.mockResolvedValue({ ...session(b.users.karson), role: 'BIZ_OPS' });
    mock.writes = [];
    expect((await setMeetingNumberAction(fd({ attendeeId: row.id, number: '4' }))).ok).toBe(true);
    expect(await numbers()).toMatchObject({ First: { meeting: 1 }, Second: { meeting: 4 }, Third: { meeting: 5 } });
    const saved = mock.writes.filter((w) => w.op === 'saveMeetingRecord') as Array<{ input: { data: Record<string, unknown> } }>;
    expect(saved.map((w) => w.input.data.meetingNumber).sort()).toEqual([4, 5]);
    // The form now counts on from the set number too.
    expect((await prospectNumbersAction(['person-01'], '2026-10-20', null))[0]).toMatchObject({ number: 6 });

    // Counted again from the meetings before it.
    expect((await setMeetingNumberAction(fd({ attendeeId: row.id, number: '' }))).ok).toBe(true);
    expect(await numbers()).toMatchObject({ Second: { meeting: 2 }, Third: { meeting: 3 } });

    const id = raised.ok ? raised.id : '';
    expect((await closeNumberCheckAction(fd({ ticketId: id, resolution: 'Checked with Karson: two calls in August. Set to 4.' }))).ok).toBe(true);
    expect(await prisma.meetingNumberTicket.findUniqueOrThrow({ where: { id } })).toMatchObject({ open: false, resolution: 'Checked with Karson: two calls in August. Set to 4.' });
    expect((await closeNumberCheckAction(fd({ ticketId: id }))).ok).toBe(false);
    expect((await reopenNumberCheckAction(fd({ ticketId: id }))).ok).toBe(true);
    expect((await prisma.meetingNumberTicket.findUniqueOrThrow({ where: { id } })).open).toBe(true);
  });
});
