import type { Role } from '@prisma/client';
import { prisma } from '../db';
import { addDays, dayOfWeek, diffDays, parseLocalDate, startOfLocalDay, todayIn, type LocalDate } from '../dates';
import { getSettings } from '../settings';
import { workspaceTimezone } from '../workspace';
import { ROLES_NEEDING_POD } from '../auth/rbac';
import { COUNTED_WHERE } from './counted';
import { meetingDay } from './day';
import { NUMBERING_STARTS } from './numbering-start';

/*
 * Meetings, gamified (owner, 21 Nov 2026: "people feel encouraged and motivated for meeting booked").
 * What scores is a meeting that counts (approved, or recorded: meetings/counted.ts), credited once to
 * the FO who booked it, by the month it took place in, in the workspace's time zone.
 *
 *   - Your month: meetings against the company target (Settings > Meetings), first meetings, a weekly
 *     streak, your best month, and badges for this month.
 *   - Pod race: pods ranked by meetings per FO, so a small pod races a big one fairly.
 *   - Top bookers: the top three by name, and each person's own rank. Nobody sees the full table
 *     (owner: "pods ranked, own rank").
 *   - Recent wins: the meetings booked lately, with a colleague's 👏.
 */

const FO_ROLES: Role[] = ['JUNIOR_FO', 'SENIOR_FO'];
const WINS_DAYS = 14;

export type ScoreBadge = { key: string; label: string; hint: string; earned: boolean };
export type Scoreboard = {
  month: { first: LocalDate; label: string; daysLeft: number };
  goal: number;
  /** The reader's own month; null for someone who books no meetings (an admin, Biz Ops). */
  me: null | {
    meetings: number; firstMeetings: number; waiting: number; streakWeeks: number;
    best: { count: number; label: string } | null;
    rank: number | null; of: number; badges: ScoreBadge[]; next: string;
  };
  /** The month of the pods a leader leads (`pods`: how many), or of everyone (`pods`: 0). */
  team: { meetings: number; firstMeetings: number; target: number; bookers: number; pods: number };
  top: { userId: string; name: string; meetings: number; firstMeetings: number; pod: string | null; you: boolean }[];
  pods: { id: string; name: string; meetings: number; fos: number; perFo: number; yours: boolean }[];
  wins: { meetingId: string; title: string; company: string | null; bookedBy: string; bookedById: string; number: number | null; at: Date; kudos: number; kudosByMe: boolean; mine: boolean }[];
};

