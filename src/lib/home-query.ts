import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isAdmin, isPodLeader, visiblePodIds, canSeeAllPods, ROLES_NEEDING_POD } from './auth/rbac';
import { addDays, startOfLocalDay, todayIn, workWeekRange, type LocalDate } from './dates';
import { taskScopeWhere, WORKABLE, type TaskChannel, type TaskTab } from './tasks-query';
import { myOwnershipCounts } from './accounts-query';
import { workWhere } from './subject';
import { dialsByRep, meetingsByRep, repliesByRep } from './outreach/metrics';
import { formsWaiting } from './calls/analytics';

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
 *
 * CRM and cold work count together, with no distinction (cold outreach D2, B031): the lists read the
 * live subject (workWhere, as Tasks does), the figures the shared metrics module (B096), so Home,
 * Tasks and Reports agree, and every link opens /tasks on the tab that holds the item.
 */
export async function buildHome(user: SessionUser, now = new Date()) {
  const today = todayIn(user.timezone, now);
  const week = workWeekRange(today, user.timezone);
  const mineTasks: Prisma.TaskWhereInput = { AND: [taskScopeWhere(user), { foUserId: user.id }] };
  const day = { gte: startOfLocalDay(today, user.timezone), lt: startOfLocalDay(addDays(today, 1), user.timezone) };

  const [mine, ownership, owned, team, needsReview] = await Promise.all([
    myOpenTasks(mineTasks, today, user, day),
    myOwnershipCounts(user),
    // D2: "My people" also counts the live cold contacts this user owns, so a rep who only does cold
    // outreach does not read 0; "My accounts" stays CRM-only (a cold contact has no account).
    coldOwned(user.id),
    teamThisWeek(user, today, week, now),
    isAdmin(user) ? prisma.activityEvent.count({ where: { needsReview: true } }) : Promise.resolve(0),
  ]);
  // Steps finished today, counted the way the Tasks tabs count them: one person's step is one,
  // however many actions it held, and only once nothing in it is still open. Created tasks too.
  const completedToday = new Set(mine.doneToday.map((t) => `${t.enrollmentId}:${t.stepId}`).filter((k) => !mine.openSteps.has(k))).size + mine.createdDoneToday;
  const byChannel = mine;
  // The team's next steps, named by the reps on the board (anyone missing from it is read once).
  let nextTasks = mine.nextTasks;
  if (mine.teamRows) {
    const names = new Map(team.map((r) => [r.id, r.name]));
    const missing = [...new Set(mine.teamRows.map((r) => r.foUserId))].filter((id) => !names.has(id));
    if (missing.length) for (const u of await prisma.user.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } })) names.set(u.id, u.name);
    nextTasks = nextTouchpoints(mine.teamRows.map((r) => ({ ...r, fo: { name: names.get(r.foUserId) ?? 'Someone' } })), [], today);
  }
  // B094: "All tasks" opens the tab the panel shows. The team's panel is ordered overdue first, so
  // its first row says which tab holds what it lists; the user's own is their most urgent tab.
  const tabOf = (due: LocalDate): TaskTab => (due < today ? 'overdue' : due === today ? 'today' : 'upcoming');
  const focusTab: TaskTab = mine.nextForTeam ? (nextTasks[0] ? tabOf(nextTasks[0].due) : 'upcoming') : mine.overdueGroups ? 'overdue' : mine.todayGroups ? 'today' : 'upcoming';

  return {
    today,
    week,
    my: {
      today: byChannel.today,
      overdue: byChannel.overdue,
      upcoming: byChannel.upcoming,
      todayTotal: mine.todayGroups,
      overdueTotal: mine.overdueGroups,
      /** B095: everyone with work due today or already overdue: the people to reach today. */
      peopleToReachToday: mine.peopleToReach,
      /** Of those, the ones with something due today itself. */
      peopleDueToday: mine.peopleToday,
      /** The tab Home's "All tasks" and the focus button open (B094). */
      focusTab,
      accounts: ownership.accounts,
      /** CRM people only: what the People list it opens counts. */
      relationships: ownership.relationships,
      /** The "My people" tile: CRM people and live cold contacts owned, with no distinction (D2). */
      people: ownership.relationships + owned.contacts,
      coldContacts: owned.contacts,
      activeAccounts: ownership.activeAccounts,
      inSequence: ownership.inSequence + owned.inCampaign,
      completedToday,
      nextTasks,
      nextForTeam: mine.nextForTeam,
    },
    team,
    needsReview,
  };
}

