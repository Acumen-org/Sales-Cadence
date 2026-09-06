import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isAdmin, isSeniorFo, visiblePodIds } from './auth/rbac';
import { addDays, todayIn, type LocalDate } from './dates';
import { channelWhere, tabWhere, taskScopeWhere, TASK_CHANNELS, type TaskChannel } from './tasks-query';

export type HomeData = Awaited<ReturnType<typeof buildHome>>;

/** Outreach-style home: today's work by type, what happened lately, and the team view for managers. */
export async function buildHome(user: SessionUser, now = new Date()) {
  const today = todayIn(user.timezone, now);
  const weekAgo = addDays(today, -7);
  const mine = { foUserId: user.id };
  const scope = taskScopeWhere(user);

  const countBy = async (where: Prisma.TaskWhereInput) => prisma.task.count({ where });
  const perChannel = async (base: Prisma.TaskWhereInput, tab: 'today' | 'overdue' | 'upcoming') => {
    const rows = await Promise.all(TASK_CHANNELS.map((c) => countBy({ AND: [base, channelWhere(c), tabWhere(tab, today)] })));
    return Object.fromEntries(TASK_CHANNELS.map((c, i) => [c, rows[i]])) as Record<TaskChannel, number>;
  };

  const [myToday, myOverdue, myUpcoming, doneThisWeek, myActive] = await Promise.all([
    perChannel(mine, 'today'),
    perChannel(mine, 'overdue'),
    perChannel(mine, 'upcoming'),
    prisma.task.count({ where: { ...mine, state: 'DONE', completedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }),
    prisma.enrollment.count({ where: { foUserId: user.id, status: { in: ['ACTIVE', 'PAUSED'] } } }),
  ]);

  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const [replies, meetings] = await Promise.all([
    prisma.enrollment.findMany({ where: { foUserId: user.id, repliedAt: { gte: weekStart } }, include: { person: true }, orderBy: { repliedAt: 'desc' }, take: 10 }),
    prisma.enrollment.findMany({ where: { foUserId: user.id, meetingAt: { gte: weekStart } }, include: { person: true }, orderBy: { meetingAt: 'desc' }, take: 10 }),
  ]);

  // Team view (managers): today / overdue / done-this-week per FO in visible pods
  let team: Array<{ id: string; name: string; today: number; overdue: number; doneWeek: number; replies: number; meetings: number; active: number }> = [];
  if (isAdmin(user) || isSeniorFo(user)) {
    const pods = visiblePodIds(user);
    const users = await prisma.user.findMany({
      where: { active: true, ...(pods === null ? {} : { pods: { some: { podId: { in: pods } } } }) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    team = await Promise.all(
      users.map(async (u) => {
        const base = { AND: [scope, { foUserId: u.id }] };
        const [t, o, d, r, m, a] = await Promise.all([
          countBy({ AND: [base, tabWhere('today', today)] }),
          countBy({ AND: [base, tabWhere('overdue', today)] }),
          prisma.task.count({ where: { foUserId: u.id, state: 'DONE', completedAt: { gte: weekStart } } }),
          prisma.enrollment.count({ where: { foUserId: u.id, repliedAt: { gte: weekStart } } }),
          prisma.enrollment.count({ where: { foUserId: u.id, meetingAt: { gte: weekStart } } }),
          prisma.enrollment.count({ where: { foUserId: u.id, status: { in: ['ACTIVE', 'PAUSED'] } } }),
        ]);
        return { id: u.id, name: u.name, today: t, overdue: o, doneWeek: d, replies: r, meetings: m, active: a };
      }),
    );
  }

  const needsReview = isAdmin(user) ? await prisma.activityEvent.count({ where: { needsReview: true } }) : 0;
  const total = (m: Record<TaskChannel, number>) => Object.values(m).reduce((a, b) => a + b, 0);

  return {
    today,
    weekAgo: weekAgo as LocalDate,
    my: { today: myToday, overdue: myOverdue, upcoming: myUpcoming, todayTotal: total(myToday), overdueTotal: total(myOverdue), doneThisWeek, active: myActive },
    replies: replies.map((e) => ({ id: e.id, personId: e.personId, name: `${e.person.firstName} ${e.person.lastName}`.trim(), company: e.person.companyName, at: e.repliedAt! })),
    meetings: meetings.map((e) => ({ id: e.id, personId: e.personId, name: `${e.person.firstName} ${e.person.lastName}`.trim(), company: e.person.companyName, at: e.meetingAt! })),
    team,
    needsReview,
  };
}
