import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isAdmin, isSeniorFo, visiblePodIds } from './auth/rbac';
import { todayIn, weekRange, type LocalDate } from './dates';
import { cachedPersonName } from './person-cache';
import { getSettings, isExternalEmail } from './settings';
import { taskScopeWhere, type TaskChannel } from './tasks-query';
import { myOwnershipCounts } from './accounts-query';

export type HomeData = Awaited<ReturnType<typeof buildHome>>;

/**
 * People this user is responsible for: owned in Twenty, in one of their pods (seniors), or
 * enrolled with them as the FO. Admins see everyone, since they supervise.
 */
export async function assignedPersonWhere(user: SessionUser): Promise<Prisma.PersonCacheWhereInput> {
  if (isAdmin(user)) return {};
  const or: Prisma.PersonCacheWhereInput[] = [{ enrollments: { some: { foUserId: user.id } } }];
  if (user.twentyMemberId) or.push({ ownerMemberId: user.twentyMemberId });
  if (isSeniorFo(user)) {
    const podIds = visiblePodIds(user) ?? [];
    if (podIds.length) {
      const values = (await prisma.pod.findMany({ where: { id: { in: podIds } }, select: { podOwnerValue: true } })).map((p) => p.podOwnerValue);
      if (values.length) or.push({ podOwner: { in: values } });
    }
  }
  return { OR: or };
}

/**
 * Home for the signed-in user: today's work by channel, what they own, and this week's replies
 * and booked meetings. Weeks run Sunday to Saturday in the user's own timezone.
 */
export async function buildHome(user: SessionUser, now = new Date()) {
  const today = todayIn(user.timezone, now);
  const week = weekRange(today, user.timezone);
  const settings = await getSettings();
  const mineTasks: Prisma.TaskWhereInput = { AND: [taskScopeWhere(user), { foUserId: user.id }] };

  const [mine, ownership, replies, meetings, team, needsReview] = await Promise.all([
    myOpenTasks(mineTasks, today),
    myOwnershipCounts(user),
    repliesThisWeek(user, week, 25),
    meetingsThisWeek(user, week, settings.rules.internalDomains, 25),
    teamThisWeek(user, today, week),
    isAdmin(user) ? prisma.activityEvent.count({ where: { needsReview: true } }) : Promise.resolve(0),
  ]);
  const byChannel = mine;
  const peopleToReachToday = mine.peopleToday;

  const total = (m: Record<TaskChannel, number>) => Object.values(m).reduce((a, b) => a + b, 0);

  return {
    today,
    week,
    my: {
      today: byChannel.today,
      overdue: byChannel.overdue,
      upcoming: byChannel.upcoming,
      todayTotal: total(byChannel.today),
      overdueTotal: total(byChannel.overdue),
      peopleToReachToday,
      accounts: ownership.accounts,
      relationships: ownership.relationships,
    },
    replies,
    meetings,
    team,
    needsReview,
  };
}

const emptyChannels = (): Record<TaskChannel, number> => ({ CALL: 0, EMAIL: 0, LINKEDIN: 0 });

function channelOfAction(action: string): TaskChannel {
  if (action === 'CALL') return 'CALL';
  if (action === 'EMAIL') return 'EMAIL';
  return 'LINKEDIN';
}

/**
 * All of this FO's open tasks in one query, bucketed in memory.
 * One indexed read instead of nine counts: on a single-CPU box that difference is the page.
 */
async function myOpenTasks(base: Prisma.TaskWhereInput, today: LocalDate) {
  const rows = await prisma.task.findMany({
    where: { AND: [base, { state: 'PENDING' }] },
    select: { action: true, dueDate: true, snoozedTo: true, enrollment: { select: { personId: true } } },
  });
  const todayC = emptyChannels();
  const overdueC = emptyChannels();
  const upcomingC = emptyChannels();
  const peopleToday = new Set<string>();
  for (const r of rows) {
    const due = r.snoozedTo ?? r.dueDate;
    const ch = channelOfAction(r.action);
    if (due === today) {
      todayC[ch] += 1;
      peopleToday.add(r.enrollment.personId);
    } else if (due < today) overdueC[ch] += 1;
    else upcomingC[ch] += 1;
  }
  return { today: todayC, overdue: overdueC, upcoming: upcomingC, peopleToday: peopleToday.size };
}

export type ReplyRow = { id: string; personId: string; name: string; company: string | null; at: Date; summary: string; foName: string | null };

/**
 * Replies to deal with this week: inbound emails Twenty synced for people this user is
 * responsible for. This is what "someone assigned to a BD replied" looks like once the reply has
 * reached the CRM contact and Cadence has ingested it.
 */
export async function repliesThisWeek(user: SessionUser, week: { fromInstant: Date; toInstant: Date }, take: number): Promise<{ rows: ReplyRow[]; total: number }> {
  const personWhere = await assignedPersonWhere(user);
  const where: Prisma.TouchWhereInput = {
    direction: 'INBOUND',
    channel: 'EMAIL',
    occurredAt: { gte: week.fromInstant, lt: week.toInstant },
    person: personWhere,
  };
  const [rows, total] = await Promise.all([
    prisma.touch.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take,
      include: { person: { select: { id: true, firstName: true, lastName: true, companyName: true, enrollments: { orderBy: { createdAt: 'desc' }, take: 1, select: { fo: { select: { name: true } } } } } } },
    }),
    prisma.touch.count({ where }),
  ]);
  return {
    total,
    rows: rows.map((t) => ({
      id: t.id,
      personId: t.person.id,
      name: cachedPersonName(t.person),
      company: t.person.companyName,
      at: t.occurredAt,
      summary: t.summary,
      foName: t.person.enrollments[0]?.fo.name ?? null,
    })),
  };
}

