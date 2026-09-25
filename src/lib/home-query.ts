import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { enrollmentByReply, REPLY_TOUCH_WHERE } from './reply-credit';
import type { SessionUser } from './auth/current-user';
import { isAdmin, isPodLeader, visiblePodIds, canSeeAllPods, ROLES_NEEDING_POD } from './auth/rbac';
import { addDays, startOfLocalDay, todayIn, workWeekRange, type LocalDate } from './dates';
import { taskScopeWhere, WORKABLE, type TaskChannel } from './tasks-query';
import { myOwnershipCounts } from './accounts-query';

export type HomeData = Awaited<ReturnType<typeof buildHome>>;

/**
 * People this user is responsible for: owned in Twenty, in one of their pods (pod leaders), or
 * enrolled with them as the FO. Admins see everyone, since they supervise.
 */
export async function assignedPersonWhere(user: SessionUser): Promise<Prisma.PersonCacheWhereInput> {
  if (canSeeAllPods(user)) return {};
  const or: Prisma.PersonCacheWhereInput[] = [{ enrollments: { some: { foUserId: user.id } } }];
  if (user.twentyMemberId) or.push({ ownerMemberId: user.twentyMemberId });
  if (isPodLeader(user)) {
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
 * and booked meetings. Weeks run Monday to Sunday in the user's own timezone.
 */
export async function buildHome(user: SessionUser, now = new Date()) {
  const today = todayIn(user.timezone, now);
  const week = workWeekRange(today, user.timezone);
  const mineTasks: Prisma.TaskWhereInput = { AND: [taskScopeWhere(user), { foUserId: user.id }] };

  const [mine, ownership, team, needsReview, completedToday] = await Promise.all([
    myOpenTasks(mineTasks, today, user),
    myOwnershipCounts(user),
    teamThisWeek(user, today, week),
    isAdmin(user) ? prisma.activityEvent.count({ where: { needsReview: true } }) : Promise.resolve(0),
    prisma.task.count({ where: { AND: [mineTasks, { state: 'DONE', completedAt: { gte: startOfLocalDay(today, user.timezone), lt: startOfLocalDay(addDays(today, 1), user.timezone) } }] } }),
  ]);
  const byChannel = mine;
  const peopleToReachToday = mine.peopleToday;


  return {
    today,
    week,
    my: {
      today: byChannel.today,
      overdue: byChannel.overdue,
      upcoming: byChannel.upcoming,
      todayTotal: mine.todayGroups,
      overdueTotal: mine.overdueGroups,
      peopleToReachToday,
      accounts: ownership.accounts,
      relationships: ownership.relationships,
      activeAccounts: ownership.activeAccounts,
      inSequence: ownership.inSequence,
      completedToday,
      nextTasks: mine.nextTasks,
      nextForTeam: mine.nextForTeam,
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

/** A touchpoint for "Up next": one person's step, with every action it holds. */
export type NextTouchpoint = { id: string; name: string; company: string | null; campaign: string | null; fo: string | null; due: LocalDate; actions: string[] };

type OpenRow = { id: string; action: string; dueDate: string; snoozedTo: string | null; enrollmentId: string; stepId: string; fo: { name: string }; enrollment: { personId: string; person: { firstName: string | null; lastName: string | null; companyName: string | null }; campaign: { name: string } | null } };

/**
 * The next touchpoints, in the order the Tasks flow gives them: what is overdue (oldest first),
 * then today, then what is coming. One row per person and step, whatever it holds.
 */
function nextTouchpoints(rows: OpenRow[], today: LocalDate, limit = 4): NextTouchpoint[] {
  const groups = new Map<string, OpenRow[]>();
  for (const r of rows) { const key = `${r.enrollmentId}:${r.stepId}`; groups.set(key, [...(groups.get(key) ?? []), r]); }
  const order = (d: string) => (d < today ? 0 : d === today ? 1 : 2);
  const rank = (a: string) => ['EMAIL', 'CALL', 'LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE'].indexOf(a) + 1 || 9;
  return [...groups.values()]
    .map((g) => { const due = g.map((t) => t.snoozedTo ?? t.dueDate).sort()[0]; const r = g[0]; return { id: r.id, name: [r.enrollment.person.firstName, r.enrollment.person.lastName].filter(Boolean).join(' ') || 'Unnamed person', company: r.enrollment.person.companyName, campaign: r.enrollment.campaign?.name ?? null, fo: r.fo.name, due, actions: [...new Set(g.map((t) => t.action))].sort((x, y) => rank(x) - rank(y)) }; })
    .sort((a, b) => order(a.due) - order(b.due) || a.due.localeCompare(b.due) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

const openRowSelect = { id: true, action: true, label: true, dueDate: true, snoozedTo: true, enrollmentId: true, stepId: true, fo: { select: { name: true } }, enrollment: { select: { personId: true, person: { select: { firstName: true, lastName: true, companyName: true } }, campaign: { select: { name: true } } } } } satisfies Prisma.TaskSelect;

/**
 * All of this FO's open tasks in one query, bucketed in memory.
 * One indexed read instead of nine counts: on a single-CPU box that difference is the page.
 */
async function myOpenTasks(base: Prisma.TaskWhereInput, today: LocalDate, user: SessionUser) {
  const rows = await prisma.task.findMany({
    where: { AND: [base, WORKABLE, { state: 'PENDING' }] },
    select: openRowSelect,
  });
  const todayC = emptyChannels();
  const overdueC = emptyChannels();
  const upcomingC = emptyChannels();
  const peopleToday = new Set<string>();
  // The per-channel strip counts modules; the headline, the Tasks tabs and the sidebar badge all
  // count touchpoints (a step of one enrollment), so an email + LinkedIn step is one, not two.
  const todayGroups = new Set<string>();
  const overdueGroups = new Set<string>();
  for (const r of rows) {
    const due = r.snoozedTo ?? r.dueDate;
    const ch = channelOfAction(r.action);
    const group = `${r.enrollmentId}:${r.stepId}`;
    if (due === today) {
      todayC[ch] += 1;
      todayGroups.add(group);
      peopleToday.add(r.enrollment.personId);
    } else if (due < today) {
      overdueC[ch] += 1;
      overdueGroups.add(group);
    } else upcomingC[ch] += 1;
  }
  // Somebody with no work of their own (an admin, a leader) sees what is next for the team.
  let nextTasks = nextTouchpoints(rows, today);
  let nextForTeam = false;
  // Admins see everyone's; a pod's leaders see their pods'. Anyone else simply has nothing due.
  if (!rows.length && (isAdmin(user) || isPodLeader(user))) {
    const pods = isAdmin(user) ? null : user.podIds;
    const team = await prisma.task.findMany({
      where: { AND: [taskScopeWhere(user), WORKABLE, { state: 'PENDING', ...(pods === null ? {} : { enrollment: { podId: { in: pods } } }) }] },
      select: openRowSelect,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: 400,
    });
    nextTasks = nextTouchpoints(team, today);
    nextForTeam = true;
  }
  return { today: todayC, overdue: overdueC, upcoming: upcomingC, todayGroups: todayGroups.size, overdueGroups: overdueGroups.size, peopleToday: peopleToday.size, nextTasks, nextForTeam };
}

/** One FO on the week's board. */
export type TeamRow = { id: string; name: string; pod: string | null; today: number; overdue: number; doneWeek: number; dueWeek: number; peopleWeek: number; replies: number; meetings: number };

/**
 * Per-FO figures for the working week (Monday to Sunday), for everyone who carries outreach.
 * Everything is counted in touchpoints - one person's step - so a row reads one way across: what
 * is due today and overdue, what was done this week against what the week asked for (done, what
 * is open and due by Sunday, and what a campaign calendar has placed this week that has not opened
 * yet), and what came back. Six grouped reads for the whole team.
 */
async function teamThisWeek(user: SessionUser, today: LocalDate, week: { from: LocalDate; to: LocalDate; fromInstant: Date; toInstant: Date }): Promise<TeamRow[]> {
  const leads = canSeeAllPods(user) || isPodLeader(user);
  const pods = visiblePodIds(user);
  const users = leads
    ? await prisma.user.findMany({
        where: { active: true, role: { in: ROLES_NEEDING_POD }, ...(pods === null ? {} : { pods: { some: { podId: { in: pods } } } }) },
        select: { id: true, name: true, twentyMemberId: true, pods: { select: { pod: { select: { name: true, archived: true } } } } },
        orderBy: { name: 'asc' },
      })
    : [{ id: user.id, name: user.name, twentyMemberId: user.twentyMemberId, pods: user.pods.map((p) => ({ pod: { name: p.name, archived: false } })) }];
  if (!users.length) return [];
  const ids = users.map((u) => u.id);
  const taskScope = taskScopeWhere(user);
  const enrollmentScope: Prisma.EnrollmentWhereInput = pods === null ? {} : { OR: [{ podId: { in: pods } }, { foUserId: user.id }] };

  const [pending, doneRows, replyRows, meetingRows, planned] = await Promise.all([
    prisma.task.findMany({ where: { AND: [taskScope, WORKABLE, { foUserId: { in: ids }, state: 'PENDING' }] }, select: { foUserId: true, dueDate: true, snoozedTo: true, enrollmentId: true, stepId: true } }),
    prisma.task.findMany({ where: { AND: [taskScope, { foUserId: { in: ids }, state: 'DONE', completedAt: { gte: week.fromInstant, lt: week.toInstant } }] }, select: { foUserId: true, enrollmentId: true, stepId: true, enrollment: { select: { personId: true } } } }),
    // Replies: what came back this week, credited to the FO whose outreach it answers - see reply-credit.ts.
    prisma.touch.findMany({ where: { ...REPLY_TOUCH_WHERE, occurredAt: { gte: week.fromInstant, lt: week.toInstant }, person: { deletedAt: null } }, select: { id: true, occurredAt: true, personId: true, person: { select: { ownerMemberId: true } } } }),
    prisma.enrollment.groupBy({ by: ['foUserId'], where: { AND: [enrollmentScope, { foUserId: { in: ids }, meetingAt: { gte: week.fromInstant, lt: week.toInstant } }] }, _count: { _all: true } }),
    // Campaign calendars: every step dated this week, open yet or not.
    prisma.enrollment.findMany({ where: { AND: [enrollmentScope, { foUserId: { in: ids }, status: 'ACTIVE', scheduleDates: { isEmpty: false } }] }, select: { id: true, foUserId: true, currentStep: true, scheduleDates: true } }),
  ]);

  // A step is done when nothing in it is still open: the email sent but the LinkedIn still to go is open work.
  const stillOpen = new Set(pending.map((t) => `${t.enrollmentId}:${t.stepId}`));
  const doneBy = new Map<string, { steps: Set<string>; people: Set<string> }>();
  for (const t of doneRows) {
    if (stillOpen.has(`${t.enrollmentId}:${t.stepId}`)) continue;
    const row = doneBy.get(t.foUserId) ?? { steps: new Set<string>(), people: new Set<string>() };
    row.steps.add(`${t.enrollmentId}:${t.stepId}`);
    row.people.add(t.enrollment.personId);
    doneBy.set(t.foUserId, row);
  }
  const userByMember = new Map(users.flatMap((u) => (u.twentyMemberId ? [[u.twentyMemberId, u.id] as const] : [])));
  const replyBy = new Map<string, number>();
  const creditedFo = await enrollmentByReply(replyRows);
  for (const r of replyRows) { const id = creditedFo.get(r.id)?.foUserId ?? (r.person.ownerMemberId ? userByMember.get(r.person.ownerMemberId) : null); if (id && ids.includes(id)) replyBy.set(id, (replyBy.get(id) ?? 0) + 1); }
  const meetingBy = new Map(meetingRows.map((r) => [r.foUserId, r._count._all]));
  // Touchpoints, not modules, so the board agrees with each FO's badge and Tasks tabs.
  const openBy = new Map<string, { today: Set<string>; overdue: Set<string>; week: Set<string> }>();
  for (const t of pending) {
    const row = openBy.get(t.foUserId) ?? { today: new Set<string>(), overdue: new Set<string>(), week: new Set<string>() };
    const due = t.snoozedTo ?? t.dueDate;
    const group = `${t.enrollmentId}:${t.stepId}`;
    if (due === today) row.today.add(group);
    else if (due < today) row.overdue.add(group);
    if (due <= week.to) row.week.add(group);
    openBy.set(t.foUserId, row);
  }

  for (const e of planned) {
    const row = openBy.get(e.foUserId) ?? { today: new Set<string>(), overdue: new Set<string>(), week: new Set<string>() };
    e.scheduleDates.forEach((date, i) => { if (i > e.currentStep && date >= week.from && date <= week.to) row.week.add(`${e.id}:plan:${i}`); });
    openBy.set(e.foUserId, row);
  }

  const rows: TeamRow[] = users.map((u) => {
    const done = doneBy.get(u.id);
    const open = openBy.get(u.id);
    const doneWeek = done?.steps.size ?? 0;
    return {
      id: u.id,
      name: u.name,
      pod: u.pods.find((p) => !p.pod.archived)?.pod.name ?? null,
      today: open?.today.size ?? 0,
      overdue: open?.overdue.size ?? 0,
      doneWeek,
      dueWeek: doneWeek + (open?.week.size ?? 0),
      peopleWeek: done?.people.size ?? 0,
      replies: replyBy.get(u.id) ?? 0,
      meetings: meetingBy.get(u.id) ?? 0,
    };
  });
  // Everyone in a pod, and anyone else with work or results this week; who owes most comes first.
  const active = (r: TeamRow) => r.today + r.overdue + r.dueWeek + r.replies + r.meetings > 0;
  return rows
    .filter((r) => r.pod || active(r))
    .sort((a, b) => b.today + b.overdue - (a.today + a.overdue) || b.dueWeek - a.dueWeek || a.name.localeCompare(b.name));
}
