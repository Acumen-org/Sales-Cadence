import { workTaskWhere, workWhere, type AudienceScope } from './subject';
import { needsPod, ROLES_NEEDING_POD } from '@/lib/auth/rbac';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isPodLeader, canSeeAllPods } from './auth/rbac';
import { addDays, startOfLocalDay, todayIn, type LocalDate } from './dates';
import { workspaceTimezone } from './workspace';

/** How far back the Done tab looks. Older work lives on the person record and in Activity. */
export const DONE_TAB_DAYS = 30;

export type TaskTab = 'today' | 'overdue' | 'upcoming' | 'done';
export const TASK_TABS: TaskTab[] = ['today', 'overdue', 'upcoming', 'done'];

export type TaskChannel = 'EMAIL' | 'CALL' | 'LINKEDIN';
export const TASK_CHANNELS: TaskChannel[] = ['CALL', 'EMAIL', 'LINKEDIN'];

/**
 * Whose work a Tasks screen lists (cold outreach D2): CRM and cold work together on /tasks, or cold
 * work only, as Cold outreach > Tasks shows it. Rows carry no tag either way.
 */
export type TaskAudience = Extract<AudienceScope, 'all' | 'cold'>;
export const parseTaskAudience = (v: string | undefined | null): TaskAudience => (v === 'cold' ? 'cold' : 'all');
/** The address of Cold outreach > Tasks until the section mounts the screen itself (S10): cold work only, and no filter carried over from Contacts (B158). */
export const COLD_TASKS_HREF = '/tasks?audience=cold';

export type TaskFilters = {
  tab: TaskTab;
  podId?: string | null;
  foUserId?: string | null;
  /** Outreach-style task type bucket. */
  channel?: TaskChannel | null;
  /** All work (default), or cold work only. */
  audience?: TaskAudience;
};

export function channelWhere(channel: TaskChannel | null | undefined): Prisma.TaskWhereInput {
  if (!channel) return {};
  if (channel === 'LINKEDIN') return { action: { in: ['LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE'] } };
  return { action: channel };
}

export function parseChannel(v: string | undefined): TaskChannel | null {
  return TASK_CHANNELS.includes(v as TaskChannel) ? (v as TaskChannel) : null;
}

/** What a cold row shows and acts on: the contact's name, firm, ways to reach them and bounce flags. */
export const coldContactSelect = { id: true, firstName: true, lastName: true, companyName: true, jobTitle: true, email: true, phone: true, linkedinUrl: true, status: true, state: true, companyState: true, country: true, ownerId: true, podId: true, badEmail: true, possibleBounceAt: true, crmMatchPersonId: true, crmAutoPersonId: true } satisfies Prisma.SandboxContactSelect;

export const taskRowInclude = {
  enrollment: { include: { person: true, sandboxContact: { select: coldContactSelect }, sequence: { select: { id: true, name: true } }, pod: { select: { id: true, name: true } }, campaign: { select: { id: true, name: true, endDate: true, status: true } } } },
  fo: { select: { id: true, name: true, timezone: true, twentyMemberId: true } },
} satisfies Prisma.TaskInclude;

export type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskRowInclude }>;
/** A task in a CRM view: its person is there. */
export type CrmTaskRow = TaskRow & { enrollment: TaskRow['enrollment'] & { person: NonNullable<TaskRow['enrollment']['person']> } };
export const hasPerson = <T extends { enrollment: { person: unknown } }>(t: T): t is T & { enrollment: T['enrollment'] & { person: NonNullable<T['enrollment']['person']> } } => Boolean(t.enrollment.person);

/** The name and firm a row shows, whichever kind of subject it is about. */
export function rowSubject(e: { person: { firstName: string; lastName: string; email: string | null; companyName: string | null } | null; sandboxContact: { firstName: string; lastName: string; email: string | null; companyName: string | null } | null }): { name: string; companyName: string | null } {
  const who = e.person ?? e.sandboxContact;
  return { name: (who ? `${who.firstName} ${who.lastName}`.trim() || who.email : null) || 'Unnamed', companyName: who?.companyName ?? null };
}

