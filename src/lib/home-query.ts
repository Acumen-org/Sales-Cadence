import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isAdmin, isSeniorFo, visiblePodIds } from './auth/rbac';
import { addDays, startOfLocalDay, todayIn, weekRange, type LocalDate } from './dates';
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
  const mineTasks: Prisma.TaskWhereInput = { AND: [taskScopeWhere(user), { foUserId: user.id }] };

  const [mine, ownership, team, needsReview, completedToday] = await Promise.all([
    myOpenTasks(mineTasks, today),
    myOwnershipCounts(user),
    teamThisWeek(user, today, week),
    isAdmin(user) ? prisma.activityEvent.count({ where: { needsReview: true } }) : Promise.resolve(0),
    prisma.task.count({ where: { AND: [mineTasks, { state: 'DONE', completedAt: { gte: startOfLocalDay(today, user.timezone), lt: startOfLocalDay(addDays(today, 1), user.timezone) } }] } }),
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
      completedToday,
      nextTasks: mine.nextTasks,
    },
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
    select: { id: true, action: true, label: true, dueDate: true, snoozedTo: true, enrollment: { select: { personId: true, person: { select: { firstName: true, lastName: true, companyName: true } } } } },
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
  const nextTasks = rows.sort((a, b) => (a.snoozedTo ?? a.dueDate).localeCompare(b.snoozedTo ?? b.dueDate) || a.id.localeCompare(b.id)).slice(0, 3).map((r) => ({ id: r.id, action: r.action, label: r.label, due: r.snoozedTo ?? r.dueDate, name: [r.enrollment.person.firstName, r.enrollment.person.lastName].filter(Boolean).join(' ') || 'Unnamed person', company: r.enrollment.person.companyName }));
  return { today: todayC, overdue: overdueC, upcoming: upcomingC, peopleToday: peopleToday.size, nextTasks };
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
  const taskScope = taskScopeWhere(user);
  const enrollmentScope: Prisma.EnrollmentWhereInput = pods === null ? {} : { OR: [{ podId: { in: pods } }, { foUserId: user.id }] };

  const [pending, doneRows, replyRows, meetingRows] = await Promise.all([
    prisma.task.findMany({ where: { AND: [taskScope, { foUserId: { in: ids }, state: 'PENDING' }] }, select: { foUserId: true, dueDate: true, snoozedTo: true } }),
    prisma.task.groupBy({ by: ['foUserId'], where: { AND: [taskScope, { foUserId: { in: ids }, state: 'DONE', completedAt: { gte: week.fromInstant, lt: week.toInstant } }] }, _count: { _all: true } }),
    prisma.enrollment.groupBy({ by: ['foUserId'], where: { AND: [enrollmentScope, { foUserId: { in: ids }, repliedAt: { gte: week.fromInstant, lt: week.toInstant } }] }, _count: { _all: true } }),
    prisma.enrollment.groupBy({ by: ['foUserId'], where: { AND: [enrollmentScope, { foUserId: { in: ids }, meetingAt: { gte: week.fromInstant, lt: week.toInstant } }] }, _count: { _all: true } }),
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
