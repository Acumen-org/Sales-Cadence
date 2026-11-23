import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { badgesFor, celebrationFor, nextWords, paceFor, paceWords, rankOf, scoreboard, streakWeeks } from '@/lib/meetings/scoreboard';
import { toggleKudosAction } from '@/lib/actions/meeting-kudos';
import { invalidateSettingsCache, saveSettingsSection } from '@/lib/settings';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * Meetings, gamified (owner, 21 Nov 2026): pods ranked, your own rank and the top three, one company
 * target. Only a meeting that counts (approved, or recorded) scores, for the FO who booked it.
 */
describe('the rules', () => {
  it('a streak counts weeks in a row with a meeting; this week not over yet does not break it', () => {
    expect(streakWeeks(['2026-11-03', '2026-11-10', '2026-11-17'], '2026-11-20')).toBe(3);
    expect(streakWeeks(['2026-11-03', '2026-11-10'], '2026-11-20')).toBe(2);
    expect(streakWeeks(['2026-11-03'], '2026-11-20')).toBe(0);
    expect(streakWeeks([], '2026-11-20')).toBe(0);
  });

  it('ranks by meetings then first meetings, and a tie shares the place', () => {
    const rows = [{ meetings: 5, firstMeetings: 1 }, { meetings: 5, firstMeetings: 3 }, { meetings: 2, firstMeetings: 2 }, { meetings: 5, firstMeetings: 1 }];
    expect(rows.map((r) => rankOf(rows, r))).toEqual([2, 1, 4, 2]);
  });

  it('the month says where it stands against today\'s pace, in the same words all month', () => {
    expect(paceFor(64, 23, 30)).toBe(49);
    expect(paceWords({ meetings: 8, target: 64, pace: 49, workdaysLeft: 6, lastLabel: '30 Nov' })).toBe('Behind pace by 41: 49 by today keeps the month on track. 56 more by 30 Nov is about 10 a working day.');
    expect(paceWords({ meetings: 52, target: 64, pace: 49, workdaysLeft: 6, lastLabel: '30 Nov' })).toBe('On pace: 3 ahead of where the month should be today (49). 12 more to reach 64.');
    expect(paceWords({ meetings: 49, target: 64, pace: 49, workdaysLeft: 6, lastLabel: '30 Nov' })).toBe('On pace: right where the month should be today (49). 15 more to reach 64.');
    expect(paceWords({ meetings: 70, target: 64, pace: 49, workdaysLeft: 6, lastLabel: '30 Nov' })).toBe('Target reached: 70 of 64. Every meeting from here is extra.');
  });

  it('badges and the next step read the month', () => {
    const earned = (s: Parameters<typeof badgesFor>[0]) => badgesFor(s, 8).filter((b) => b.earned).map((b) => b.key);
    expect(earned({ meetings: 0, firstMeetings: 0, bestWeek: 0, streakWeeks: 0, best: null })).toEqual([]);
    expect(earned({ meetings: 9, firstMeetings: 2, bestWeek: 3, streakWeeks: 3, best: 7 })).toEqual(['board', 'first', 'hattrick', 'streak', 'goal', 'best']);
    expect(nextWords({ meetings: 0, best: null }, 8)).toMatch(/first meeting of the month/);
    expect(nextWords({ meetings: 7, best: null }, 8)).toBe("1 more meeting reaches this month's goal of 8.");
    expect(nextWords({ meetings: 8, best: { count: 9, label: 'October' } }, 8)).toBe('Goal reached. 2 more beat your best month (9 in October).');
    expect(nextWords({ meetings: 10, best: { count: 9, label: 'October' } }, 8)).toMatch(/best month yet/);
  });
});