/** The day a task is worked: its snoozed day if snoozed, else its due day. */
export function effectiveDate(t: { dueDate: string; snoozedTo: string | null }): LocalDate {
  return t.snoozedTo ?? t.dueDate;
}

/**
 * Open work somebody can actually do.
 *
 * A paused campaign has stopped, so its open touches are held. This lives here, next to the scope,
 * because every figure has to agree with the list: a sidebar badge or a Home tile that counts work
 * the Tasks page then refuses to show is worse than no figure at all.
 */
export const WORKABLE: Prisma.TaskWhereInput = { enrollment: { status: { not: 'PAUSED' } } };

/**
 * Tasks a view may show this user (everyone reads every pod). The subject decides the rest, through
 * the subject layer (PLAN 8.13): a CRM person's step, or a cold contact's that has not moved and is
 * still active (B009), so a contact that was opted out, removed or moved has no work anywhere.
 */
export function taskScopeWhere(user: SessionUser, audience: AudienceScope = 'all'): Prisma.TaskWhereInput {
  const scope = workTaskWhere(audience);
  if (canSeeAllPods(user)) return scope;
  if (isPodLeader(user)) {
    return { AND: [scope, { OR: [{ foUserId: user.id }, { enrollment: { podId: { in: user.podIds } } }] }] };
  }
  return { AND: [scope, { foUserId: user.id }] };
}

function effectiveDateWhere(op: 'eq' | 'lt' | 'gt', date: LocalDate): Prisma.TaskWhereInput {
  const cond = op === 'eq' ? { equals: date } : op === 'lt' ? { lt: date } : { gt: date };
  return { OR: [{ snoozedTo: null, dueDate: cond }, { snoozedTo: { not: null, ...cond } }] };
}

export function tabWhere(tab: TaskTab, today: LocalDate): Prisma.TaskWhereInput {
  switch (tab) {
    case 'today':
      return { state: 'PENDING', ...effectiveDateWhere('eq', today) };
    case 'overdue':
      return { state: 'PENDING', ...effectiveDateWhere('lt', today) };
    case 'upcoming':
      return { state: 'PENDING', ...effectiveDateWhere('gt', today) };
    case 'done':
      // Recently resolved work, not the whole history: an unbounded tab makes its own count
      // meaningless and grows without limit. Older work lives on the person and in Activity.
      return { state: { in: ['DONE', 'SKIPPED'] }, updatedAt: { gte: startOfLocalDay(addDays(today, -DONE_TAB_DAYS), workspaceTimezone()) } };
  }
}

function filtersWhere(f: TaskFilters): Prisma.TaskWhereInput {
  const where: Prisma.TaskWhereInput = {};
  if (f.podId) where.enrollment = { podId: f.podId };
  if (f.foUserId) where.foUserId = f.foUserId;
  return where;
}

