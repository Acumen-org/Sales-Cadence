import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isAdmin, isPodLeader } from './auth/rbac';
import { addDays, startOfLocalDay, todayIn, type LocalDate } from './dates';
import { WORKSPACE_TIMEZONE } from './workspace';

/** How far back the Done tab looks. Older work lives on the person record and in Activity. */
export const DONE_TAB_DAYS = 30;

export type TaskTab = 'today' | 'overdue' | 'upcoming' | 'done';
export const TASK_TABS: TaskTab[] = ['today', 'overdue', 'upcoming', 'done'];

export type TaskChannel = 'EMAIL' | 'CALL' | 'LINKEDIN';
export const TASK_CHANNELS: TaskChannel[] = ['CALL', 'EMAIL', 'LINKEDIN'];

export type TaskFilters = {
  tab: TaskTab;
  podId?: string | null;
  foUserId?: string | null;
  /** Outreach-style task type bucket. */
  channel?: TaskChannel | null;
};

export function channelWhere(channel: TaskChannel | null | undefined): Prisma.TaskWhereInput {
  if (!channel) return {};
  if (channel === 'LINKEDIN') return { action: { in: ['LINKEDIN_CONNECT', 'LINKEDIN_MESSAGE'] } };
  return { action: channel };
}

export function parseChannel(v: string | undefined): TaskChannel | null {
  return TASK_CHANNELS.includes(v as TaskChannel) ? (v as TaskChannel) : null;
}

export const taskRowInclude = {
  enrollment: { include: { person: true, sequence: { select: { id: true, name: true } }, pod: { select: { id: true, name: true } }, campaign: { select: { id: true, name: true } } } },
  fo: { select: { id: true, name: true, timezone: true, twentyMemberId: true } },
} satisfies Prisma.TaskInclude;

export type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskRowInclude }>;

/** The day a task is worked: its snoozed day if snoozed, else its due day. */
export function effectiveDate(t: { dueDate: string; snoozedTo: string | null }): LocalDate {
  return t.snoozedTo ?? t.dueDate;
}

/** Tasks the user may see at all (before filters). Junior: own. Senior: own + pods. Admin: all. */
export function taskScopeWhere(user: SessionUser): Prisma.TaskWhereInput {
  if (isAdmin(user)) return {};
  if (isPodLeader(user)) {
    return { OR: [{ foUserId: user.id }, { enrollment: { podId: { in: user.podIds } } }] };
  }
  return { foUserId: user.id };
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
      return { state: { in: ['DONE', 'SKIPPED'] }, updatedAt: { gte: startOfLocalDay(addDays(today, -DONE_TAB_DAYS), WORKSPACE_TIMEZONE) } };
  }
}

function filtersWhere(f: TaskFilters): Prisma.TaskWhereInput {
  const where: Prisma.TaskWhereInput = {};
  if (f.podId) where.enrollment = { podId: f.podId };
  if (f.foUserId) where.foUserId = f.foUserId;
  return where;
}

export type TaskListResult = {
  rows: TaskRow[];
  counts: Record<TaskTab, number>;
  /** Pending tasks in the current tab per channel (before the channel filter). */
  channelCounts: Record<TaskChannel, number>;
  today: LocalDate;
};

export async function listTasks(user: SessionUser, filters: TaskFilters, now = new Date(), limit = 500): Promise<TaskListResult> {
  const today = todayIn(user.timezone, now);
  const scoped: Prisma.TaskWhereInput = { AND: [taskScopeWhere(user), filtersWhere(filters)] };
  const base: Prisma.TaskWhereInput = { AND: [scoped, channelWhere(filters.channel)] };
  // One grouped query covers all three channel buckets for the current tab.
  const channelGroups = await prisma.task.groupBy({ by: ['action'], where: { AND: [scoped, tabWhere(filters.tab, today)] }, _count: { _all: true } });
  const channelCounts: Record<TaskChannel, number> = { CALL: 0, EMAIL: 0, LINKEDIN: 0 };
  for (const g of channelGroups) {
    const key: TaskChannel = g.action === 'CALL' ? 'CALL' : g.action === 'EMAIL' ? 'EMAIL' : 'LINKEDIN';
    channelCounts[key] += g._count._all;
  }
  const [rows, ...countValues] = await Promise.all([
    prisma.task.findMany({
      where: { AND: [base, tabWhere(filters.tab, today)] },
      include: taskRowInclude,
      orderBy:
        filters.tab === 'done'
          ? [{ completedAt: 'desc' }, { updatedAt: 'desc' }]
          : [{ dueAt: 'asc' }, { enrollment: { person: { lastName: 'asc' } } }, { stepIndex: 'asc' }, { actionIndex: 'asc' }],
      take: limit,
    }),
    ...TASK_TABS.map((tab) => prisma.task.count({ where: { AND: [base, tabWhere(tab, today)] } })),
  ]);
  // Snoozed tasks sort by their snoozed day, not the original due instant.
  if (filters.tab !== 'done') {
    rows.sort((a, b) => effectiveDate(a).localeCompare(effectiveDate(b)) || a.dueAt.getTime() - b.dueAt.getTime());
  }
  const counts = Object.fromEntries(TASK_TABS.map((tab, i) => [tab, countValues[i]])) as Record<TaskTab, number>;
  return { rows, counts, channelCounts, today };
}