export type MeetingRow = { id: string; title: string; at: Date; company: string | null; href: string; externals: number; source: 'meeting' | 'sequence' };

/**
 * Meetings booked this week. A meeting counts when someone outside our own domains is on it:
 * that is how a real prospect meeting is told apart from an internal one. Recorded meetings
 * (with their attendees) and sequence-detected meetings are both included.
 */
export async function meetingsThisWeek(
  user: SessionUser,
  week: { fromInstant: Date; toInstant: Date },
  internalDomains: string[],
  take: number,
): Promise<{ rows: MeetingRow[]; total: number }> {
  const mineOnly = !isAdmin(user);
  const [meetingRows, enrollmentRows] = await Promise.all([
    prisma.meeting.findMany({
      where: {
        occurredAt: { gte: week.fromInstant, lt: week.toInstant },
        ...(mineOnly ? { OR: [{ createdById: user.id }, { attendees: { some: { userId: user.id } } }] } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      include: { attendees: { select: { email: true, external: true } } },
    }),
    prisma.enrollment.findMany({
      where: { meetingAt: { gte: week.fromInstant, lt: week.toInstant }, ...(mineOnly ? { foUserId: user.id } : {}) },
      orderBy: { meetingAt: 'desc' },
      select: { id: true, personId: true, meetingAt: true, person: { select: { firstName: true, lastName: true, companyName: true, email: true } } },
    }),
  ]);

  const rows: MeetingRow[] = [
    ...meetingRows
      // The domain setting is the authority, so it is re-applied here and editing it is
      // retroactive in both directions. The stored flag is only a cache, used when an attendee
      // was recorded by name with no address.
      .map((m) => ({ m, externals: m.attendees.filter((a) => (a.email ? isExternalEmail(a.email, internalDomains) : a.external)).length }))
      .filter((x) => x.externals > 0)
      .map(({ m, externals }) => ({ id: m.id, title: m.title, at: m.occurredAt, company: m.companyName, href: `/meetings/${m.id}`, externals, source: 'meeting' as const })),
    ...enrollmentRows
      .filter((e) => isExternalEmail(e.person.email, internalDomains) || !e.person.email)
      .map((e) => ({
        id: e.id,
        title: `Meeting booked with ${cachedPersonName(e.person)}`,
        at: e.meetingAt!,
        company: e.person.companyName,
        href: `/people/${e.personId}`,
        externals: 1,
        source: 'sequence' as const,
      })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return { total: rows.length, rows: rows.slice(0, take) };
}

/**
 * Per-FO figures for the current week (Sunday to Saturday), for managers.
 * Four grouped queries for the whole team rather than five per person.
 */
async function teamThisWeek(user: SessionUser, today: LocalDate, week: { fromInstant: Date; toInstant: Date }) {
  if (!isAdmin(user) && !isSeniorFo(user)) return [];
  const pods = visiblePodIds(user);
  const users = await prisma.user.findMany({
    where: { active: true, ...(pods === null ? {} : { pods: { some: { podId: { in: pods } } } }) },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  if (!users.length) return [];
  const ids = users.map((u) => u.id);

  const [pending, doneRows, replyRows, meetingRows] = await Promise.all([
    prisma.task.findMany({ where: { foUserId: { in: ids }, state: 'PENDING' }, select: { foUserId: true, dueDate: true, snoozedTo: true } }),
    prisma.task.groupBy({ by: ['foUserId'], where: { foUserId: { in: ids }, state: 'DONE', completedAt: { gte: week.fromInstant, lt: week.toInstant } }, _count: { _all: true } }),
    prisma.enrollment.groupBy({ by: ['foUserId'], where: { foUserId: { in: ids }, repliedAt: { gte: week.fromInstant, lt: week.toInstant } }, _count: { _all: true } }),
    prisma.enrollment.groupBy({ by: ['foUserId'], where: { foUserId: { in: ids }, meetingAt: { gte: week.fromInstant, lt: week.toInstant } }, _count: { _all: true } }),
  ]);

  const doneBy = new Map(doneRows.map((r) => [r.foUserId, r._count._all]));
  const replyBy = new Map(replyRows.map((r) => [r.foUserId, r._count._all]));
  const meetingBy = new Map(meetingRows.map((r) => [r.foUserId, r._count._all]));
  const dueBy = new Map<string, { today: number; overdue: number }>();
  for (const t of pending) {
    const row = dueBy.get(t.foUserId) ?? { today: 0, overdue: 0 };
    const due = t.snoozedTo ?? t.dueDate;
    if (due === today) row.today += 1;
    else if (due < today) row.overdue += 1;
    dueBy.set(t.foUserId, row);
  }

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    today: dueBy.get(u.id)?.today ?? 0,
    overdue: dueBy.get(u.id)?.overdue ?? 0,
    doneWeek: doneBy.get(u.id) ?? 0,
    replies: replyBy.get(u.id) ?? 0,
    meetings: meetingBy.get(u.id) ?? 0,
  }));
}