const monthStart = (day: LocalDate): LocalDate => `${day.slice(0, 7)}-01`;
function nextMonth(first: LocalDate): LocalDate {
  const d = parseLocalDate(first);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
export const monthLabel = (first: LocalDate, withYear = true) => parseLocalDate(first).toLocaleString('en-US', { month: 'long', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
/** Monday of the week the day is in. */
const weekOf = (day: LocalDate) => addDays(day, -((dayOfWeek(day) + 6) % 7));

/** Weeks in a row, up to this one, with a meeting; a week not over yet does not break it. */
export function streakWeeks(days: LocalDate[], today: LocalDate): number {
  const weeks = new Set(days.map(weekOf));
  let week = weekOf(today);
  if (!weeks.has(week)) week = addDays(week, -7);
  let n = 0;
  while (weeks.has(week)) { n++; week = addDays(week, -7); }
  return n;
}

/** Rank by meetings, then first meetings; the same score shares a place. */
export function rankOf<T extends { meetings: number; firstMeetings: number }>(rows: T[], me: T): number {
  return 1 + rows.filter((r) => r.meetings > me.meetings || (r.meetings === me.meetings && r.firstMeetings > me.firstMeetings)).length;
}

export function badgesFor(s: { meetings: number; firstMeetings: number; bestWeek: number; streakWeeks: number; best: number | null }, goal: number): ScoreBadge[] {
  return [
    { key: 'board', label: 'On the board', hint: 'Book a meeting this month', earned: s.meetings >= 1 },
    { key: 'first', label: 'New relationship', hint: 'Book a first meeting with someone new', earned: s.firstMeetings >= 1 },
    { key: 'hattrick', label: 'Hat-trick', hint: 'Three meetings in one week', earned: s.bestWeek >= 3 },
    { key: 'streak', label: 'On a roll', hint: 'A meeting every week, three weeks running', earned: s.streakWeeks >= 3 },
    { key: 'goal', label: 'Goal reached', hint: `${goal} meetings this month`, earned: s.meetings >= goal },
    { key: 'best', label: 'Personal best', hint: s.best ? `Beat your best month (${s.best})` : 'Your first full month sets the bar', earned: s.best !== null && s.meetings > s.best },
  ];
}

export function nextWords(s: { meetings: number; best: { count: number; label: string } | null }, goal: number): string {
  if (s.meetings === 0) return `Book your first meeting of the month: the goal is ${goal}.`;
  if (s.meetings < goal) { const n = goal - s.meetings; return `${n} more ${n === 1 ? 'meeting reaches' : 'meetings reach'} this month's goal of ${goal}.`; }
  if (s.best && s.meetings <= s.best.count) { const n = s.best.count - s.meetings + 1; return `Goal reached. ${n} more ${n === 1 ? 'beats' : 'beat'} your best month (${s.best.count} in ${s.best.label}).`; }
  return 'Goal reached, and your best month yet. Keep it going.';
}

export async function scoreboard(user: { id: string; role: Role; podIds: string[] }, now = new Date()): Promise<Scoreboard> {
  const tz = workspaceTimezone();
  const today = todayIn(tz, now);
  const first = monthStart(today);
  const after = nextMonth(first);
  const [from, until] = [startOfLocalDay(first, tz), startOfLocalDay(after, tz)];
  const { meetings: { monthlyGoal: goal } } = await getSettings();

  const [month, people, pods, waiting, mine, wins] = await Promise.all([
    prisma.meeting.findMany({ where: { AND: [COUNTED_WHERE, { bookedById: { not: null }, occurredAt: { gte: from, lt: until } }] }, select: { bookedById: true, meetingNumber: true } }),
    prisma.user.findMany({ where: { active: true, role: { in: ROLES_NEEDING_POD } }, select: { id: true, name: true, role: true, pods: { where: { pod: { archived: false } }, select: { podId: true, pod: { select: { name: true } } } } } }),
    prisma.pod.findMany({ where: { archived: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.meeting.count({ where: { approval: 'WAITING', review: 'APPROVED', bookedById: user.id, occurredAt: { gte: from, lt: until } } }),
    // Your counted meetings since counting began: the streak, the best month, the best week.
    prisma.meeting.findMany({ where: { AND: [COUNTED_WHERE, { bookedById: user.id, occurredAt: { gte: startOfLocalDay(NUMBERING_STARTS, tz) } }] }, select: { occurredAt: true } }),
    prisma.meeting.findMany({
      where: { AND: [COUNTED_WHERE, { bookedById: { not: null }, createdAt: { gte: new Date(now.getTime() - WINS_DAYS * 86_400_000) } }] },
      orderBy: { createdAt: 'desc' }, take: 8,
      select: { id: true, title: true, companyName: true, meetingNumber: true, createdAt: true, bookedById: true, bookedBy: { select: { name: true } }, _count: { select: { kudos: true } }, kudos: { where: { userId: user.id }, select: { userId: true } } },
    }),
  ]);

  // Everyone who books, scored.
  const score = new Map(people.map((p) => [p.id, { meetings: 0, firstMeetings: 0 }]));
  for (const m of month) {
    const s = score.get(m.bookedById!);
    if (!s) continue;
    s.meetings++;
    if (m.meetingNumber === 1) s.firstMeetings++;
  }
  const rows = people.map((p) => ({ userId: p.id, name: p.name, pod: p.pods[0]?.pod.name ?? null, ...score.get(p.id)! }));
  const ordered = rows.filter((r) => r.meetings > 0).sort((a, b) => b.meetings - a.meetings || b.firstMeetings - a.firstMeetings || a.name.localeCompare(b.name));

  // Pods: meetings booked by anyone in the pod, per FO in it.
  const podRows = pods.map((pod) => {
    const members = people.filter((p) => p.pods.some((x) => x.podId === pod.id));
    const fos = members.filter((p) => FO_ROLES.includes(p.role)).length;
    const meetings = members.reduce((n, p) => n + (score.get(p.id)?.meetings ?? 0), 0);
    return { id: pod.id, name: pod.name, meetings, fos, perFo: Math.round((meetings / Math.max(1, fos)) * 10) / 10, yours: user.podIds.includes(pod.id) };
  }).filter((p) => p.fos > 0 || p.meetings > 0).sort((a, b) => b.perFo - a.perFo || b.meetings - a.meetings || a.name.localeCompare(b.name));

  // FOs see their own month; a Sales Leader or Pod Manager sees their pods'; admins and Biz Ops everyone's.
  const books = FO_ROLES.includes(user.role);
  let me: Scoreboard['me'] = null;
  if (books) {
    const own = score.get(user.id) ?? { meetings: 0, firstMeetings: 0 };
    const days = mine.map((m) => meetingDay(m.occurredAt));
    const byMonth = new Map<string, number>();
    for (const d of days) if (d < first) byMonth.set(monthStart(d), (byMonth.get(monthStart(d)) ?? 0) + 1);
    const bestEntry = [...byMonth.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];
    const best = bestEntry ? { count: bestEntry[1], label: monthLabel(bestEntry[0], false) } : null;
    const byWeek = new Map<string, number>();
    for (const d of days) if (d >= first && d < after) byWeek.set(weekOf(d), (byWeek.get(weekOf(d)) ?? 0) + 1);
    const streak = streakWeeks(days, today);
    me = {
      ...own, waiting, streakWeeks: streak, best,
      rank: own.meetings > 0 ? rankOf(ordered, own) : null, of: rows.length,
      badges: badgesFor({ ...own, bestWeek: Math.max(0, ...byWeek.values()), streakWeeks: streak, best: best?.count ?? null }, goal),
      next: nextWords({ meetings: own.meetings, best }, goal),
    };
  }

  const leads = !books && ROLES_NEEDING_POD.includes(user.role) && user.podIds.length > 0;
  const inTeam = (p: (typeof people)[number]) => !leads || p.pods.some((x) => user.podIds.includes(x.podId));
  const teamPeople = new Set(people.filter(inTeam).map((p) => p.id));
  const teamMonth = month.filter((m) => teamPeople.has(m.bookedById!));
  const foCount = people.filter((p) => inTeam(p) && FO_ROLES.includes(p.role)).length;
  return {
    month: { first, label: monthLabel(first, false), daysLeft: Math.max(0, diffDays(today, after)) },
    goal,
    me,
    team: { meetings: teamMonth.length, firstMeetings: teamMonth.filter((m) => m.meetingNumber === 1).length, target: goal * Math.max(1, foCount), bookers: ordered.filter((r) => teamPeople.has(r.userId)).length, pods: leads ? user.podIds.length : 0 },
    top: ordered.slice(0, 3).map((r) => ({ ...r, you: r.userId === user.id })),
    pods: podRows,
    wins: wins.map((w) => ({ meetingId: w.id, title: w.title, company: w.companyName, bookedBy: w.bookedBy?.name ?? 'Someone', bookedById: w.bookedById!, number: w.meetingNumber, at: w.createdAt, kudos: w._count.kudos, kudosByMe: w.kudos.length > 0, mine: w.bookedById === user.id })),
  };
}

/** What the booker reads right after saving a meeting (the celebration), or null when it is not theirs to celebrate. */
export async function celebrationFor(meetingId: string, user: { id: string; role: Role; podIds: string[] }, now = new Date()) {
  const m = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { bookedById: true, createdById: true, approval: true, review: true, meetingNumber: true, bookedBy: { select: { name: true } } } });
  if (!m || m.review !== 'APPROVED' || (m.bookedById !== user.id && m.createdById !== user.id)) return null;
  const forBooker = m.bookedById === user.id;
  if (m.approval === 'WAITING') return { counted: false as const, title: 'Meeting saved', line: 'It counts once it is approved. Add the recording link to count it now.', firstMeeting: false };
  if (!forBooker) return { counted: true as const, title: `Saved for ${m.bookedBy?.name ?? 'the FO who booked it'}`, line: 'It counts toward their month.', firstMeeting: m.meetingNumber === 1 };
  const s = await scoreboard(user, now);
  const title = m.meetingNumber === 1 ? 'A first meeting!' : 'Meeting booked!';
  if (!s.me) return { counted: true as const, title, line: `That makes ${s.team.meetings} this month${s.team.pods ? ` for your pod${s.team.pods === 1 ? '' : 's'}` : ''}.`, firstMeeting: m.meetingNumber === 1 };
  const n = s.me.meetings;
  return { counted: true as const, title, line: `That's ${n} meeting${n === 1 ? '' : 's'} this month. ${s.me.next}`.trim(), firstMeeting: m.meetingNumber === 1 };
}