/** Pods and FOs the user may filter by. */
export async function filterOptions(user: SessionUser) {
  if (!isAdmin(user) && !isPodLeader(user)) return { pods: [], fos: [] };
  const podWhere = isAdmin(user) ? { archived: false } : { archived: false, id: { in: user.podIds } };
  const pods = await prisma.pod.findMany({ where: podWhere, orderBy: { name: 'asc' }, include: { users: { include: { user: { select: { id: true, name: true, active: true } } } } } });
  const fos = new Map<string, { id: string; name: string; podIds: string[] }>();
  for (const pod of pods) {
    for (const up of pod.users) {
      if (!up.user.active) continue;
      const existing = fos.get(up.user.id) ?? { id: up.user.id, name: up.user.name, podIds: [] };
      existing.podIds.push(pod.id);
      fos.set(up.user.id, existing);
    }
  }
  if (isAdmin(user)) {
    const others = await prisma.user.findMany({ where: { active: true, id: { notIn: [...fos.keys()] } }, select: { id: true, name: true } });
    for (const o of others) fos.set(o.id, { id: o.id, name: o.name, podIds: [] });
  }
  return { pods: pods.map((p) => ({ id: p.id, name: p.name })), fos: [...fos.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export function parseTab(v: string | undefined): TaskTab {
  return TASK_TABS.includes(v as TaskTab) ? (v as TaskTab) : 'today';
}

/** One workspace item per contact and touchpoint; each required action retains its own result. */
export async function listTaskGroups(user: SessionUser, filters: TaskFilters, now = new Date(), limit = 200) {
  const today = todayIn(user.timezone, now);
  const records = await prisma.task.findMany({ where: { AND: [taskScopeWhere(user), filtersWhere(filters)], state: { in: ['PENDING', 'DONE', 'SKIPPED'] } }, select: { id: true, enrollmentId: true, stepId: true, state: true, action: true, dueDate: true, snoozedTo: true, completedAt: true, updatedAt: true, enrollment: { select: { status: true } } }, orderBy: [{ dueAt: 'asc' }, { actionIndex: 'asc' }] });
  const grouped = new Map<string, typeof records>();
  for (const t of records) { const key = `${t.enrollmentId}:${t.stepId}`; const group = grouped.get(key) ?? []; group.push(t); grouped.set(key, group); }
  const counts: Record<TaskTab, number> = { today: 0, overdue: 0, upcoming: 0, done: 0 };
  const channelCounts: Record<TaskChannel, number> = { CALL: 0, EMAIL: 0, LINKEDIN: 0 };
  const selected: Array<{ id: string; ids: string[]; tab: TaskTab; at: number; date: string }> = [];
  for (const group of grouped.values()) {
    const pending = group.filter(t => t.state === 'PENDING');
    // A paused campaign has stopped: its open touches are held, so they are not anybody's work
    // today. Steps that are already resolved stay in Done, because that is history.
    if (pending.length && group[0].enrollment.status === 'PAUSED') continue;
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
  const rows = await prisma.task.findMany({ where: { id: { in: page.map(g => g.id) } }, include: taskRowInclude });
  const byId = new Map(rows.map(t => [t.id, t]));
  return { rows: page.flatMap(g => { const row = byId.get(g.id); return row ? [{ ...row, childIds: g.ids, childActions: records.filter(t => g.ids.includes(t.id)).map(t => ({ id: t.id, action: t.action, state: t.state })) }] : []; }), counts, channelCounts, today, total: selected.length };
}
