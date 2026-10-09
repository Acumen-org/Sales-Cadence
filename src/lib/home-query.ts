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
  const day = { gte: startOfLocalDay(today, user.timezone), lt: startOfLocalDay(addDays(today, 1), user.timezone) };

  const [mine, ownership, team, needsReview, doneToday] = await Promise.all([
    myOpenTasks(mineTasks, today, user, day),
    myOwnershipCounts(user),
    teamThisWeek(user, today, week, now),
    isAdmin(user) ? prisma.activityEvent.count({ where: { needsReview: true } }) : Promise.resolve(0),
    prisma.task.findMany({ where: { AND: [mineTasks, { state: 'DONE', completedAt: day }] }, select: { enrollmentId: true, stepId: true } }),
  ]);
  // Steps finished today, counted the way the Tasks tabs count them: one person's step is one,
  // however many actions it held, and only once nothing in it is still open. Created tasks too.
  const completedToday = new Set(doneToday.map((t) => `${t.enrollmentId}:${t.stepId}`).filter((k) => !mine.openSteps.has(k))).size + mine.createdDoneToday;
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
export type NextTouchpoint = { id: string; kind: 'step' | 'task'; name: string; company: string | null; campaign: string | null; fo: string | null; due: LocalDate; actions: string[] };

type OpenRow = { id: string; action: string; dueDate: string; snoozedTo: string | null; enrollmentId: string; stepId: string; fo: { name: string }; enrollment: { personId: string; person: { firstName: string | null; lastName: string | null; companyName: string | null }; campaign: { name: string } | null } };

/**
 * The next touchpoints, in the order the Tasks flow gives them: what is overdue (oldest first),
 * then today, then what is coming. One row per person and step, whatever it holds.
 */
