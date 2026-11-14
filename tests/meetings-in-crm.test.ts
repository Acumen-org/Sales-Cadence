import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { createMeetingAction } from '@/lib/actions/meetings';
import { changedInTwenty, checkMeetingsInCrm, meetingsNotFromCadence } from '@/lib/meetings/crm-check';
import { meetingDay } from '@/lib/meetings/day';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { withPeople } from './helpers/meeting-form';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * Cadence writes the record and Twenty keeps it (owner, 2 November 2026): nothing flows back from
 * Twenty. The worker checks Twenty still holds what Cadence wrote, numbered, and writes again
 * whatever it does not; a meeting someone added in Twenty itself is left alone.
 */
let b: Basics;
const mock = getMockTwentyClient();
const check = () => checkMeetingsInCrm({ client: mock });
const add = async (title: string, day: string, prospects: string[]) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ title, sourceUrl: '', occurredAt: day, bookedById: b.users.karson.id })) fd.set(k, v);
  expect(await createMeetingAction(withPeople(fd, b.users.alisa.id, prospects))).toMatchObject({ ok: true });
  return prisma.meeting.findFirstOrThrow({ where: { title } });
};
const record = (twentyId: string | null) => mock.meetingRecords.get(twentyId!)!;

beforeEach(async () => {
  await resetDb(); b = await seedBasics(); mock.reset(); mock.writes = [];
  auth.user.mockResolvedValue({ ...b.users.ria, timezone: WORKSPACE_TIMEZONE, podIds: [], pods: [] });
});

