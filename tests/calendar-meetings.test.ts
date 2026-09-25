import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { importCalendarEvent, importCalendarWindow, linkKey, readRecently } from '@/lib/meetings/calendar-import';
import { ingestEvent } from '@/lib/engine/ingest';
import { reconcile } from '@/lib/engine/reconcile';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { getSettings, saveSettingsSection } from '@/lib/settings';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const { inspectMeetingLinkAction, approveMeetingAction, deleteMeetingAction } = await import('@/lib/actions/meetings');
const { meetingReadWhere } = await import('@/lib/meetings-query');

const asUser = (user: User, podIds: string[] = []): SessionUser => ({ ...user, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const MEET = 'https://meet.google.com/abc-defg-hij';

/**
 * Meetings come from the team's calendars by themselves: an event with one of us and a CRM contact
 * on it becomes a meeting, kept in step with the invite, and a pasted join link fills the form from
 * the same event.
 */
describe('meetings from the calendar', () => {
  let b: Basics, contact: { id: string; email: string; companyId: string | null };
  const mock = getMockTwentyClient();

  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    const s = await getSettings();
    await saveSettingsSection('rules', { ...s.rules, internalDomains: ['cadence.local', 'prairie-hill.com'] });
    const p = await prisma.personCache.findFirstOrThrow({ where: { id: 'person-01' } });
    contact = { id: p.id, email: p.email ?? 'person-01@prospect.example', companyId: p.companyId };
    if (!p.email) await prisma.personCache.update({ where: { id: p.id }, data: { email: contact.email } });
    auth.user.mockResolvedValue(asUser(b.users.alisa, [b.pods.Alisa.id]));
  });

  const event = (over: Partial<Parameters<typeof mock.addCalendarEvent>[0]> = {}) => mock.addCalendarEvent({
    id: 'cal-1', title: 'Alisa and Nina: PHH', startsAt: '2027-01-05T16:00:00.000Z', endsAt: '2027-01-05T16:45:00.000Z', conferenceUrl: MEET,
    participants: [{ handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId, isOrganizer: true, displayName: 'Alisa Marsh' }, { handle: contact.email, personId: contact.id, displayName: 'Nina Halvorsen' }],
    ...over,
  });

  it('adds a meeting for an event with one of us and a contact on it, booked by the organiser', async () => {
    const r = await importCalendarEvent(event());
    expect(r.result).toBe('created');
    const m = await prisma.meeting.findUniqueOrThrow({ where: { calendarEventId: 'cal-1' }, include: { attendees: true } });
    expect(m).toEqual(expect.objectContaining({ title: 'Alisa and Nina: PHH', durationSec: 45 * 60, sourceUrl: MEET, bookedById: b.users.alisa.id, companyId: contact.companyId }));
    expect(m.occurredAt.toISOString()).toBe('2027-01-05T16:00:00.000Z');
    expect(m.attendees.map((a) => [a.userId ?? a.personId, a.external]).sort()).toEqual([[b.users.alisa.id, false], [contact.id, true]].sort());
  });

  it('keeps the meeting in step with the invite: a new time, a new guest, and never a second meeting', async () => {
    await importCalendarEvent(event());
    const moved = event({ startsAt: '2027-01-06T15:00:00.000Z', endsAt: '2027-01-06T15:30:00.000Z', participants: [...event().participants, { handle: 'karson@cadence.local', workspaceMemberId: b.users.karson.twentyMemberId }] });
    expect((await importCalendarEvent(moved)).result).toBe('updated');
    const all = await prisma.meeting.findMany({ include: { attendees: true } });
    expect(all).toHaveLength(1);
    expect(all[0].occurredAt.toISOString()).toBe('2027-01-06T15:00:00.000Z');
    expect(all[0].durationSec).toBe(30 * 60);
    expect(all[0].attendees.map((a) => a.userId).filter(Boolean)).toEqual(expect.arrayContaining([b.users.karson.id]));
    // A recording put on it by hand stays when the invite changes again.
    await prisma.meeting.update({ where: { id: all[0].id }, data: { sourceUrl: 'https://drive.google.com/file/d/rec123/view', notes: 'Went well' } });
    await importCalendarEvent(moved);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: all[0].id } })).sourceUrl).toContain('drive.google.com');
  });

  it('leaves out internal meetings, full-day events and meetings with nobody from the CRM', async () => {
    expect((await importCalendarEvent(event({ id: 'cal-int', participants: [{ handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId }, { handle: 'smilliman@prairie-hill.com' }] }))).result).toBe('skipped');
    expect((await importCalendarEvent(event({ id: 'cal-day', isFullDay: true }))).result).toBe('skipped');
    expect((await importCalendarEvent(event({ id: 'cal-stranger', participants: [{ handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId }, { handle: 'someone@elsewhere.example' }] }))).result).toBe('skipped');
    expect(await prisma.meeting.count()).toBe(0);
  });

  it('takes a cancelled meeting away, unless someone has worked on it', async () => {
    await importCalendarEvent(event());
    expect((await importCalendarEvent(event({ isCanceled: true }))).result).toBe('removed');
    expect(await prisma.meeting.count()).toBe(0);
    await importCalendarEvent(event());
    await prisma.meeting.updateMany({ data: { notes: 'Agreed next steps' } });
    expect((await importCalendarEvent(event({ isCanceled: true }))).result).toBe('skipped');
    expect(await prisma.meeting.count()).toBe(1);
  });

  it('matches a meeting someone already added by hand, by its contact, instead of adding it twice', async () => {
    const manual = await prisma.meeting.create({ data: { title: 'Nina call', sourceUrl: '', occurredAt: new Date('2027-01-05T16:05:00Z'), bookedById: b.users.alisa.id, createdById: b.users.alisa.id, attendees: { create: [{ name: 'Nina', email: contact.email, personId: contact.id, external: true }] } } });
    expect((await importCalendarEvent(event())).result).toBe('linked');
    expect(await prisma.meeting.count()).toBe(1);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: manual.id } })).calendarEventId).toBe('cal-1');
    // A meeting made by hand is never taken away with its event.
    await importCalendarEvent(event({ isCanceled: true }));
    expect(await prisma.meeting.count()).toBe(1);
  });

  it('never merges two FOs’ meetings that only share a title', async () => {
    await prisma.meeting.create({ data: { title: 'Alisa and Nina: PHH', sourceUrl: '', occurredAt: new Date('2027-01-05T16:00:00Z'), bookedById: b.users.karson.id, createdById: b.users.karson.id } });
    expect((await importCalendarEvent(event())).result).toBe('created');
    expect(await prisma.meeting.count()).toBe(2);
  });

  it('keeps what has happened or been edited: a past meeting stays, an edited one only moves', async () => {
    await importCalendarEvent(event({ id: 'cal-past', startsAt: '2026-01-05T16:00:00.000Z', endsAt: '2026-01-05T16:30:00.000Z' }));
    expect((await importCalendarEvent(event({ id: 'cal-past', startsAt: '2026-01-05T16:00:00.000Z', isCanceled: true }))).result).toBe('skipped');
    await importCalendarEvent(event());
    const m = await prisma.meeting.findUniqueOrThrow({ where: { calendarEventId: 'cal-1' } });
    await prisma.meeting.update({ where: { id: m.id }, data: { title: 'Nina - renamed by Alisa', editedAt: new Date() } });
    await importCalendarEvent(event({ title: 'Changed in the calendar', startsAt: '2027-01-06T16:00:00.000Z' }));
    const after = await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(after.title).toBe('Nina - renamed by Alisa');
    expect(after.occurredAt.toISOString()).toBe('2027-01-06T16:00:00.000Z');
    expect((await importCalendarEvent(event({ isCanceled: true }))).result).toBe('skipped');
  });

  it('adds the meeting once when two webhooks for it arrive at the same moment', async () => {
    const e = event();
    const results = await Promise.all([importCalendarEvent(e), importCalendarEvent(e), importCalendarEvent(e)]);
    expect(results.filter((r) => r.result === 'created')).toHaveLength(1);
    expect(await prisma.meeting.count()).toBe(1);
  });

  it('follows the webhooks: an event, a guest answering, and a deletion', async () => {
    event({ participants: [{ handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId, isOrganizer: true }] });
    // The event arrives before its guests: nothing to add yet.
    expect((await ingestEvent({ source: 'WEBHOOK', objectType: 'calendarEvent', eventName: 'calendarEvent.created', record: { id: 'cal-1', title: 'Alisa and Nina: PHH', updatedAt: '2027-01-01T10:00:00Z' } })).result).toBe('calendar_skipped');
    event();
    expect((await ingestEvent({ source: 'WEBHOOK', objectType: 'calendarEventParticipant', eventName: 'calendarEventParticipant.created', record: { id: 'cal-1-p2', calendarEventId: 'cal-1', handle: contact.email, updatedAt: '2027-01-01T10:01:00Z' } })).result).toBe('calendar_created');
    expect(await prisma.meeting.count()).toBe(1);
    expect((await ingestEvent({ source: 'WEBHOOK', objectType: 'calendarEvent', eventName: 'calendarEvent.destroyed', record: { id: 'cal-1', deletedAt: '2027-01-02T10:00:00Z' } })).result).toBe('calendar_removed');
    expect(await prisma.meeting.count()).toBe(0);
  });

  it('reads the calendar in the regular sync, and by date for meetings booked long ago', async () => {
    event({ updatedAt: '2027-01-01T10:00:00.000Z' });
    const stats = await reconcile({ since: '2026-12-31T00:00:00.000Z', actor: SYSTEM_ACTOR, now: new Date('2027-01-01T12:00:00Z'), skipSync: true }, mock);
    expect(stats).toEqual(expect.objectContaining({ calendarEvents: 1, calendarMeetings: 1 }));
    event({ id: 'cal-old', title: 'Booked a month ago', updatedAt: '2026-11-01T10:00:00.000Z', startsAt: '2027-01-07T16:00:00.000Z', conferenceUrl: null });
    const window = await importCalendarWindow({ from: new Date('2027-01-01T00:00:00Z'), to: new Date('2027-02-01T00:00:00Z'), client: mock });
    expect(window.created).toBe(1);
    expect(await prisma.meeting.count()).toBe(2);
  });

  it('fills the form from a pasted join link, and says when the meeting is already here', async () => {
    event({ participants: [...event().participants, { handle: 'guest@elsewhere.example', displayName: 'A guest' }] });
    const r = await inspectMeetingLinkAction(MEET);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Alisa's clock is Europe/London: 16:00 UTC in January is 16:00 there.
    expect(r.data).toEqual(expect.objectContaining({ fromCalendar: true, title: 'Alisa and Nina: PHH', date: '2027-01-05', time: '16:00', durationMin: 45, bookedById: b.users.alisa.id, companyId: contact.companyId }));
    expect(r.data.attendees?.map((a) => a.userId ?? a.personId ?? a.email)).toEqual([b.users.alisa.id, contact.id, 'guest@elsewhere.example']);
    // However it was copied: with the account chooser's ?authuser=1, or a trailing slash.
    const copied = await inspectMeetingLinkAction(`${MEET}/?authuser=1`);
    expect(copied.ok && copied.data.fromCalendar).toBe(true);
    await importCalendarEvent(event());
    const again = await inspectMeetingLinkAction(MEET);
    expect(again.ok && again.data.existingMeetingId).toBeTruthy();
  });

  it('finds a Teams invite whether its link was copied encoded or not', async () => {
    const teams = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjQ1Yz%40thread.v2/0?context=%7b%22Tid%22%7d';
    event({ conferenceUrl: teams });
    for (const pasted of [teams, 'https://teams.microsoft.com/l/meetup-join/19:meeting_NjQ1Yz@thread.v2/0']) {
      const r = await inspectMeetingLinkAction(pasted);
      expect(r.ok && r.data.fromCalendar).toBe(true);
    }
  });

  it('never fills from a cancelled event, and says plainly when no event has the link', async () => {
    event({ isCanceled: true });
    const r = await inspectMeetingLinkAction(MEET);
    expect(r.ok && r.data.fromCalendar).toBeFalsy();
  });

  it('reads an event once for a burst of guest updates, and again once the burst has passed', () => {
    const t = 1_900_000_000_000;
    expect(readRecently('burst-1', t)).toBe(false);
    // Guests answering every few seconds do not push the next read further away.
    for (let i = 1; i <= 5; i++) expect(readRecently('burst-1', t + i * 1_500)).toBe(true);
    expect(readRecently('burst-1', t + 10_500)).toBe(false);
  });

  it('treats a Zoom meeting on a regional host as the same link', () => {
    expect(linkKey('https://us06web.zoom.us/j/81234567890?pwd=abc')).toBe(linkKey('https://zoom.us/j/81234567890'));
    expect(linkKey('https://acme.zoom.us/j/81234567890')).toBe('zoom.us/j/81234567890');
    expect(linkKey('https://meet.google.com/abc-defg-hij')).not.toBe(linkKey('https://zoom.us/abc-defg-hij'));
  });

  describe('approval', () => {
    const form = (meetingId: string) => { const fd = new FormData(); fd.set('meetingId', meetingId); return fd; };
    const podManager = async (pod: string) => asUser(await prisma.user.create({ data: { email: `pm-${pod}@cadence.local`, name: `PM ${pod}`, role: 'POD_MANAGER', passwordHash: 'x', pods: { create: [{ podId: pod }] } } }), [pod]);

    it('waits for approval, and nothing from the past comes in', async () => {
      await importCalendarEvent(event());
      const m = await prisma.meeting.findUniqueOrThrow({ where: { calendarEventId: 'cal-1' } });
      expect(m.review).toBe('PENDING');
      // Not among the meetings until approved.
      expect(await prisma.meeting.count({ where: await meetingReadWhere(asUser(b.users.alisa, [b.pods.Alisa.id])) })).toBe(0);
      const past = await importCalendarEvent(event({ id: 'cal-past', startsAt: '2020-01-05T16:00:00.000Z', endsAt: '2020-01-05T16:45:00.000Z' }));
      expect(past).toEqual(expect.objectContaining({ result: 'skipped', reason: 'Already happened' }));
      expect(await prisma.meeting.count({ where: { calendarEventId: 'cal-past' } })).toBe(0);
    });

    it("is approved by the pod manager of that pod only, and then joins the other meetings", async () => {
      await importCalendarEvent(event());
      const m = await prisma.meeting.findUniqueOrThrow({ where: { calendarEventId: 'cal-1' } });
      // An FO of the pod, and the pod manager of another pod, cannot approve it.
      auth.user.mockResolvedValue(asUser(b.users.karson, [b.pods.Alisa.id]));
      expect((await approveMeetingAction(form(m.id))).ok).toBe(false);
      auth.user.mockResolvedValue(await podManager(b.pods.Leigh.id));
      expect((await approveMeetingAction(form(m.id))).ok).toBe(false);
      auth.user.mockResolvedValue(await podManager(b.pods.Alisa.id));
      expect((await approveMeetingAction(form(m.id))).ok).toBe(true);
      expect((await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).review).toBe('APPROVED');
      expect(await prisma.meeting.count({ where: await meetingReadWhere(asUser(b.users.alisa, [b.pods.Alisa.id])) })).toBe(1);
      // The same pod manager can still take it away after approving it.
      expect((await deleteMeetingAction(form(m.id))).ok).toBe(true);
      expect((await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).review).toBe('DISMISSED');
    });

    it('removed stays removed: the calendar never brings it back', async () => {
      await importCalendarEvent(event());
      const m = await prisma.meeting.findUniqueOrThrow({ where: { calendarEventId: 'cal-1' } });
      auth.user.mockResolvedValue(await podManager(b.pods.Alisa.id));
      expect((await deleteMeetingAction(form(m.id))).ok).toBe(true);
      const again = await importCalendarEvent(event({ title: 'Renamed', startsAt: '2027-01-07T16:00:00.000Z', endsAt: '2027-01-07T16:30:00.000Z' }));
      expect(again.result).toBe('skipped');
      const after = await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } });
      expect(after).toEqual(expect.objectContaining({ review: 'DISMISSED', title: 'Alisa and Nina: PHH' }));
      expect(await prisma.meeting.count()).toBe(1);
    });
  });
});