function nextTouchpoints(rows: OpenRow[], created: CreatedRow[], today: LocalDate, limit = 4): NextTouchpoint[] {
  const groups = new Map<string, OpenRow[]>();
  for (const r of rows) { const key = `${r.enrollmentId}:${r.stepId}`; groups.set(key, [...(groups.get(key) ?? []), r]); }
  const order = (d: string) => (d < today ? 0 : d === today ? 1 : 2);
  const rank = (a: string) => ['EMAIL', 'CALL', 'LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE'].indexOf(a) + 1 || 9;
  const personName = (p: { firstName: string | null; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Unnamed person';
  const steps: NextTouchpoint[] = [...groups.values()]
    .map((g) => { const due = g.map((t) => t.snoozedTo ?? t.dueDate).sort()[0]; const r = g[0]; return { id: r.id, kind: 'step' as const, name: personName(r.enrollment.person), company: r.enrollment.person.companyName, campaign: r.enrollment.campaign?.name ?? null, fo: r.fo.name, due, actions: [...new Set(g.map((t) => t.action))].sort((x, y) => rank(x) - rank(y)) }; });
  const tasks: NextTouchpoint[] = created.map((n) => ({ id: n.id, kind: 'task' as const, name: personName(n.person), company: n.person.companyName, campaign: n.label, fo: n.fo.name, due: n.dueDate, actions: [n.action] }));
  return [...steps, ...tasks]
    .sort((a, b) => order(a.due) - order(b.due) || a.due.localeCompare(b.due) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

type CreatedRow = { id: string; label: string; action: string; dueDate: string; person: { id: string; firstName: string | null; lastName: string | null; companyName: string | null }; fo: { name: string } };
const createdSelect = { id: true, label: true, action: true, dueDate: true, person: { select: { id: true, firstName: true, lastName: true, companyName: true } }, fo: { select: { name: true } } } satisfies Prisma.NextActionSelect;

const openRowSelect = { id: true, action: true, label: true, dueDate: true, snoozedTo: true, enrollmentId: true, stepId: true, fo: { select: { name: true } }, enrollment: { select: { personId: true, person: { select: { firstName: true, lastName: true, companyName: true } }, campaign: { select: { name: true } } } } } satisfies Prisma.TaskSelect;

/**
 * All of this FO's open tasks in one query, bucketed in memory.
 * One indexed read instead of nine counts: on a single-CPU box that difference is the page.
 */
async function myOpenTasks(base: Prisma.TaskWhereInput, today: LocalDate, user: SessionUser, day: { gte: Date; lt: Date }) {
  const [rows, createdRows] = await Promise.all([
    prisma.task.findMany({ where: { AND: [base, WORKABLE, { state: 'PENDING' }] }, select: openRowSelect }),
    // Tasks someone created for a person count like any step, as in the sidebar badge and Tasks.
    prisma.nextAction.findMany({ where: { foUserId: user.id, OR: [{ state: 'OPEN' }, { lastDoneAt: day }] }, select: { ...createdSelect, state: true, lastDoneAt: true } }),
  ]);
  const created = createdRows.filter((n) => n.state === 'OPEN');
  const createdDoneToday = createdRows.filter((n) => n.lastDoneAt && n.lastDoneAt >= day.gte && n.lastDoneAt < day.lt).length;
  const openSteps = new Set(rows.map((r) => `${r.enrollmentId}:${r.stepId}`));
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
  // A step with actions on different days sits on the tab of its earliest one, as in Tasks.
  for (const g of overdueGroups) todayGroups.delete(g);
  for (const n of created) {
    const ch = channelOfAction(n.action);
    if (n.dueDate === today) { todayC[ch] += 1; todayGroups.add(`task:${n.id}`); peopleToday.add(n.person.id); }
    else if (n.dueDate < today) { overdueC[ch] += 1; overdueGroups.add(`task:${n.id}`); }
    else upcomingC[ch] += 1;
  }
  // Somebody with no work of their own (an admin, a leader) sees what is next for the team.
  let nextTasks = nextTouchpoints(rows, created, today);
  let nextForTeam = false;
  // Admins see everyone's; a pod's leaders see their pods'. Anyone else simply has nothing due.
  if (!rows.length && !created.length && (isAdmin(user) || isPodLeader(user))) {
    const pods = isAdmin(user) ? null : user.podIds;
    const team = await prisma.task.findMany({
      where: { AND: [taskScopeWhere(user), WORKABLE, { state: 'PENDING', ...(pods === null ? {} : { enrollment: { podId: { in: pods } } }) }] },
      select: openRowSelect,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: 400,
    });
    nextTasks = nextTouchpoints(team, [], today);
    nextForTeam = true;
  }
  return { today: todayC, overdue: overdueC, upcoming: upcomingC, todayGroups: todayGroups.size, overdueGroups: overdueGroups.size, peopleToday: peopleToday.size, nextTasks, nextForTeam, openSteps, createdDoneToday };
}

/**
 * One FO on the week's board. The week's total is exactly done + overdue + today + later, so every
 * part of "X of Y done" is a column beside it.
 */
export type TeamRow = { id: string; name: string; pod: string | null; done: number; overdue: number; today: number; later: number; replies: number; meetings: number };
export const weekTotal = (r: Pick<TeamRow, 'done' | 'overdue' | 'today' | 'later'>) => r.done + r.overdue + r.today + r.later;

/**
 * Per-FO figures for the working week (Monday to Sunday), for everyone who carries outreach.
 * Work is counted the way the Tasks tabs count it - one person's step is one, and a task someone
 * created for a person is one - so each figure matches the FO's own Tasks page:
 * - Done: finished this week (a step counts once nothing in it is still open).
 * - Overdue and Due today: open now, as on the Overdue and Today tabs.
 * - Later this week: open and due after today but by Sunday, plus the campaign-calendar steps dated
 *   this week that have not opened yet.
 * Replies are messages that came back this week; meetings are those recorded in Meetings this week,
 * credited to the FO who booked them.
 */
async function teamThisWeek(user: SessionUser, today: LocalDate, week: { from: LocalDate; to: LocalDate; fromInstant: Date; toInstant: Date }, now: Date): Promise<TeamRow[]> {
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
  const inWeek = { gte: week.fromInstant, lt: week.toInstant };

  const [pending, doneRows, replyRows, meetingRows, planned, created] = await Promise.all([
    prisma.task.findMany({ where: { AND: [taskScope, WORKABLE, { foUserId: { in: ids }, state: 'PENDING' }] }, select: { foUserId: true, dueDate: true, snoozedTo: true, enrollmentId: true, stepId: true } }),
    prisma.task.findMany({ where: { AND: [taskScope, { foUserId: { in: ids }, state: 'DONE', completedAt: inWeek }] }, select: { foUserId: true, enrollmentId: true, stepId: true } }),
    // Replies: what came back this week, credited to the FO whose outreach it answers - see reply-credit.ts.
    prisma.touch.findMany({ where: { ...REPLY_TOUCH_WHERE, occurredAt: inWeek, person: { deletedAt: null } }, select: { id: true, occurredAt: true, personId: true, person: { select: { ownerMemberId: true } } } }),
    prisma.meeting.findMany({ where: { review: 'APPROVED', occurredAt: { gte: week.fromInstant, lt: new Date(Math.min(week.toInstant.getTime(), Math.max(now.getTime(), Date.now()))) }, OR: [{ bookedById: { in: ids } }, { bookedById: null, createdById: { in: ids } }] }, select: { bookedById: true, createdById: true } }),
    // Campaign calendars: every step dated this week, open yet or not.
    prisma.enrollment.findMany({ where: { AND: [enrollmentScope, { foUserId: { in: ids }, status: 'ACTIVE', scheduleDates: { isEmpty: false } }] }, select: { id: true, foUserId: true, currentStep: true, scheduleDates: true } }),
    prisma.nextAction.findMany({ where: { foUserId: { in: ids }, OR: [{ state: 'OPEN', dueDate: { lte: week.to } }, { lastDoneAt: inWeek }] }, select: { id: true, foUserId: true, dueDate: true, state: true, lastDoneAt: true } }),
  ]);
  const createdOpen = created.filter((n) => n.state === 'OPEN' && n.dueDate <= week.to);
  const createdDone = created.filter((n) => n.lastDoneAt && n.lastDoneAt >= week.fromInstant && n.lastDoneAt < week.toInstant);

  type Row = { done: Set<string>; overdue: Set<string>; today: Set<string>; later: Set<string> };
  const by = new Map<string, Row>();
  const row = (id: string) => { let r = by.get(id); if (!r) { r = { done: new Set(), overdue: new Set(), today: new Set(), later: new Set() }; by.set(id, r); } return r; };

  // A step is done when nothing in it is still open: the email sent but the LinkedIn still to go is open work.
  const stillOpen = new Set(pending.map((t) => `${t.enrollmentId}:${t.stepId}`));
  for (const t of doneRows) { const key = `${t.enrollmentId}:${t.stepId}`; if (!stillOpen.has(key)) row(t.foUserId).done.add(key); }
  createdDone.forEach((n, i) => row(n.foUserId).done.add(`task-done:${i}`));
  for (const t of pending) {
    const due = t.snoozedTo ?? t.dueDate;
    const key = `${t.enrollmentId}:${t.stepId}`;
    const r = row(t.foUserId);
    if (due < today) r.overdue.add(key);
    else if (due === today) r.today.add(key);
    else if (due <= week.to) r.later.add(key);
  }
  for (const n of createdOpen) {
    const r = row(n.foUserId);
    (n.dueDate < today ? r.overdue : n.dueDate === today ? r.today : r.later).add(`task:${n.id}`);
  }
  // A step can be both overdue and later (its actions on different days): it counts once, where it is most urgent.
  for (const r of by.values()) { for (const k of r.overdue) { r.today.delete(k); r.later.delete(k); } for (const k of r.today) r.later.delete(k); }
  for (const e of planned) {
    e.scheduleDates.forEach((date, i) => { if (i > e.currentStep && date >= week.from && date <= week.to) row(e.foUserId).later.add(`${e.id}:plan:${i}`); });
  }

  const userByMember = new Map(users.flatMap((u) => (u.twentyMemberId ? [[u.twentyMemberId, u.id] as const] : [])));
  const replyBy = new Map<string, number>();
  const creditedFo = await enrollmentByReply(replyRows);
  for (const r of replyRows) { const id = creditedFo.get(r.id)?.foUserId ?? (r.person.ownerMemberId ? userByMember.get(r.person.ownerMemberId) : null); if (id && ids.includes(id)) replyBy.set(id, (replyBy.get(id) ?? 0) + 1); }
  const meetingBy = new Map<string, number>();
  for (const m of meetingRows) { const id = m.bookedById ?? m.createdById; if (id) meetingBy.set(id, (meetingBy.get(id) ?? 0) + 1); }

  const rows: TeamRow[] = users.map((u) => {
    const r = by.get(u.id);
    return {
      id: u.id,
      name: u.name,
      pod: u.pods.find((p) => !p.pod.archived)?.pod.name ?? null,
      done: r?.done.size ?? 0,
      overdue: r?.overdue.size ?? 0,
      today: r?.today.size ?? 0,
      later: r?.later.size ?? 0,
      replies: replyBy.get(u.id) ?? 0,
      meetings: meetingBy.get(u.id) ?? 0,
    };
  });
  // Everyone in a pod, and anyone else with work or results this week; who owes most comes first.
  const active = (r: TeamRow) => weekTotal(r) + r.replies + r.meetings > 0;
  return rows
    .filter((r) => r.pod || active(r))
    .sort((a, b) => b.today + b.overdue - (a.today + a.overdue) || weekTotal(b) - weekTotal(a) || a.name.localeCompare(b.name));
}
