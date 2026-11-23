import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { badgesFor, celebrationFor, milestonesFor, nextWords, paceFor, paceWords, rankOf, scoreboard, streakWeeks } from '@/lib/meetings/scoreboard';
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

  it('badges read the month', () => {
    const earned = (s: Parameters<typeof badgesFor>[0]) => badgesFor(s, 8).filter((b) => b.earned).map((b) => b.key);
    expect(earned({ meetings: 0, firstMeetings: 0, bestWeek: 0, streakWeeks: 0, best: null })).toEqual([]);
    expect(earned({ meetings: 9, firstMeetings: 2, bestWeek: 3, streakWeeks: 3, best: 7 })).toEqual(['board', 'first', 'hattrick', 'streak', 'goal', 'best']);
  });

  it('the bar has named marks (quarter way, halfway, final stretch, the goal), and the next one is named', () => {
    const at = (target: number) => milestonesFor(target).map((m) => `${m.name} ${m.at}`);
    expect(at(90)).toEqual(['Quarter way 23', 'Halfway 45', 'Final stretch 68', 'Goal 90']);
    expect(at(10)).toEqual(['Quarter way 3', 'Halfway 5', 'Final stretch 8', 'Goal 10']);
    // A small goal never shows a mark twice, or at 0: the later name wins.
    expect(at(2)).toEqual(['Halfway 1', 'Goal 2']);
    expect(at(1)).toEqual(['Goal 1']);
    expect(nextWords({ meetings: 0, target: 10 })).toBe('Next milestone: Quarter way (3). 3 more to go.');
    expect(nextWords({ meetings: 9, target: 90 })).toBe('Next milestone: Quarter way (23). 14 more to go.');
    expect(nextWords({ meetings: 3, target: 10 })).toBe('Next milestone: Halfway (5). 2 more to go.');
    expect(nextWords({ meetings: 9, target: 10 })).toBe('Next milestone: the goal (10). 1 more to go.');
    expect(nextWords({ meetings: 10, target: 10 })).toBe('Goal reached. Every meeting from here is extra.');
    expect(nextWords({ meetings: 10, target: 10, best: { count: 11, label: 'October' } })).toBe('Goal reached. 2 more beat your best month (11 in October).');
    expect(nextWords({ meetings: 12, target: 10, best: { count: 11, label: 'October' } })).toBe('Goal reached, and your best month yet.');
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
    expect(s.me).toMatchObject({ pace: 3, status: 'On pace: right where the month should be today (3). 1 more to reach 4.', state: 'ahead', toGo: 1, perDay: 1 });
    expect(s.me).toMatchObject({ meetings: 3, firstMeetings: 2, waiting: 1, streakWeeks: 3, rank: 1, best: { count: 1, label: 'October' } });
    expect(s.me!.badges.filter((x) => x.earned).map((x) => x.key)).toEqual(['board', 'first', 'streak', 'best']);
    expect(s.me!.milestones.map((m) => m.at)).toEqual([1, 2, 3, 4]);
    expect(s.me!.next).toBe('Next milestone: the goal (4). 1 more to go.');
    // Karson's own week (Monday 16th to Friday 20th): K third on the 17th; Saturday and Sunday have none, so they are not shown.
    expect(s.week.days.map((d) => [d.label, d.count, d.today, d.future])).toEqual([['Mon', 0, false, false], ['Tue', 1, false, false], ['Wed', 0, false, false], ['Thu', 0, false, false], ['Fri', 0, true, false]]);
    expect(s.week.total).toBe(1);
    // October's best: Karson, the only one with a counted meeting then; Pod Alisa, his pod.
    expect(s.champions).toMatchObject({ label: 'October', first: '2026-10-01', last: '2026-10-31', performer: { userId: b.users.karson.id, meetings: 1, firstMeetings: 1, pod: 'Pod Alisa' }, pod: { name: 'Pod Alisa', meetings: 1 } });
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
    // Their week is their pod's: Karson's on the 17th.
    expect(lead.week.total).toBe(1);
    // Wins: counted meetings booked in the last two weeks, newest first; the waiting and declined ones are not wins.
    expect(s.wins.map((w) => w.title)).toEqual(['K third', 'A one', 'D one', 'K second']);
  });

  it('an admin sees the team, not a month of their own; someone not on the board has no rank', async () => {
    await meeting('D one', b.users.daniel.id, '2026-11-12', { meetingNumber: 1 });
    expect((await scoreboard({ id: b.users.ria.id, role: 'ADMIN', podIds: [] }, now)).me).toBeNull();
    const k = await scoreboard({ id: b.users.karson.id, role: 'JUNIOR_FO', podIds: [b.pods.Alisa.id] }, now);
    expect(k.me).toMatchObject({ meetings: 0, rank: null });
    // Nothing counted last month: no honours at all.
    expect(k.champions).toBeNull();
  });

  it("last month's best: most meetings, then most first meetings, then whoever got there first; the pod by its own target", async () => {
    // Daniel and Alisa both book two in October, one of them a first meeting each; Alisa's second came sooner.
    await meeting('D a', b.users.daniel.id, '2026-10-06', { meetingNumber: 1 }, 'person-01');
    await meeting('D b', b.users.daniel.id, '2026-10-28', { meetingNumber: 2 }, 'person-01');
    await meeting('A a', b.users.alisa.id, '2026-10-07', { meetingNumber: 1 }, 'person-02');
    await meeting('A b', b.users.alisa.id, '2026-10-14', { meetingNumber: 2 }, 'person-02');
    // Waiting and declined ones never win anything.
    await meeting('K waiting', b.users.karson.id, '2026-10-20', { approval: 'WAITING', sourceUrl: '' });
    await meeting('K w2', b.users.karson.id, '2026-10-21', { approval: 'WAITING', sourceUrl: '' });
    await meeting('K w3', b.users.karson.id, '2026-10-22', { approval: 'WAITING', sourceUrl: '' });
    const s = await scoreboard({ id: b.users.karson.id, role: 'JUNIOR_FO', podIds: [b.pods.Alisa.id] }, now);
    expect(s.champions!.performer).toMatchObject({ name: b.users.alisa.name, meetings: 2, firstMeetings: 1 });
    // Both pods booked 2 of their 8 (two FOs each): Alisa's reached it first.
    expect(s.champions!.pod).toMatchObject({ name: 'Pod Alisa', meetings: 2, fos: 2, perFo: 1 });
    expect(s.champions!.pod!.people[0]).toBe(b.users.alisa.name);
    // A first meeting breaks a tie on meetings.
    await meeting('D c', b.users.daniel.id, '2026-10-29', { meetingNumber: 1 }, 'person-03');
    await meeting('A c', b.users.alisa.id, '2026-10-15', { meetingNumber: 2 }, 'person-02');
    const t = await scoreboard({ id: b.users.karson.id, role: 'JUNIOR_FO', podIds: [b.pods.Alisa.id] }, now);
    expect(t.champions!.performer).toMatchObject({ name: b.users.daniel.name, meetings: 3, firstMeetings: 2 });
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
    // Saved for someone else while it waits: only they can add the link, so the words say so.
    const forKarson = await meeting('For K', b.users.karson.id, '2026-11-18', { approval: 'WAITING', sourceUrl: '', createdById: sam.id });
    expect(await celebrationFor(forKarson.id, { id: sam.id, role: 'SALES_LEADER', podIds: [b.pods.Alisa.id] }, now)).toMatchObject({ counted: false, line: `It counts once it is approved, or once ${b.users.karson.name} adds the recording link.` });
    // A meeting from last month counts there, not toward this month's bar.
    const october = await meeting('K October', b.users.karson.id, '2026-10-30', { meetingNumber: 2 });
    expect(await celebrationFor(october.id, karson, now)).toMatchObject({ counted: true, line: "It counts toward October 2026: that's 1 meeting there." });
  });

  it('the board holds up at the edges: unassigned sign-ins, ties, pods without FOs, someone switched off', async () => {
    // A first Microsoft sign-in waits as a Junior FO with no role assigned: not an FO, not on the board.
    await prisma.user.create({ data: { email: 'new@cadence.local', name: 'New Person', role: 'JUNIOR_FO', roleAssigned: false, passwordHash: 'x', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    // A pod with only its leader in it.
    const solo = await prisma.pod.create({ data: { name: 'Pod Solo', podOwnerValue: 'SOLO' } });
    const lead = await prisma.user.create({ data: { email: 'solo@cadence.local', name: 'Solo Leader', role: 'SALES_LEADER', passwordHash: 'x', pods: { create: [{ podId: solo.id }] } } });
    await meeting('Solo 1', lead.id, '2026-11-03', { meetingNumber: 1 }, 'person-05');
    // Karson and Daniel tie on two, one first each; Alisa and the solo leader tie on one first meeting.
    await meeting('K a', b.users.karson.id, '2026-11-03', { meetingNumber: 1 }, 'person-01');
    await meeting('K b', b.users.karson.id, '2026-11-04', { meetingNumber: 2 }, 'person-01');
    await meeting('D a', b.users.daniel.id, '2026-11-05', { meetingNumber: 1 }, 'person-02');
    await meeting('D b', b.users.daniel.id, '2026-11-06', { meetingNumber: 2 }, 'person-02');
    await meeting('A a', b.users.alisa.id, '2026-11-07', { meetingNumber: 1 }, 'person-03');
    const s = await scoreboard({ id: b.users.ria.id, role: 'ADMIN', podIds: [] }, now);
    expect(s.team.fos).toBe(5);
    expect(s.top.map((t) => [t.name, t.place])).toEqual([[b.users.daniel.name, 1], [b.users.karson.name, 1], [b.users.alisa.name, 3]]);
    expect(s.pods.map((p) => p.name)).not.toContain('Pod Solo');
    // October's best was switched off since: the honour goes to someone the board can open.
    await meeting('D Oct', b.users.daniel.id, '2026-10-10', { meetingNumber: 1 }, 'person-04');
    await meeting('D Oct 2', b.users.daniel.id, '2026-10-11', { meetingNumber: 2 }, 'person-04');
    await meeting('K Oct', b.users.karson.id, '2026-10-12', { meetingNumber: 1 }, 'person-06');
    await prisma.user.update({ where: { id: b.users.daniel.id }, data: { active: false } });
    const after = await scoreboard({ id: b.users.ria.id, role: 'ADMIN', podIds: [] }, now);
    expect(after.champions!.performer).toMatchObject({ name: b.users.karson.name, meetings: 1 });
  });
});