/** Pods and FOs the user may filter by. The reader is always one of the FOs, so "mine" is a choice for every role (B162). */
export async function filterOptions(user: SessionUser) {
  if (!canSeeAllPods(user) && !isPodLeader(user)) return { pods: [], fos: [] };
  const podWhere = canSeeAllPods(user) ? { archived: false } : { archived: false, id: { in: user.podIds } };
  const pods = await prisma.pod.findMany({ where: podWhere, orderBy: { name: 'asc' }, include: { users: { include: { user: { select: { id: true, name: true, active: true, role: true } } } } } });
  const fos = new Map<string, { id: string; name: string; podIds: string[] }>();
  for (const pod of pods) {
    for (const up of pod.users) {
      if (!up.user.active && needsPod(up.user.role)) continue;
      const existing = fos.get(up.user.id) ?? { id: up.user.id, name: up.user.name, podIds: [] };
      existing.podIds.push(pod.id);
      fos.set(up.user.id, existing);
    }
  }
  if (canSeeAllPods(user)) {
    const others = await prisma.user.findMany({ where: { active: true, role: { in: ROLES_NEEDING_POD }, id: { notIn: [...fos.keys()] } }, select: { id: true, name: true } });
    for (const o of others) fos.set(o.id, { id: o.id, name: o.name, podIds: [] });
  }
  if (!fos.has(user.id)) fos.set(user.id, { id: user.id, name: user.name, podIds: [] });
  return { pods: pods.map((p) => ({ id: p.id, name: p.name })), fos: [...fos.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export function parseTab(v: string | undefined): TaskTab {
  return TASK_TABS.includes(v as TaskTab) ? (v as TaskTab) : 'today';
}

/** Steps held by a pause: which campaign, why (the campaign, or a colleague's reply), who paused it, how many (B160). */
export type HeldCampaign = { campaignId: string | null; name: string; why: 'campaign' | 'colleague' | 'other'; pausedBy: string | null; steps: number };

/** One workspace item per contact and touchpoint; each required action retains its own result. */
export async function listTaskGroups(user: SessionUser, filters: TaskFilters, now = new Date(), limit = 200) {
  const today = todayIn(user.timezone, now);
  const recent = startOfLocalDay(addDays(today, -DONE_TAB_DAYS), workspaceTimezone());
  const records = await prisma.task.findMany({ where: { AND: [taskScopeWhere(user, filters.audience ?? 'all'), filtersWhere(filters), { OR: [{ state: 'PENDING' }, { state: { in: ['DONE', 'SKIPPED'] }, updatedAt: { gte: recent } }] }] }, select: { id: true, enrollmentId: true, stepId: true, state: true, action: true, dueDate: true, snoozedTo: true, completedAt: true, updatedAt: true, enrollment: { select: { status: true, campaignId: true, pauseReason: true } } }, orderBy: [{ dueAt: 'asc' }, { actionIndex: 'asc' }] });
  const grouped = new Map<string, typeof records>();
  for (const t of records) { const key = `${t.enrollmentId}:${t.stepId}`; const group = grouped.get(key) ?? []; group.push(t); grouped.set(key, group); }
  const counts: Record<TaskTab, number> = { today: 0, overdue: 0, upcoming: 0, done: 0 };
  const channelCounts: Record<TaskChannel, number> = { CALL: 0, EMAIL: 0, LINKEDIN: 0 };
  const selected: Array<{ id: string; ids: string[]; tab: TaskTab; at: number; date: string }> = [];
  const heldIn = new Map<string, number>();
  let held = 0;
  for (const group of grouped.values()) {
    const pending = group.filter(t => t.state === 'PENDING');
    // A paused campaign has stopped: its open touches are held, so they are not anybody's work
    // today. Steps that are already resolved stay in Done, because that is history.
    if (pending.length && group[0].enrollment.status === 'PAUSED') {
      held++;
      const e = group[0].enrollment;
      const key = `${e.campaignId ?? ''}|${e.pauseReason === 'campaign_paused' ? 'campaign' : e.pauseReason?.startsWith('colleague_replied') ? 'colleague' : 'other'}`;
      heldIn.set(key, (heldIn.get(key) ?? 0) + 1);
      continue;
    }
    const current = pending.length ? pending : group;
    const date = current.map(effectiveDate).sort()[0];
    const tab: TaskTab = !pending.length ? 'done' : date < today ? 'overdue' : date === today ? 'today' : 'upcoming';
    const channels = new Set(current.map(t => t.action === 'EMAIL' ? 'EMAIL' : t.action === 'CALL' ? 'CALL' : 'LINKEDIN'));
    if (tab === filters.tab) for (const c of channels) channelCounts[c]++;
    if (filters.channel && !channels.has(filters.channel)) continue;
    counts[tab]++;
    if (tab === filters.tab) selected.push({ id: current[0].id, ids: group.map(t => t.id), tab, date, at: Math.max(...current.map(t => (t.completedAt ?? t.updatedAt).getTime())) });
  }
  selected.sort((a, b) => filters.tab === 'done' ? b.at - a.at : a.date.localeCompare(b.date));
  const page = selected.slice(0, limit);
  const [rows, heldBy] = await Promise.all([
    prisma.task.findMany({ where: { id: { in: page.map(g => g.id) } }, include: taskRowInclude }),
    heldCampaigns(heldIn),
  ]);
  const byId = new Map(rows.map(t => [t.id, t]));
  return { rows: page.flatMap(g => { const row = byId.get(g.id); return row ? [{ ...row, childIds: g.ids, childActions: records.filter(t => g.ids.includes(t.id)).map(t => ({ id: t.id, action: t.action, state: t.state })) }] : []; }), counts, channelCounts, today, total: selected.length, held, heldBy };
}

/** The campaigns holding steps, by name, with who paused each (the latest pause in its audit). */
async function heldCampaigns(heldIn: Map<string, number>): Promise<HeldCampaign[]> {
  if (!heldIn.size) return [];
  const ids = [...new Set([...heldIn.keys()].map((k) => k.split('|')[0]).filter(Boolean))];
  const [campaigns, pauses] = ids.length ? await Promise.all([
    prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.auditLog.findMany({ where: { entityType: 'campaign', entityId: { in: ids }, action: 'paused' }, orderBy: { createdAt: 'desc' }, select: { entityId: true, actorLabel: true } }),
  ]) : [[], []];
  return [...heldIn.entries()].map(([key, steps]) => {
    const [id, why] = key.split('|') as [string, HeldCampaign['why']];
    return { campaignId: id || null, name: campaigns.find((c) => c.id === id)?.name ?? 'Outreach', why, pausedBy: why === 'campaign' ? pauses.find((p) => p.entityId === id)?.actorLabel ?? null : null, steps };
  }).sort((a, b) => b.steps - a.steps);
}

/** "3 steps held: Q4 Harbor paused by Leigh Chen" (B160). */
export function heldWords(heldBy: HeldCampaign[]): string {
  const steps = heldBy.reduce((n, h) => n + h.steps, 0);
  const each = heldBy.map((h) => (h.why === 'colleague' ? `${h.name}, paused because a colleague at the firm replied` : `${h.name} paused${h.pausedBy ? ` by ${h.pausedBy}` : ''}`)).join('; ');
  return `${steps} ${steps === 1 ? 'step' : 'steps'} held: ${each}`;
}

// ---------------------------------------------------------------------------
// Next actions (tasks outside any campaign), counted with the steps in the same tabs
// ---------------------------------------------------------------------------

export const nextActionListInclude = {
  person: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true, phone: true, linkedinUrl: true, jobTitle: true } },
  sandboxContact: { select: coldContactSelect },
  fo: { select: { id: true, name: true } },
} satisfies Prisma.NextActionInclude;
export type NextActionListRow = Prisma.NextActionGetPayload<{ include: typeof nextActionListInclude }>;

/** Next actions in view of the Tasks filters: whose (FO), which pod, which audience. */
export function nextActionScopeWhere(f: { podId?: string | null; foUserId?: string | null; audience?: AudienceScope }): Prisma.NextActionWhereInput {
  return {
    AND: [
      workWhere(f.audience ?? 'all'),
      f.foUserId ? { foUserId: f.foUserId } : {},
      // A CRM person's next action is in the pods of its FO; a cold contact's is in the contact's pod.
      f.podId ? { OR: [{ personId: { not: null }, fo: { pods: { some: { podId: f.podId } } } }, { personId: null, sandboxContact: { podId: f.podId } }] } : {},
    ],
  };
}

const nextTabWhere = (tab: TaskTab, today: LocalDate, recentDone: Date): Prisma.NextActionWhereInput =>
  tab === 'done' ? { lastDoneAt: { gte: recentDone } } : { state: 'OPEN', dueDate: tab === 'overdue' ? { lt: today } : tab === 'today' ? today : { gt: today } };

const channelOfAction = (action: string): TaskChannel => (action === 'EMAIL' ? 'EMAIL' : action === 'CALL' ? 'CALL' : 'LINKEDIN');

/**
 * The next actions of one tab, and real counts for every tab (N030): counted in the database, never
 * from a capped list, so a large backlog can never hide Today's count.
 */
export async function listNextActionItems(user: SessionUser, filters: TaskFilters, now = new Date(), limit = 200) {
  const today = todayIn(user.timezone, now);
  const recentDone = startOfLocalDay(addDays(today, -DONE_TAB_DAYS), user.timezone);
  const scope = nextActionScopeWhere({ podId: filters.podId, foUserId: filters.foUserId, audience: filters.audience });
  const [byTab, rows] = await Promise.all([
    Promise.all(TASK_TABS.map((tab) => prisma.nextAction.groupBy({ by: ['action'], where: { AND: [scope, nextTabWhere(tab, today, recentDone)] }, _count: { _all: true } }))),
    prisma.nextAction.findMany({
      where: { AND: [scope, nextTabWhere(filters.tab, today, recentDone), filters.channel === 'LINKEDIN' ? { action: { in: ['LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE'] } } : filters.channel ? { action: filters.channel } : {}] },
      include: nextActionListInclude,
      orderBy: filters.tab === 'done' ? { lastDoneAt: 'desc' } : [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    }),
  ]);
  const counts: Record<TaskTab, number> = { today: 0, overdue: 0, upcoming: 0, done: 0 };
  const channelCounts: Record<TaskChannel, number> = { CALL: 0, EMAIL: 0, LINKEDIN: 0 };
  TASK_TABS.forEach((tab, i) => {
    for (const g of byTab[i]) {
      const ch = channelOfAction(g.action);
      if (!filters.channel || ch === filters.channel) counts[tab] += g._count._all;
      if (tab === filters.tab && tab !== 'done') channelCounts[ch] += g._count._all;
    }
  });
  return { rows, counts, channelCounts, today, total: counts[filters.tab] };
}

/**
 * One count for the sidebar badge and the list it opens (B117): a person's step is one, on the tab
 * of its earliest open action, as listTaskGroups puts it; a next action is one. Only what is due
 * today or earlier, of the work this user is the FO of, in the audience asked for.
 */
export async function dueCounts(foUserId: string, audience: AudienceScope, today: LocalDate): Promise<{ today: number; overdue: number }> {
  const [tasks, next] = await Promise.all([
    prisma.task.findMany({ where: { AND: [workTaskWhere(audience), WORKABLE, { foUserId, state: 'PENDING' }, { OR: [{ snoozedTo: null, dueDate: { lte: today } }, { snoozedTo: { not: null, lte: today } }] }] }, select: { enrollmentId: true, stepId: true, dueDate: true, snoozedTo: true } }),
    prisma.nextAction.findMany({ where: { AND: [workWhere(audience), { foUserId, state: 'OPEN', dueDate: { lte: today } }] }, select: { dueDate: true } }),
  ]);
  const earliest = new Map<string, string>();
  for (const t of tasks) {
    const key = `${t.enrollmentId}:${t.stepId}`;
    const day = effectiveDate(t);
    const seen = earliest.get(key);
    if (!seen || day < seen) earliest.set(key, day);
  }
  let dueToday = 0;
  let overdue = 0;
  for (const day of [...earliest.values(), ...next.map((n) => n.dueDate)]) {
    if (day < today) overdue++;
    else dueToday++;
  }
  return { today: dueToday, overdue };
}