describe('Twenty holds every meeting as Cadence wrote it', () => {
  it('writes nothing when Twenty already holds it', async () => {
    await add('Kick-off', '2026-10-01', ['person-01']);
    await add('Demo', '2026-10-08', ['person-01', 'person-02']);
    mock.writes = [];
    expect(await check()).toMatchObject({ read: 2, written: 0, linked: 0, notFromCadence: 0 });
    expect(mock.writes).toEqual([]);
  });

  it('writes a number again when Twenty lost it', async () => {
    const m = await prisma.meeting.findUniqueOrThrow({ where: { id: (await add('Kick-off', '2026-10-01', ['person-01'])).id } });
    mock.editMeetingInTwenty(m.twentyMeetingId!, { meetingNumber: null, firstMeeting: false });
    expect(await check()).toMatchObject({ written: 1 });
    expect(record(m.twentyMeetingId).data).toMatchObject({ meetingNumber: 1, firstMeeting: true });
  });

  it('puts back what Cadence has when the record is changed in Twenty, and takes nothing from it', async () => {
    const m = await prisma.meeting.findUniqueOrThrow({ where: { id: (await add('Kick-off', '2026-10-01', ['person-01'])).id } });
    mock.editMeetingInTwenty(m.twentyMeetingId!, { meetingDate: '2026-09-20', name: 'Renamed in Twenty' }, ['person-01', 'person-03']);
    expect(await check()).toMatchObject({ written: 1 });
    expect(record(m.twentyMeetingId).data).toMatchObject({ meetingDate: '2026-10-01', name: 'Kick-off', meetingNumber: 1 });
    expect(record(m.twentyMeetingId).contacts.map((c) => c.personId)).toEqual(['person-01']);
    const after = await prisma.meeting.findUniqueOrThrow({ where: { id: m.id }, include: { attendees: { where: { prospect: true } } } });
    expect([meetingDay(after.occurredAt), after.title, after.attendees.map((a) => a.personId)]).toEqual(['2026-10-01', 'Kick-off', ['person-01']]);
  });

  it('writes a meeting again when its record is gone, and finds one whose id never came back', async () => {
    const gone = await prisma.meeting.findUniqueOrThrow({ where: { id: (await add('Kick-off', '2026-10-01', ['person-01'])).id } });
    const lost = await prisma.meeting.findUniqueOrThrow({ where: { id: (await add('Demo', '2026-10-08', ['person-02'])).id } });
    mock.meetingRecords.delete(gone.twentyMeetingId!);
    await prisma.meeting.update({ where: { id: lost.id }, data: { twentyMeetingId: null } });
    expect(await check()).toMatchObject({ written: 1 });
    // Found by its Cadence ID, not written a second time.
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: lost.id } })).twentyMeetingId).toBe(lost.twentyMeetingId);
    expect([...mock.meetingRecords.values()].filter((r) => r.cadenceId === gone.id)).toHaveLength(1);
    expect(mock.meetingRecords.size).toBe(2);
  });

  it("numbers an older meeting whose prospect was typed in, by their address or a name only they have at the meeting's account", async () => {
    const person = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } });
    const tomas = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-02' } });
    const at = new Date('2026-10-02T17:00:00Z');
    const byAddress = await prisma.meeting.create({ data: { title: 'Typed address', sourceUrl: '', occurredAt: at, attendees: { create: [{ name: 'N. H.', email: person.email, external: true }, { userId: b.users.alisa.id, email: b.users.alisa.email, name: b.users.alisa.name }] } } });
    const byName = await prisma.meeting.create({ data: { title: 'Typed name', sourceUrl: '', occurredAt: at, companyId: tomas.companyId, companyName: tomas.companyName, attendees: { create: [{ name: 'Tomas Berg', external: true }] } } });
    const nobody = await prisma.meeting.create({ data: { title: 'Nobody known', sourceUrl: '', occurredAt: at, attendees: { create: [{ name: 'Someone Unknown', external: true }] } } });
    // S12: a name alone, with no account to check it against, could be another person of that name.
    await prisma.meeting.create({ data: { title: 'Name, no account', sourceUrl: '', occurredAt: at, attendees: { create: [{ name: 'Tomas Berg', external: true }] } } });

    expect(await check()).toMatchObject({ linked: 2, written: 4 });
    const numbers = Object.fromEntries((await prisma.meeting.findMany()).map((m) => [m.title, m.meetingNumber]));
    expect(numbers).toEqual({ 'Typed address': 1, 'Typed name': 1, 'Nobody known': null, 'Name, no account': null });
    expect(await prisma.meetingAttendee.findFirstOrThrow({ where: { meetingId: byName.id } })).toMatchObject({ personId: 'person-02', prospect: true });
    const written = await prisma.meeting.findUniqueOrThrow({ where: { id: byAddress.id } });
    expect(record(written.twentyMeetingId).data).toMatchObject({ meetingNumber: 1, firstMeeting: true });
    expect(record(written.twentyMeetingId).contacts.map((c) => c.personId)).toEqual(['person-01']);
    // Written to Twenty like any meeting; numbered once someone picks who it was with.
    expect(record((await prisma.meeting.findUniqueOrThrow({ where: { id: nobody.id } })).twentyMeetingId).data).toMatchObject({ meetingNumber: null, firstMeeting: false });
    mock.writes = [];
    expect(await check()).toMatchObject({ linked: 0, written: 0 });
  });

  it('leaves a meeting someone added in Twenty itself alone, and lists it', async () => {
    await add('Follow-up', '2026-10-08', ['person-01']);
    const theirs = mock.addMeetingInTwenty({ name: 'Logged in Twenty', meetingDate: '2026-10-01' }, ['person-01']);
    mock.writes = [];
    expect(await check()).toMatchObject({ notFromCadence: 1, written: 0 });
    expect(mock.writes).toEqual([]);
    expect(await prisma.meeting.count()).toBe(1);
    expect((await prisma.meeting.findFirstOrThrow()).meetingNumber).toBe(1);
    expect(record(theirs).data).toEqual({ name: 'Logged in Twenty', meetingDate: '2026-10-01' });
    expect(await meetingsNotFromCadence()).toEqual({ count: 1, items: [{ id: theirs, name: 'Logged in Twenty', day: '2026-10-01' }] });
  });

  it('S10: a prospect named like a colleague is linked as a contact, not rewritten each pass', async () => {
    const m = await add('Kick-off', '2026-10-01', ['person-01']);
    const before = await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(before.companyId).not.toBeNull();
    // The prospect turns out to share a team member's name.
    const p = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } });
    await prisma.user.update({ where: { id: b.users.ria.id }, data: { name: `${p.firstName} ${p.lastName}` } });
    // Written again for any reason (here: no snapshot).
    await prisma.meeting.update({ where: { id: m.id }, data: { twentySnapshot: Prisma.DbNull } });
    await check();
    mock.writes = [];
    expect(await check()).toMatchObject({ written: 0 });
    expect(record(before.twentyMeetingId).contacts.map((c) => c.personId)).toEqual(['person-01']);
  });

  it('reads a tag by its name or its value alike', () => {
    const wrote = { name: 'Demo', day: '2026-10-01', bookedBy: ['Karson Reed'], products: ['PHH'], team: [], recording: '', contacts: ['person-01'] };
    expect(changedInTwenty(wrote, { ...wrote, bookedBy: ['KARSON_REED'] })).toEqual([]);
    expect(changedInTwenty(wrote, { ...wrote, day: '2026-09-20', contacts: ['person-01', 'person-02'] })).toEqual(['day', 'contacts']);
  });
});