/** The live cold contacts a user owns, and how many of them a running campaign holds: one read. */
async function coldOwned(userId: string): Promise<{ contacts: number; inCampaign: number }> {
  const [row] = await prisma.$queryRaw<Array<{ contacts: bigint; in_campaign: bigint }>>`
    SELECT count(*) AS contacts,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Enrollment" e WHERE e."sandboxContactId" = c."id" AND e."personId" IS NULL AND e."status" IN ('ACTIVE', 'PAUSED'))) AS in_campaign
    FROM "SandboxContact" c WHERE c."ownerId" = ${userId} AND c."status" = 'ACTIVE'`;
  return { contacts: Number(row?.contacts ?? 0), inCampaign: Number(row?.in_campaign ?? 0) };
}

const emptyChannels = (): Record<TaskChannel, number> => ({ CALL: 0, EMAIL: 0, LINKEDIN: 0 });

function channelOfAction(action: string): TaskChannel {
  if (action === 'CALL') return 'CALL';
  if (action === 'EMAIL') return 'EMAIL';
  return 'LINKEDIN';
}

/** A touchpoint for "Up next": one person's step, with every action it holds. */
export type NextTouchpoint = { id: string; kind: 'step' | 'task'; name: string; company: string | null; campaign: string | null; fo: string | null; due: LocalDate; actions: string[] };

type Who = null | { firstName: string | null; lastName: string | null; companyName: string | null };
type OpenRow = { id: string; action: string; dueDate: string; snoozedTo: string | null; enrollmentId: string; stepId: string; fo: { name: string }; enrollment: { personId: string | null; sandboxContactId: string | null; person: Who; sandboxContact: Who; campaign: { name: string } | null } };
/** Whose a row is, the same key for a person and a cold contact: Home counts people, not records. */
const subjectKeyOf = (e: { personId: string | null; sandboxContactId: string | null }) => (e.personId ? `p:${e.personId}` : `c:${e.sandboxContactId}`);

/**
 * The next touchpoints, in the order the Tasks flow gives them: what is overdue (oldest first),
 * then today, then what is coming. One row per person and step, whatever it holds.
 */
