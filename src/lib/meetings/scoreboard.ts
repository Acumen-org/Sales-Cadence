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
 *   - Your month: meetings against the company target (Settings > Meetings) on a bar with a quarter,
 *     half and three quarters marked, and the next mark in words (owner, 23 Nov 2026).
 *   - The team's month the same way, with this week's days under it: a goal that is always winnable.
 *   - Last month's best: the top performer and the top pod, as an honour (owner, 23 Nov 2026).
 *   - Pod race: pods ranked by meetings per FO, so a small pod races a big one fairly.
 *   - Top bookers: the top three by name, and each person's own rank. Nobody sees the full table
 *     (owner: "pods ranked, own rank").
 *   - Recent wins: the meetings booked lately, with a colleague's cheer.
 */

const FO_ROLES: Role[] = ['JUNIOR_FO', 'SENIOR_FO'];
const WINS_DAYS = 14;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type ScoreBadge = { key: string; label: string; hint: string; earned: boolean };
/**
 * How a month stands: pace is where it should be by today, state reached, ahead or behind it,
 * toGo and perDay what is left and about how many a working day; status says it in one sentence.
 * milestones are the marks on the bar (a quarter, half, three quarters, the target) and next names
 * the next one to reach, in words.
 */
export type MonthProgress = { pace: number; status: string; state: 'reached' | 'ahead' | 'behind'; toGo: number; perDay: number; milestones: Milestone[]; next: string };
/** One day of this week: Monday to Friday always, Saturday and Sunday only when a meeting is on them. */
export type WeekDay = { day: LocalDate; label: string; count: number; today: boolean; future: boolean };
export type Scoreboard = {
  /** `day` of `days` is today; `workdaysLeft` counts today, Monday to Friday. */
  month: { first: LocalDate; last: LocalDate; label: string; daysLeft: number; day: number; days: number; workdaysLeft: number };
  goal: number;
  /** The reader's own month; null for someone who books no meetings (an admin, Biz Ops). */
  me: null | {
    meetings: number; firstMeetings: number; waiting: number; streakWeeks: number;
    best: { count: number; label: string } | null;
    rank: number | null; of: number; badges: ScoreBadge[];
  } & MonthProgress;
  /** The month of the pods a leader leads (`pods`: how many), or of everyone (`pods`: 0). `fos`: Junior and Senior FOs in it. */
  team: { meetings: number; firstMeetings: number; target: number; bookers: number; pods: number; fos: number; waiting: number } & MonthProgress;
  /** This week's meetings, Monday first, for the month card's people (an FO's own; a leader's or admin's team); `total` is the sum of the days shown. */
  week: { days: WeekDay[]; total: number };
  /**
   * Last month's best, for everyone to see: the FO who booked the most, and the pod that booked the
   * most of its own target (as in the pod race). Null when nothing counted last month.
   */
  champions: null | {
    label: string; first: LocalDate; last: LocalDate;
    performer: { userId: string; name: string; meetings: number; firstMeetings: number; pod: string | null };
    pod: null | { id: string; name: string; meetings: number; fos: number; perFo: number; people: string[] };
  };
  top: { userId: string; name: string; meetings: number; firstMeetings: number; pod: string | null; place: number; you: boolean }[];
  /** `target`: the pod's FOs times the target; `share`: how much of it is booked (0 to 1+). */
  pods: { id: string; name: string; meetings: number; fos: number; perFo: number; target: number; share: number; yours: boolean }[];
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

/** Where a month should be by today, of `days`, to reach the target by its last day. */
export const paceFor = (target: number, day: number, days: number) => Math.round((target * day) / Math.max(1, days));

/**
 * One sentence on how the month is going, the same shape all month with the numbers changing:
 * reached, ahead of pace, or behind it and what it takes a working day to catch up.
 */
export function paceWords(s: { meetings: number; target: number; pace: number; workdaysLeft: number; lastLabel: string }): string {
  if (s.meetings >= s.target) return `Target reached: ${s.meetings} of ${s.target}. Every meeting from here is extra.`;
  const left = s.target - s.meetings;
  if (s.meetings >= s.pace) return `On pace: ${s.meetings - s.pace === 0 ? 'right where' : `${s.meetings - s.pace} ahead of where`} the month should be today (${s.pace}). ${left} more to reach ${s.target}.`;
  const perDay = Math.ceil(left / Math.max(1, s.workdaysLeft));
  return `Behind pace by ${s.pace - s.meetings}: ${s.pace} by today keeps the month on track. ${left} more by ${s.lastLabel} is about ${perDay} a working day.`;
}

export type Milestone = { at: number; name: string };
const MILESTONE_NAMES: [number, string][] = [[0.25, 'Quarter way'], [0.5, 'Halfway'], [0.75, 'Final stretch'], [1, 'Goal']];

/**
 * The named marks on the bar (owner, 23 Nov 2026: a mark should mean something, not be "a random
 * number like 23"): a quarter of the way, halfway, the final stretch, the goal. Never at 0; a small
 * goal that rounds two marks to one number keeps the later name.
 */
export function milestonesFor(target: number): Milestone[] {
  const byNumber = new Map<number, string>();
  for (const [f, name] of MILESTONE_NAMES) byNumber.set(Math.max(1, Math.round(target * f)), name);
  return [...byNumber.entries()].map(([at, name]) => ({ at, name }));
}

/**
 * The next mark, in words: the same sentence all month with the numbers changing. Past the goal,
 * an FO hears about their best month (`best`: null for the team, or before they have one).
 */
export function nextWords(s: { meetings: number; target: number; best?: { count: number; label: string } | null }): string {
  const { meetings, target } = s;
  if (meetings < target) {
    const mark = milestonesFor(target).find((m) => m.at > meetings)!;
    const left = mark.at - meetings;
    return `Next milestone: ${mark.name === 'Goal' ? 'the goal' : mark.name} (${mark.at}). ${left} more to go.`;
  }
  if (s.best && meetings <= s.best.count) { const n = s.best.count - meetings + 1; return `Goal reached. ${n} more ${n === 1 ? 'beats' : 'beat'} your best month (${s.best.count} in ${s.best.label}).`; }
  if (s.best) return 'Goal reached, and your best month yet.';
  return 'Goal reached. Every meeting from here is extra.';
}

/**
 * Rank for last month's honour: most meetings, then most first meetings, then whoever got there
 * first (when their last meeting of the month was saved), and only then, so it never flips between
 * reloads, the id.
 */
const honourOrder = <T extends { key: string; meetings: number; firstMeetings: number; reachedAt: number }>(a: T, b: T) =>
  b.meetings - a.meetings || b.firstMeetings - a.firstMeetings || a.reachedAt - b.reachedAt || a.key.localeCompare(b.key);

export async function scoreboard(user: { id: string; role: Role; podIds: string[] }, now = new Date()): Promise<Scoreboard> {
  const tz = workspaceTimezone();
  const today = todayIn(tz, now);
  const first = monthStart(today);
  const after = nextMonth(first);
  const [from, until] = [startOfLocalDay(first, tz), startOfLocalDay(after, tz)];
  const { meetings: { monthlyGoal: goal } } = await getSettings();
  // This week, Monday to Sunday, whichever months it straddles; and last month, for its honours.
  const monday = weekOf(today);
  const lastFirst = monthStart(addDays(first, -1));

  const [month, people, pods, waitingRows, mine, wins, weekRows, lastMonth] = await Promise.all([
    prisma.meeting.findMany({ where: { AND: [COUNTED_WHERE, { bookedById: { not: null }, occurredAt: { gte: from, lt: until } }] }, select: { bookedById: true, meetingNumber: true, occurredAt: true } }),
    // Who books: active, in a pod role, and given that role by an admin (a first Microsoft sign-in
    // waits as a Junior FO with no role assigned, and is not an FO yet).
    prisma.user.findMany({ where: { active: true, roleAssigned: true, role: { in: ROLES_NEEDING_POD } }, select: { id: true, name: true, role: true, pods: { where: { pod: { archived: false } }, select: { podId: true, pod: { select: { name: true } } } } } }),
    prisma.pod.findMany({ where: { archived: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    // Waiting for approval this month: they count once approved.
    prisma.meeting.findMany({ where: { approval: 'WAITING', review: 'APPROVED', occurredAt: { gte: from, lt: until } }, select: { bookedById: true } }),
    // Your counted meetings since counting began: the streak, the best month, the best week.
    prisma.meeting.findMany({ where: { AND: [COUNTED_WHERE, { bookedById: user.id, occurredAt: { gte: startOfLocalDay(NUMBERING_STARTS, tz) } }] }, select: { occurredAt: true } }),
    prisma.meeting.findMany({
      where: { AND: [COUNTED_WHERE, { bookedById: { not: null }, createdAt: { gte: new Date(now.getTime() - WINS_DAYS * 86_400_000) } }] },
      orderBy: { createdAt: 'desc' }, take: 10,
      select: { id: true, title: true, companyName: true, meetingNumber: true, createdAt: true, bookedById: true, bookedBy: { select: { name: true } }, _count: { select: { kudos: true } }, kudos: { where: { userId: user.id }, select: { userId: true } } },
    }),
    prisma.meeting.findMany({ where: { AND: [COUNTED_WHERE, { bookedById: { not: null }, occurredAt: { gte: startOfLocalDay(monday, tz), lt: startOfLocalDay(addDays(monday, 7), tz) } }] }, select: { bookedById: true, occurredAt: true } }),
    prisma.meeting.findMany({ where: { AND: [COUNTED_WHERE, { bookedById: { not: null }, occurredAt: { gte: startOfLocalDay(lastFirst, tz), lt: from } }] }, select: { bookedById: true, meetingNumber: true, createdAt: true } }),
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

  // The calendar: today is `day` of `days`; working days left count today.
  const last = addDays(after, -1);
  const days = diffDays(first, after);
  const day = diffDays(first, today) + 1;
  let workdaysLeft = 0;
  for (let d = today; d <= last; d = addDays(d, 1)) if (dayOfWeek(d) >= 1 && dayOfWeek(d) <= 5) workdaysLeft++;
  const lastLabel = `${Number(last.slice(8))} ${monthLabel(first, false).slice(0, 3)}`;
  const progress = (meetings: number, target: number, best: { count: number; label: string } | null = null): MonthProgress => {
    const pace = paceFor(target, day, days);
    const toGo = Math.max(0, target - meetings);
    return {
      pace, status: paceWords({ meetings, target, pace, workdaysLeft, lastLabel }), state: meetings >= target ? 'reached' : meetings >= pace ? 'ahead' : 'behind',
      toGo, perDay: toGo ? Math.ceil(toGo / Math.max(1, workdaysLeft)) : 0, milestones: milestonesFor(target), next: nextWords({ meetings, target, best }),
    };
  };

  // Pods: meetings booked by anyone in the pod, against its own target (its FOs times the target).
  const podRows = pods.map((pod) => {
    const members = people.filter((p) => p.pods.some((x) => x.podId === pod.id));
    const fos = members.filter((p) => FO_ROLES.includes(p.role)).length;
    const meetings = members.reduce((n, p) => n + (score.get(p.id)?.meetings ?? 0), 0);
    const target = goal * Math.max(1, fos);
    return { id: pod.id, name: pod.name, meetings, fos, perFo: Math.round((meetings / Math.max(1, fos)) * 10) / 10, target, share: meetings / target, yours: user.podIds.includes(pod.id) };
  // A pod with no FOs has no target to race against (a leader's own meetings would read 125%).
  }).filter((p) => p.fos > 0).sort((a, b) => b.share - a.share || b.meetings - a.meetings || a.name.localeCompare(b.name));

  // FOs see their own month; a Sales Leader or Pod Manager sees their pods'; admins and Biz Ops everyone's.
  const books = FO_ROLES.includes(user.role);
  let me: Scoreboard['me'] = null;
  if (books) {
    const own = score.get(user.id) ?? { meetings: 0, firstMeetings: 0 };
    const booked = mine.map((m) => meetingDay(m.occurredAt));
    const byMonth = new Map<string, number>();
    for (const d of booked) if (d < first) byMonth.set(monthStart(d), (byMonth.get(monthStart(d)) ?? 0) + 1);
    const bestEntry = [...byMonth.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];
    const best = bestEntry ? { count: bestEntry[1], label: monthLabel(bestEntry[0], false) } : null;
    const byWeek = new Map<string, number>();
    for (const d of booked) if (d >= first && d < after) byWeek.set(weekOf(d), (byWeek.get(weekOf(d)) ?? 0) + 1);
    const streak = streakWeeks(booked, today);
    me = {
      ...own, waiting: waitingRows.filter((w) => w.bookedById === user.id).length, streakWeeks: streak, best,
      ...progress(own.meetings, goal, best),
      rank: own.meetings > 0 ? rankOf(ordered, own) : null, of: rows.length,
      badges: badgesFor({ ...own, bestWeek: Math.max(0, ...byWeek.values()), streakWeeks: streak, best: best?.count ?? null }, goal),
    };
  }

  const leads = !books && ROLES_NEEDING_POD.includes(user.role) && user.podIds.length > 0;
  const inTeam = (p: (typeof people)[number]) => !leads || p.pods.some((x) => user.podIds.includes(x.podId));
  const teamPeople = new Set(people.filter(inTeam).map((p) => p.id));
  const teamMonth = month.filter((m) => teamPeople.has(m.bookedById!));
  const foCount = people.filter((p) => inTeam(p) && FO_ROLES.includes(p.role)).length;
  const teamTarget = goal * Math.max(1, foCount);

  // This week's days for the same people as the month card: an FO's own, or the team's.
  const weekPeople = books ? new Set([user.id]) : teamPeople;
  const perDay = new Map<LocalDate, number>();
  for (const m of weekRows) if (weekPeople.has(m.bookedById!)) perDay.set(meetingDay(m.occurredAt), (perDay.get(meetingDay(m.occurredAt)) ?? 0) + 1);
  const weekDays: WeekDay[] = Array.from({ length: 7 }, (_, i) => addDays(monday, i))
    .filter((d, i) => i < 5 || (perDay.get(d) ?? 0) > 0)
    .map((d) => ({ day: d, label: DAY_NAMES[dayOfWeek(d)], count: perDay.get(d) ?? 0, today: d === today, future: d > today }));

  // Last month's best, from the same people the board scores, so the winner's name opens their
  // meetings. Pods are today's pods, with the people in them today.
  let champions: Scoreboard['champions'] = null;
  const byFo = new Map<string, { key: string; userId: string; name: string; meetings: number; firstMeetings: number; reachedAt: number }>();
  for (const m of lastMonth) {
    const person = people.find((p) => p.id === m.bookedById);
    if (!person) continue;
    const row = byFo.get(person.id) ?? { key: person.id, userId: person.id, name: person.name, meetings: 0, firstMeetings: 0, reachedAt: 0 };
    row.meetings++;
    if (m.meetingNumber === 1) row.firstMeetings++;
    row.reachedAt = Math.max(row.reachedAt, m.createdAt.getTime());
    byFo.set(row.userId, row);
  }
  if (byFo.size) {
    const top = [...byFo.values()].sort(honourOrder)[0];
    const lastPods = pods.map((pod) => {
      const members = people.filter((p) => p.pods.some((x) => x.podId === pod.id));
      const fos = members.filter((p) => FO_ROLES.includes(p.role)).length;
      const theirs = members.map((p) => byFo.get(p.id)).filter((r): r is NonNullable<typeof r> => !!r);
      const meetings = theirs.reduce((n, r) => n + r.meetings, 0);
      return {
        key: pod.id, id: pod.id, name: pod.name, meetings, fos, perFo: Math.round((meetings / Math.max(1, fos)) * 10) / 10,
        share: meetings / (goal * Math.max(1, fos)), firstMeetings: theirs.reduce((n, r) => n + r.firstMeetings, 0), reachedAt: Math.max(0, ...theirs.map((r) => r.reachedAt)),
        // Whoever booked most last month first, then the rest of the pod.
        people: members.filter((p) => FO_ROLES.includes(p.role) || byFo.has(p.id)).sort((a, b) => (byFo.get(b.id)?.meetings ?? 0) - (byFo.get(a.id)?.meetings ?? 0) || a.name.localeCompare(b.name)).map((p) => p.name),
      };
    }).filter((p) => p.meetings > 0 && p.fos > 0).sort((a, b) => b.share - a.share || honourOrder(a, b));
    const bestPod = lastPods[0];
    champions = {
      label: monthLabel(lastFirst, false), first: lastFirst, last: addDays(first, -1),
      performer: { userId: top.userId, name: top.name, meetings: top.meetings, firstMeetings: top.firstMeetings, pod: people.find((p) => p.id === top.userId)?.pods[0]?.pod.name ?? null },
      pod: bestPod ? { id: bestPod.id, name: bestPod.name, meetings: bestPod.meetings, fos: bestPod.fos, perFo: bestPod.perFo, people: bestPod.people } : null,
    };
  }

  return {
    month: { first, last, label: monthLabel(first, false), daysLeft: Math.max(0, diffDays(today, after)), day, days, workdaysLeft },
    goal,
    me,
    team: {
      meetings: teamMonth.length, firstMeetings: teamMonth.filter((m) => m.meetingNumber === 1).length, target: teamTarget,
      bookers: ordered.filter((r) => teamPeople.has(r.userId)).length, pods: leads ? user.podIds.length : 0, fos: foCount,
      waiting: waitingRows.filter((w) => w.bookedById && teamPeople.has(w.bookedById)).length,
      ...progress(teamMonth.length, teamTarget),
    },
    week: { days: weekDays, total: weekDays.reduce((n, d) => n + d.count, 0) },
    champions,
    // Places as the rank has them: two tied for first are both first.
    top: ordered.slice(0, 3).map((r) => ({ ...r, place: rankOf(ordered, r), you: r.userId === user.id })),
    pods: podRows,
    wins: wins.map((w) => ({ meetingId: w.id, title: w.title, company: w.companyName, bookedBy: w.bookedBy?.name ?? 'Someone', bookedById: w.bookedById!, number: w.meetingNumber, at: w.createdAt, kudos: w._count.kudos, kudosByMe: w.kudos.length > 0, mine: w.bookedById === user.id })),
  };
}

/** What the booker reads right after saving a meeting (the celebration), or null when it is not theirs to celebrate. */
export async function celebrationFor(meetingId: string, user: { id: string; role: Role; podIds: string[] }, now = new Date()) {
  const m = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { bookedById: true, createdById: true, approval: true, review: true, meetingNumber: true, occurredAt: true, bookedBy: { select: { name: true } } } });
  if (!m || m.review !== 'APPROVED' || (m.bookedById !== user.id && m.createdById !== user.id)) return null;
  const forBooker = m.bookedById === user.id;
  const booker = m.bookedBy?.name ?? 'the FO who booked it';
  // Only the FO named in Booked by can add the link (approval.ts, mayAddRecordingLink).
  if (m.approval === 'WAITING') return { counted: false as const, title: 'Meeting saved', line: forBooker ? 'It counts once it is approved. Add the recording link to count it now.' : `It counts once it is approved, or once ${booker} adds the recording link.`, firstMeeting: false };
  const tz = workspaceTimezone();
  const itsMonth = monthStart(meetingDay(m.occurredAt));
  const thisMonth = itsMonth === monthStart(todayIn(tz, now));
  if (!forBooker) return { counted: true as const, title: `Saved for ${booker}`, line: thisMonth ? 'It counts toward their month.' : `It counts toward their ${monthLabel(itsMonth)}.`, firstMeeting: m.meetingNumber === 1 };
  const title = m.meetingNumber === 1 ? 'A first meeting!' : 'Meeting booked!';
  // A meeting from another month counts there, not toward this month's bar.
  if (!thisMonth) {
    const there = await prisma.meeting.count({ where: { AND: [COUNTED_WHERE, { bookedById: user.id, occurredAt: { gte: startOfLocalDay(itsMonth, tz), lt: startOfLocalDay(nextMonth(itsMonth), tz) } }] } });
    return { counted: true as const, title, line: `It counts toward ${monthLabel(itsMonth)}: that's ${there} meeting${there === 1 ? '' : 's'} there.`, firstMeeting: m.meetingNumber === 1 };
  }
  const s = await scoreboard(user, now);
  if (!s.me) return { counted: true as const, title, line: `That makes ${s.team.meetings} this month${s.team.pods ? ` for your pod${s.team.pods === 1 ? '' : 's'}` : ''}.`, firstMeeting: m.meetingNumber === 1 };
  const n = s.me.meetings;
  return { counted: true as const, title, line: `That's ${n} meeting${n === 1 ? '' : 's'} this month. ${s.me.next}`.trim(), firstMeeting: m.meetingNumber === 1 };
}
