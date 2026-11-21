import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { backfillMeetingsToCrm, syncMeetingToCrm } from '@/lib/meetings/crm';
import { renumberProspects } from '@/lib/meetings/numbering';
import { approveMeeting, askForMeetingsSince, takeWaitingOutOfCrm } from '@/lib/meetings/approval';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/**
 * Owner, 21 Nov 2026: "they get counted in the CRM only when they are approved". A meeting with no
 * recording waiting for approval has no meeting number and no CRM record; approved, it gets both.
 * Meetings already waiting (and already written) were taken out once.
 */
describe('a meeting waiting for approval is not in the CRM', () => {
  let b: Basics;
  const mock = getMockTwentyClient();

  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    mock.reset();
    mock.writes = [];
  });

  const make = (title: string, day: string, extra: Record<string, unknown> = {}) => prisma.meeting.create({ data: {
    title, sourceUrl: '', occurredAt: new Date(`${day}T17:00:00Z`), bookedById: b.users.karson.id, createdById: b.users.karson.id, products: ['PHH'],
    attendees: { create: [{ personId: 'person-01', email: 'p1@prospect.example', name: 'Pat One', external: true, prospect: true }] }, ...extra,
  } });
  const row = (id: string) => prisma.meeting.findUniqueOrThrow({ where: { id } });
  const admin = () => ({ id: b.users.ria.id, role: b.users.ria.role, podIds: [], name: b.users.ria.name });

  it('is never written while it waits; one written before is taken out, and its prospect\'s later meeting moves up', async () => {
    const first = await make('No link, 3 Nov', '2026-11-03');
    const second = await make('Recorded, 10 Nov', '2026-11-10', { sourceUrl: 'https://www.loom.com/share/abc123' });
    await renumberProspects(['person-01']);
    expect(await backfillMeetingsToCrm()).toBe(2);
    const record = (await row(first.id)).twentyMeetingId!;
    expect(mock.meetingRecords.has(record)).toBe(true);
    expect((await row(second.id)).meetingNumber).toBe(2);

    // Sent for approval (the 1 November backfill): out of the CRM and unnumbered.
    expect(await askForMeetingsSince('2026-11-01')).toMatchObject({ waiting: 1 });
    expect(mock.meetingRecords.has(record)).toBe(false);
    expect(await row(first.id)).toMatchObject({ approval: 'WAITING', twentyMeetingId: null, meetingNumber: null });
    expect((await row(second.id)).meetingNumber).toBe(1);
    expect(mock.meetingRecords.get((await row(second.id)).twentyMeetingId!)!.data).toMatchObject({ meetingNumber: 1 });
    // Nothing writes it while it waits.
    expect(await syncMeetingToCrm(first.id)).toBeNull();
    expect(await backfillMeetingsToCrm({ all: true })).toBe(1);
    expect([...mock.meetingRecords.values()].map((r) => r.cadenceId)).toEqual([second.id]);

    // Approved: numbered 1st, the recorded one is 2nd again, and it is in the CRM.
    expect(await approveMeeting(first.id, admin(), userActor(b.users.ria))).toMatchObject({ ok: true });
    expect(await row(first.id)).toMatchObject({ approval: 'APPROVED', meetingNumber: 1 });
    expect((await row(second.id)).meetingNumber).toBe(2);
    expect([...mock.meetingRecords.values()].map((r) => r.cadenceId).sort()).toEqual([first.id, second.id].sort());
  });

  it('meetings already waiting and written are taken out once', async () => {
    const m = await make('Waiting, written before', '2026-11-05');
    await renumberProspects(['person-01']);
    await syncMeetingToCrm(m.id);
    const record = (await row(m.id)).twentyMeetingId!;
    // As production had it: waiting, numbered, in the CRM.
    await prisma.meeting.update({ where: { id: m.id }, data: { approval: 'WAITING' } });
    expect(await takeWaitingOutOfCrm()).toEqual({ meetings: 1, removed: 1 });
    expect(mock.meetingRecords.has(record)).toBe(false);
    expect(await row(m.id)).toMatchObject({ twentyMeetingId: null, meetingNumber: null });
    expect(await prisma.meetingAttendee.count({ where: { meetingId: m.id, meetingNumber: { not: null } } })).toBe(0);
    expect(await takeWaitingOutOfCrm()).toEqual({ meetings: 0, removed: 0 });
  });
});