function nextTouchpoints(rows: OpenRow[], created: CreatedRow[], today: LocalDate, limit = 4): NextTouchpoint[] {
  const groups = new Map<string, OpenRow[]>();
  for (const r of rows) { const key = `${r.enrollmentId}:${r.stepId}`; groups.set(key, [...(groups.get(key) ?? []), r]); }
  const order = (d: string) => (d < today ? 0 : d === today ? 1 : 2);
  const rank = (a: string) => ['EMAIL', 'CALL', 'LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE'].indexOf(a) + 1 || 9;
  const personName = (p: { firstName: string | null; lastName: string | null } | null) => [p?.firstName, p?.lastName].filter(Boolean).join(' ') || 'Unnamed person';
  const steps: NextTouchpoint[] = [...groups.values()]
    .map((g) => { const due = g.map((t) => t.snoozedTo ?? t.dueDate).sort()[0]; const r = g[0]; const who = r.enrollment.person ?? r.enrollment.sandboxContact; return { id: r.id, kind: 'step' as const, name: personName(who), company: who?.companyName ?? null, campaign: r.enrollment.campaign?.name ?? null, fo: r.fo.name, due, actions: [...new Set(g.map((t) => t.action))].sort((x, y) => rank(x) - rank(y)) }; });
  const tasks: NextTouchpoint[] = created.map((n) => { const who = n.person ?? n.sandboxContact; return { id: n.id, kind: 'task' as const, name: personName(who), company: who?.companyName ?? null, campaign: n.label, fo: n.fo.name, due: n.dueDate, actions: [n.kind === 'MEETING' ? 'MEETING' : n.action] }; });
  return [...steps, ...tasks]
    .sort((a, b) => order(a.due) - order(b.due) || a.due.localeCompare(b.due) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

type CreatedRow = { id: string; label: string; action: string; kind: string; dueDate: string; personId: string | null; sandboxContactId: string | null; person: Who; sandboxContact: Who; fo: { name: string } };
const whoSelect = { select: { firstName: true, lastName: true, companyName: true } } as const;
/**
 * Open work as Up next shows it. The FO is not read with it: on the reader's own rows it is the
 * reader, and the team's take their FO's name from the board's list of reps (buildHome).
 */
const myCreatedSelect = { id: true, label: true, action: true, kind: true, dueDate: true, personId: true, sandboxContactId: true, person: whoSelect, sandboxContact: whoSelect } satisfies Prisma.NextActionSelect;
const myRowSelect = { id: true, action: true, label: true, dueDate: true, snoozedTo: true, enrollmentId: true, stepId: true, enrollment: { select: { personId: true, sandboxContactId: true, person: whoSelect, sandboxContact: whoSelect, campaign: { select: { name: true } } } } } satisfies Prisma.TaskSelect;

/**
 * All of this FO's open tasks in one query, bucketed in memory.
 * One indexed read instead of nine counts: on a single-CPU box that difference is the page.
 */
async function myOpenTasks(base: Prisma.TaskWhereInput, today: LocalDate, user: SessionUser, day: { gte: Date; lt: Date }) {
  // Open work and what was finished today, in one read.
  const [read, createdRows] = await Promise.all([
    prisma.task.findMany({ where: { AND: [base, { OR: [{ AND: [WORKABLE, { state: 'PENDING' }] }, { state: 'DONE', completedAt: day }] }] }, select: { ...myRowSelect, state: true } }),
    // Tasks someone created for a person or a cold contact count like any step, as in the sidebar badge and Tasks.
    prisma.nextAction.findMany({ where: { AND: [workWhere('all'), { foUserId: user.id, OR: [{ state: 'OPEN' }, { lastDoneAt: day }] }] }, select: { ...myCreatedSelect, state: true, lastDoneAt: true } }),
  ]);
  const me = { fo: { name: user.name } };
  const rows = read.filter((t) => t.state === 'PENDING').map((t) => ({ ...t, ...me }));
  const doneToday = read.filter((t) => t.state === 'DONE');
  const created = createdRows.filter((n) => n.state === 'OPEN').map((n) => ({ ...n, ...me }));
  const createdDoneToday = createdRows.filter((n) => n.lastDoneAt && n.lastDoneAt >= day.gte && n.lastDoneAt < day.lt).length;
  const openSteps = new Set(rows.map((r) => `${r.enrollmentId}:${r.stepId}`));
  const todayC = emptyChannels();
  const overdueC = emptyChannels();
  const upcomingC = emptyChannels();
  const peopleToday = new Set<string>();
  const peopleToReach = new Set<string>();
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
      peopleToday.add(subjectKeyOf(r.enrollment));
      peopleToReach.add(subjectKeyOf(r.enrollment));
    } else if (due < today) {
      overdueC[ch] += 1;
      overdueGroups.add(group);
      peopleToReach.add(subjectKeyOf(r.enrollment));
    } else upcomingC[ch] += 1;
  }
  // A step with actions on different days sits on the tab of its earliest one, as in Tasks.
  for (const g of overdueGroups) todayGroups.delete(g);
  for (const n of created) {
    const ch = channelOfAction(n.action);
    if (n.dueDate === today) { todayC[ch] += 1; todayGroups.add(`task:${n.id}`); peopleToday.add(subjectKeyOf(n)); peopleToReach.add(subjectKeyOf(n)); }
    else if (n.dueDate < today) { overdueC[ch] += 1; overdueGroups.add(`task:${n.id}`); peopleToReach.add(subjectKeyOf(n)); }
    else upcomingC[ch] += 1;
  }
  // Somebody with no work of their own (an admin, a leader) sees what is next for the team.
  let nextTasks = nextTouchpoints(rows, created, today);
  let nextForTeam = false;
  let teamRows: Array<Omit<OpenRow, 'fo'> & { foUserId: string }> | null = null;
  // Admins see everyone's; a pod's leaders see their pods'. Anyone else simply has nothing due.
  if (!rows.length && !created.length && (isAdmin(user) || isPodLeader(user))) {
    const pods = isAdmin(user) ? null : user.podIds;
    // Whose each one is comes from the board's own list of reps (buildHome), not a read per row.
    teamRows = await prisma.task.findMany({
      where: { AND: [taskScopeWhere(user), WORKABLE, { state: 'PENDING', ...(pods === null ? {} : { enrollment: { podId: { in: pods } } }) }] },
      select: { ...myRowSelect, foUserId: true },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: 400,
    });
    nextTasks = [];
    nextForTeam = true;
  }
  return { today: todayC, overdue: overdueC, upcoming: upcomingC, todayGroups: todayGroups.size, overdueGroups: overdueGroups.size, peopleToday: peopleToday.size, peopleToReach: peopleToReach.size, nextTasks, nextForTeam, teamRows, openSteps, createdDoneToday, doneToday };
}

/**
 * One FO on the week's board. The week's total is exactly done + overdue + today + later, so every
 * part of "X of Y done" is a column beside it. Then what came back (replies, meetings held, with those
 * booked beside them, never added: rule 7), the calls made, and the post-call forms still waiting,
 * with the oldest one's due time (N046).
 */
export type TeamRow = { id: string; name: string; pod: string | null; done: number; overdue: number; today: number; later: number; replies: number; meetings: number; booked: number; calls: number; formsWaiting: number; oldestFormAt: Date | null };
export const weekTotal = (r: Pick<TeamRow, 'done' | 'overdue' | 'today' | 'later'>) => r.done + r.overdue + r.today + r.later;
/** A row with anything on it this week: work, results, calls or a form still waiting. */
export const teamRowActive = (r: TeamRow) => weekTotal(r) + r.replies + r.meetings + r.booked + r.calls + r.formsWaiting > 0;