describe('N14, N15, N16: meeting writes that change nothing are not repeated', () => {
  it('N15: a record that cannot match, unchanged since Cadence wrote it, is written again at most hourly', async () => {
    const m = await add('Kick-off', '2026-10-01', ['person-01']);
    // Twenty holds it another way, without anyone editing it since (its updatedAt does not move).
    record(m.twentyMeetingId).data.name = 'Kick-off (stored otherwise)';
    // Twenty stamped Cadence's write a moment before Cadence noted it (the answer's round trip).
    record(m.twentyMeetingId).updatedAt = new Date(Date.now() - 60_000).toISOString();
    expect(await check()).toMatchObject({ written: 0 });
    await prisma.meeting.update({ where: { id: m.id }, data: { twentySyncedAt: new Date(Date.now() - 2 * 3600_000) } });
    expect(await check()).toMatchObject({ written: 1 });
  });

  it('N16: a second record carrying the same Cadence ID is removed', async () => {
    const m = await add('Kick-off', '2026-10-01', ['person-01']);
    const dup = mock.addMeetingInTwenty({ ...record(m.twentyMeetingId).data }, ['person-01']);
    expect(await check()).toMatchObject({ duplicatesRemoved: 1 });
    expect(mock.meetingRecords.has(dup)).toBe(false);
    expect(mock.meetingRecords.has(m.twentyMeetingId!)).toBe(true);
  });

  it('N14: meetings are written again for a missing tag only once Twenty has it', async () => {
    const { missingTagsNowInCrm } = await import('@/lib/meetings/crm');
    const schema = (await mock.meetingSchema())!;
    const products = schema.fields.products!;
    expect(missingTagsNowInCrm(schema, [{ field: 'Products', name: 'Brand New' }])).toBe(false);
    products.options.push({ value: 'BRAND_NEW', label: 'Brand New' });
    expect(missingTagsNowInCrm(schema, [{ field: 'Products', name: 'brand new' }])).toBe(true);
  });
});

describe('N15: the webhook Twenty sends for Cadence\'s own meeting write', () => {
  it('is known as an echo for two minutes, for the record and its contact rows', async () => {
    const { ownMeetingEcho } = await import('@/lib/meetings/crm-check');
    const m = await add('Kick-off', '2026-10-01', ['person-01']);
    expect(await ownMeetingEcho(m.twentyMeetingId!, {})).toBe(true);
    expect(await ownMeetingEcho('row-9', { meetingId: m.twentyMeetingId })).toBe(true);
    expect(await ownMeetingEcho(m.twentyMeetingId!, {}, Date.now() + 5 * 60_000)).toBe(false);
  });
});

describe('N24: a typed-in name on a meeting with an account', () => {
  it('links only a person of that name at that account', async () => {
    const at = new Date('2026-10-02T17:00:00Z');
    const tomas = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-02' } });
    const other = await prisma.companyCache.findFirstOrThrow({ where: { NOT: { id: tomas.companyId ?? '' } } });
    const elsewhere = await prisma.meeting.create({ data: { title: 'Namesake', sourceUrl: '', occurredAt: at, companyId: other.id, attendees: { create: [{ name: 'Tomas Berg', external: true }] } } });
    const same = await prisma.meeting.create({ data: { title: 'Same firm', sourceUrl: '', occurredAt: at, companyId: tomas.companyId, attendees: { create: [{ name: 'Tomas Berg', external: true }] } } });
    await check();
    expect((await prisma.meetingAttendee.findFirstOrThrow({ where: { meetingId: elsewhere.id } })).personId).toBeNull();
    expect((await prisma.meetingAttendee.findFirstOrThrow({ where: { meetingId: same.id } })).personId).toBe('person-02');
  });
});