describe('the scoreboard', () => {
  let b: Basics;
  let sam: User;
  const now = new Date('2026-11-20T18:00:00Z');
  const as = (u: User, pods: string[]) => auth.user.mockResolvedValue({ ...u, podIds: pods, pods: [] });
  const meeting = (title: string, bookedById: string, day: string, extra: Record<string, unknown> = {}, person = 'person-01') => prisma.meeting.create({ data: {
    title, sourceUrl: 'https://acme.zoom.us/rec/share/x', occurredAt: new Date(`${day}T17:00:00Z`), createdAt: new Date(`${day}T18:00:00Z`), bookedById, createdById: bookedById, ...extra,
    attendees: { create: [{ personId: person, name: 'P', external: true, prospect: true }] },
  } });

  beforeEach(async () => {
    await resetDb(); b = await seedBasics(); invalidateSettingsCache();
    sam = await prisma.user.create({ data: { email: 'sam@cadence.local', name: 'Sam Leader', role: 'SALES_LEADER', passwordHash: 'x', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    await saveSettingsSection('meetings', { monthlyGoal: 4 });
  });

  it('counts only meetings that count, for the FO who booked them, this month', async () => {
    await meeting('K first', b.users.karson.id, '2026-11-03', { meetingNumber: 1 });
    await meeting('K second', b.users.karson.id, '2026-11-10', { meetingNumber: 2 }, 'person-01');
    await meeting('K third', b.users.karson.id, '2026-11-17', { meetingNumber: 1 }, 'person-02');
    await meeting('K waiting', b.users.karson.id, '2026-11-18', { approval: 'WAITING', sourceUrl: '' });
    await meeting('K declined', b.users.karson.id, '2026-11-18', { approval: 'DECLINED', review: 'DISMISSED' });
    await meeting('K October', b.users.karson.id, '2026-10-20', { meetingNumber: 1 });
    await meeting('D one', b.users.daniel.id, '2026-11-12', { meetingNumber: 1 }, 'person-03');
    await meeting('A one', b.users.alisa.id, '2026-11-13', { meetingNumber: 3 }, 'person-04');

    const s = await scoreboard({ id: b.users.karson.id, role: 'JUNIOR_FO', podIds: [b.pods.Alisa.id] }, now);
    expect(s.goal).toBe(4);
    // 20 November: day 20 of 30; Friday 20th plus the six weekdays after it.
    expect(s.month).toMatchObject({ first: '2026-11-01', last: '2026-11-30', label: 'November', daysLeft: 11, day: 20, days: 30, workdaysLeft: 7 });
    expect(s.me).toMatchObject({ pace: 3, status: 'On pace: right where the month should be today (3). 1 more to reach 4.' });
    expect(s.me).toMatchObject({ meetings: 3, firstMeetings: 2, waiting: 1, streakWeeks: 3, rank: 1, best: { count: 1, label: 'October' } });
    expect(s.me!.badges.filter((x) => x.earned).map((x) => x.key)).toEqual(['board', 'first', 'streak', 'best']);
    expect(s.me!.next).toBe("1 more meeting reaches this month's goal of 4.");
    // The top three by name; the full table is never sent. Daniel's one is a first meeting, so he is ahead of Alisa.
    expect(s.top.map((t) => [t.name, t.meetings, t.you])).toEqual([[b.users.karson.name, 3, true], [b.users.daniel.name, 1, false], [b.users.alisa.name, 1, false]]);
    // Pods per FO: Alisa's has Alisa (Senior FO) and Karson (Junior FO): 4 meetings / 2; Leigh's 1 / 2.
    expect(s.pods.map((p) => [p.name, p.meetings, p.fos, p.perFo, p.yours]).slice(0, 2)).toEqual([['Pod Alisa', 4, 2, 2, true], ['Pod Leigh', 1, 2, 0.5, false]]);
    // Five Junior and Senior FOs at 4 each: a target of 20, 13 by today (day 20 of 30).
    expect(s.team).toMatchObject({ meetings: 5, firstMeetings: 3, bookers: 3, pods: 0, fos: 5, target: 20, waiting: 1, pace: 13 });
    expect(s.team.status).toBe('Behind pace by 8: 13 by today keeps the month on track. 15 more by 30 Nov is about 3 a working day.');
    expect(s.pods[0]).toMatchObject({ name: 'Pod Alisa', target: 8, share: 0.5 });
    // A Sales Leader sees their pod's month, not one of their own.
    const lead = await scoreboard({ id: sam.id, role: 'SALES_LEADER', podIds: [b.pods.Alisa.id] }, now);
    expect(lead.me).toBeNull();
    expect(lead.team).toMatchObject({ meetings: 4, firstMeetings: 2, bookers: 2, pods: 1, target: 8 });
    // Wins: counted meetings booked in the last two weeks, newest first; the waiting and declined ones are not wins.
    expect(s.wins.map((w) => w.title)).toEqual(['K third', 'A one', 'D one', 'K second']);
  });

  it('an admin sees the team, not a month of their own; someone not on the board has no rank', async () => {
    await meeting('D one', b.users.daniel.id, '2026-11-12', { meetingNumber: 1 });
    expect((await scoreboard({ id: b.users.ria.id, role: 'ADMIN', podIds: [] }, now)).me).toBeNull();
    const k = await scoreboard({ id: b.users.karson.id, role: 'JUNIOR_FO', podIds: [b.pods.Alisa.id] }, now);
    expect(k.me).toMatchObject({ meetings: 0, rank: null });
  });

  it('a colleague cheers a meeting once: the booker hears of it once, never for their own or a waiting one', async () => {
    const m = await meeting('K first', b.users.karson.id, '2026-11-12', { meetingNumber: 1 });
    const waiting = await meeting('K waiting', b.users.karson.id, '2026-11-18', { approval: 'WAITING', sourceUrl: '' });
    as(sam, [b.pods.Alisa.id]);
    expect(await toggleKudosAction(m.id)).toEqual({ ok: true, kudos: 1, mine: true });
    expect(await toggleKudosAction(m.id)).toEqual({ ok: true, kudos: 0, mine: false });
    expect(await toggleKudosAction(m.id)).toEqual({ ok: true, kudos: 1, mine: true });
    expect(await prisma.notification.count({ where: { userId: b.users.karson.id, kind: 'meeting_kudos' } })).toBe(1);
    expect(await toggleKudosAction(waiting.id)).toMatchObject({ ok: false });
    as(b.users.karson, [b.pods.Alisa.id]);
    expect(await toggleKudosAction(m.id)).toMatchObject({ ok: false, error: expect.stringContaining('your own') });
    const s = await scoreboard({ id: sam.id, role: 'SALES_LEADER', podIds: [b.pods.Alisa.id] }, now);
    expect(s.wins.find((w) => w.meetingId === m.id)).toMatchObject({ kudos: 1, kudosByMe: true, mine: false });
  });

  it('the celebration after saving says what it did for the month, or how to make it count', async () => {
    const m = await meeting('K first', b.users.karson.id, '2026-11-20', { meetingNumber: 1 });
    const waiting = await meeting('K waiting', b.users.karson.id, '2026-11-19', { approval: 'WAITING', sourceUrl: '' });
    const karson = { id: b.users.karson.id, role: 'JUNIOR_FO' as const, podIds: [b.pods.Alisa.id] };
    expect(await celebrationFor(m.id, karson, now)).toMatchObject({ counted: true, firstMeeting: true, title: 'A first meeting!', line: expect.stringContaining("That's 1 meeting this month.") });
    expect(await celebrationFor(waiting.id, karson, now)).toMatchObject({ counted: false, line: expect.stringContaining('Add the recording link') });
    expect(await celebrationFor(m.id, { id: b.users.daniel.id, role: 'JUNIOR_FO', podIds: [] }, now)).toBeNull();
  });
});