/**
 * Per-FO figures for the working week (Monday to Sunday), for everyone who carries outreach.
 * Work is counted the way the Tasks tabs count it - one person's step is one, and a task someone
 * created for a person is one - so each figure matches the FO's own Tasks page:
 * - Done: finished this week (a step counts once nothing in it is still open).
 * - Overdue and Due today: open now, as on the Overdue and Today tabs.
 * - Later this week: open and due after today but by Sunday, plus the campaign-calendar steps dated
 *   this week that have not opened yet.
 * Replies, meetings and calls come from the shared metrics module, defined once, as Reports counts
 * them (B096). Forms waiting are the backlog now, whatever the week (N046).
 */
async function teamThisWeek(user: SessionUser, today: LocalDate, week: { from: LocalDate; to: LocalDate; fromInstant: Date; toInstant: Date }, now: Date): Promise<TeamRow[]> {
  const leads = canSeeAllPods(user) || isPodLeader(user);
  const pods = visiblePodIds(user);
  const users = leads
    ? await prisma.user.findMany({
        where: { active: true, role: { in: ROLES_NEEDING_POD }, ...(pods === null ? {} : { pods: { some: { podId: { in: pods } } } }) },
        select: { id: true, name: true, twentyMemberId: true },
        orderBy: { name: 'asc' },
      })
    : [{ id: user.id, name: user.name, twentyMemberId: user.twentyMemberId }];
  if (!users.length) return [];
  const ids = users.map((u) => u.id);
  const taskScope = taskScopeWhere(user);
  const enrollmentScope: Prisma.EnrollmentWhereInput = pods === null ? workWhere('all') : { AND: [workWhere('all'), { OR: [{ podId: { in: pods } }, { foUserId: user.id }] }] };
  const inWeek = { gte: week.fromInstant, lt: week.toInstant };
  const period = { from: week.fromInstant, to: week.toInstant };

  const [taskRows, podRows, replies, meetings, dials, waiting, planned, created] = await Promise.all([
    // What is open now and what was finished this week, in one read.
    prisma.task.findMany({ where: { AND: [taskScope, { foUserId: { in: ids } }, { OR: [{ AND: [WORKABLE, { state: 'PENDING' }] }, { state: 'DONE', completedAt: inWeek }] }] }, select: { foUserId: true, state: true, dueDate: true, snoozedTo: true, enrollmentId: true, stepId: true } }),
    prisma.$queryRaw<Array<{ userId: string; name: string; archived: boolean }>>`SELECT up."userId", p."name", p."archived" FROM "UserPod" up JOIN "Pod" p ON p."id" = up."podId" WHERE up."userId" = ANY(${ids}) ORDER BY p."name"`,
    // What came back and what was booked, held and dialled, as Reports counts them (B096, 8.14).
    repliesByRep(ids, 'all', period),
    meetingsByRep(ids, 'all', period, now),
    dialsByRep(ids, 'all', period),
    formsWaiting(),
    // Campaign calendars: every step dated this week, open yet or not.
    prisma.enrollment.findMany({ where: { AND: [enrollmentScope, { foUserId: { in: ids }, status: 'ACTIVE', scheduleDates: { isEmpty: false } }] }, select: { id: true, foUserId: true, currentStep: true, scheduleDates: true } }),
    prisma.nextAction.findMany({ where: { AND: [workWhere('all'), { foUserId: { in: ids }, OR: [{ state: 'OPEN', dueDate: { lte: week.to } }, { lastDoneAt: inWeek }] }] }, select: { id: true, foUserId: true, dueDate: true, state: true, lastDoneAt: true } }),
  ]);
  const pending = taskRows.filter((t) => t.state === 'PENDING');
  const doneRows = taskRows.filter((t) => t.state === 'DONE');
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

  const rows: TeamRow[] = users.map((u) => {
    const r = by.get(u.id);
    return {
      id: u.id,
      name: u.name,
      pod: podRows.find((p) => p.userId === u.id && !p.archived)?.name ?? null,
      done: r?.done.size ?? 0,
      overdue: r?.overdue.size ?? 0,
      today: r?.today.size ?? 0,
      later: r?.later.size ?? 0,
      replies: replies.get(u.id) ?? 0,
      meetings: meetings.held.get(u.id) ?? 0,
      booked: meetings.booked.get(u.id) ?? 0,
      calls: dials.get(u.id) ?? 0,
      formsWaiting: waiting.get(u.id)?.count ?? 0,
      oldestFormAt: waiting.get(u.id)?.oldest ?? null,
    };
  });
  // B032: a rep with nothing this week simply has no row: nobody is named for having no work.
  // Who owes most comes first.
  return rows
    .filter(teamRowActive)
    .sort((a, b) => b.today + b.overdue - (a.today + a.overdue) || weekTotal(b) - weekTotal(a) || a.name.localeCompare(b.name));
}
