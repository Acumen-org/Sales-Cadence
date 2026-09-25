import type { Prisma } from '@prisma/client';
import { workspaceTimezone } from './workspace';
import { prisma } from './db';
import { enrollmentByReply, REPLY_TOUCH_WHERE } from './reply-credit';
import type { SessionUser } from './auth/current-user';
import { isJuniorFo, visiblePodIds } from './auth/rbac';
import { addDays, dayOfWeek, diffDays, isLocalDate, startOfLocalDay, toLocalDate, type LocalDate } from './dates';
import { ACTION_LABELS, type ActionType } from './sequences/steps';

export type GroupRow = {
  key: string;
  label: string;
  enrolled: number;
  active: number;
  replied: number;
  meeting: number;
  completed: number;
  exited: number;
  replyRate: number;
  meetingRate: number;
  tasksDone: number;
  tasksSkipped: number;
  overdue: number;
};

export const reportingTimezone = () => workspaceTimezone();
export type ReportingRange = { from: LocalDate; to: LocalDate; fromInstant: Date; toInstant: Date; error: string | null };

/** Inclusive calendar dates, translated to a half-open Central Time interval (including DST). */
export function reportingRange(from: string | undefined, to: string | undefined, today: LocalDate, defaultDays = 28): ReportingRange {
  let first = from || addDays(today, 1 - defaultDays);
  let last = to || today;
  let error: string | null = null;
  if (!isLocalDate(first) || !isLocalDate(last) || first > last) {
    error = 'Choose valid dates with the start on or before the end.';
    first = addDays(today, 1 - defaultDays);
    last = today;
  }
  return { from: first, to: last, fromInstant: startOfLocalDay(first, reportingTimezone()), toInstant: startOfLocalDay(addDays(last, 1), reportingTimezone()), error };
}

/**
 * The period a range is read against. A week to date is compared with the same days a week before,
 * so a Monday is never set against a weekend; a whole month with the whole month before; a month to
 * date with the same days of the month before. Anything else: the same number of days just before it.
 */
export function comparisonRange(from: LocalDate, to: LocalDate): { from: LocalDate; to: LocalDate } {
  const length = diffDays(from, to) + 1;
  if (dayOfWeek(from) === 0 && length <= 7) return { from: addDays(from, -7), to: addDays(to, -7) };
  if (from.endsWith('-01') && to.slice(0, 7) === from.slice(0, 7)) {
    const lastMonthEnd = addDays(from, -1), lastMonth = lastMonthEnd.slice(0, 7);
    if (addDays(to, 1).endsWith('-01')) return { from: `${lastMonth}-01`, to: lastMonthEnd };
    const day = Math.min(Number(to.slice(8)), Number(lastMonthEnd.slice(8)));
    return { from: `${lastMonth}-01`, to: `${lastMonth}-${String(day).padStart(2, '0')}` };
  }
  return { from: addDays(from, -length), to: addDays(from, -1) };
}

export type ReportFilters = { range: ReportingRange; podId?: string | null; foUserId?: string | null };

type EnrollmentLite = { id: string; status: string; podId: string | null; foUserId: string; campaignId: string | null; createdAt: Date; repliedAt: Date | null; meetingAt: Date | null; completedAt: Date | null; exitedAt: Date | null };
type TaskLite = { enrollmentId: string; state: string; dueDate: string; snoozedTo: string | null; action: string; chosenAction: string | null; completionSource: string | null; foUserId: string };

function enrollmentScope(user: SessionUser): Prisma.EnrollmentWhereInput {
  if (isJuniorFo(user)) return { foUserId: user.id };
  const pods = visiblePodIds(user);
  if (pods === null) return {};
  return { OR: [{ podId: { in: pods } }, { foUserId: user.id }] };
}

function rollup(label: (e: EnrollmentLite) => { key: string; label: string } | null, enrollments: EnrollmentLite[], tasks: TaskLite[], today: LocalDate, replies: Map<string, Date[]>, range?: ReportingRange): GroupRow[] {
  const rows = new Map<string, GroupRow>();
  const byEnrollment = new Map<string, string>();
  for (const e of enrollments) {
    const k = label(e);
    if (!k) continue;
    byEnrollment.set(e.id, k.key);
    const row = rows.get(k.key) ?? { key: k.key, label: k.label, enrolled: 0, active: 0, replied: 0, meeting: 0, completed: 0, exited: 0, replyRate: 0, meetingRate: 0, tasksDone: 0, tasksSkipped: 0, overdue: 0 };
    const within = (at: Date | null) => !!at && (!range || (at >= range.fromInstant && at < range.toInstant));
    if (within(e.createdAt)) row.enrolled += 1;
    if (e.status === 'ACTIVE' || e.status === 'PAUSED') row.active += 1;
    // Replies are the messages credited to this enrollment (reply-credit.ts), counted as messages.
    row.replied += (replies.get(e.id) ?? []).filter((at) => !range || (at >= range.fromInstant && at < range.toInstant)).length;
    if (range ? within(e.meetingAt) : e.status === 'MEETING') row.meeting += 1;
    if (range ? within(e.completedAt) : e.status === 'COMPLETED') row.completed += 1;
    if (range ? within(e.exitedAt) : e.status === 'EXITED') row.exited += 1;
    rows.set(k.key, row);
  }
  for (const t of tasks) {
    const key = byEnrollment.get(t.enrollmentId);
    if (!key) continue;
    const row = rows.get(key)!;
    if (t.state === 'DONE') row.tasksDone += 1;
    else if (t.state === 'SKIPPED') row.tasksSkipped += 1;
    else if (t.state === 'PENDING' && (t.snoozedTo ?? t.dueDate) < today) row.overdue += 1;
  }
  for (const row of rows.values()) {
    // Rates use the enrollment cohort, while event counts above use the selected dates.
    const cohort = enrollments.filter((e) => byEnrollment.get(e.id) === row.key && (!range || (e.createdAt >= range.fromInstant && e.createdAt < range.toInstant)));
    const engaged = cohort.filter((e) => range ? !e.exitedAt || e.exitedAt >= range.toInstant : e.status !== 'EXITED');
    const replied = (e: EnrollmentLite) => (replies.get(e.id) ?? []).some((at) => !range || at < range.toInstant);
    const meeting = (e: EnrollmentLite) => range ? !!e.meetingAt && e.meetingAt < range.toInstant : !!e.meetingAt || e.status === 'MEETING';
    row.replyRate = engaged.length ? engaged.filter(replied).length / engaged.length : 0;
    row.meetingRate = engaged.length ? engaged.filter(meeting).length / engaged.length : 0;
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export type Reports = Awaited<ReturnType<typeof buildReports>>;

export async function buildReports(user: SessionUser, today: LocalDate, filters?: ReportFilters) {
  const range = filters?.range;
  const scope: Prisma.EnrollmentWhereInput = { AND: [enrollmentScope(user), ...(filters?.podId ? [{ podId: filters.podId }] : []), ...(filters?.foUserId ? [{ foUserId: filters.foUserId }] : [])] };
  const [enrollments, pods, users, campaigns] = await Promise.all([
    prisma.enrollment.findMany({ where: { AND: [scope, ...(range ? [{ createdAt: { lt: range.toInstant } }] : [])] }, select: { id: true, status: true, podId: true, foUserId: true, campaignId: true, createdAt: true, repliedAt: true, meetingAt: true, completedAt: true, exitedAt: true } }),
    prisma.pod.findMany({ select: { id: true, name: true, podOwnerValue: true } }),
    prisma.user.findMany({ select: { id: true, name: true, twentyMemberId: true } }),
    prisma.campaign.findMany({ select: { id: true, name: true } }),
  ]);
  // The same enrollments, as a join the database does, not a list of thousands of ids sent back to it.
  const enrolled: Prisma.EnrollmentWhereInput = { AND: [scope, ...(range ? [{ createdAt: { lt: range.toInstant } }] : [])] };
  const d28 = range?.fromInstant ?? startOfLocalDay(addDays(today, -27), reportingTimezone());
  const end = range?.toInstant ?? startOfLocalDay(addDays(today, 1), reportingTimezone());
  const podOwnerValue = filters?.podId ? pods.find((p) => p.id === filters.podId)?.podOwnerValue ?? '__none__' : null;
  const [tasks, inboundAll, doneTasks, meetingRows, settings] = await Promise.all([prisma.task.findMany({
    where: { enrollment: enrolled, ...(range ? { OR: [{ state: { in: ['DONE', 'SKIPPED'] }, completedAt: { gte: range.fromInstant, lt: range.toInstant } }, { state: { in: ['PENDING', 'CANCELLED'] }, dueDate: { gte: range.from, lte: range.to } }] } : {}) },
    // The enrollment's own status comes with it: a paused campaign's open touches are held, and
    // reporting them as scheduled is the one place that rule could still leak.
    select: { enrollmentId: true, state: true, dueDate: true, snoozedTo: true, action: true, chosenAction: true, completionSource: true, foUserId: true, enrollment: { select: { status: true } } },
  }),
  // Replies: what came back from people - inbound emails, calls and messages Twenty holds, machine
  // answers left out, plus calls they answered - credited to the enrollment whose outreach they
  // answer (reply-credit.ts) and through it to its FO, pod, campaign and sequence. Never the state
  // of a sequence. Without a range the rollups are all-time, so the messages are too.
  prisma.touch.findMany({
    where: { ...REPLY_TOUCH_WHERE, ...(range ? { occurredAt: { gte: range.fromInstant, lt: range.toInstant } } : {}), person: { deletedAt: null } },
    select: { id: true, occurredAt: true, personId: true, person: { select: { podOwner: true } } },
  }),
  prisma.task.findMany({
    where: { enrollment: enrolled, state: 'DONE', completedAt: { gte: d28, lt: end } },
    select: { foUserId: true, action: true, chosenAction: true, disposition: true, completedAt: true, completionSource: true },
  }),
  prisma.enrollment.findMany({ where: { ...scope, meetingAt: { gte: d28, lt: end } }, select: { foUserId: true, meetingAt: true } }),
  import('./settings').then((m) => m.getSettings()),
  ]);
  const name = (list: { id: string; name: string }[], id: string | null, fallback: string) => list.find((x) => x.id === id)?.name ?? fallback;

  const credited = await enrollmentByReply(inboundAll);
  const inbound = inboundAll.filter((t) => {
    const e = credited.get(t.id);
    if (filters?.podId) return e ? e.podId === filters.podId : t.person.podOwner === podOwnerValue;
    return true;
  });
  const replies = new Map<string, Date[]>();
  for (const t of inbound) { const e = credited.get(t.id); if (e) replies.set(e.id, [...(replies.get(e.id) ?? []), t.occurredAt]); }

  const byPod = rollup((e) => ({ key: e.podId ?? 'none', label: name(pods, e.podId, 'No pod') }), enrollments, tasks, today, replies, range);
  const byFo = rollup((e) => ({ key: e.foUserId, label: name(users, e.foUserId, 'Unknown') }), enrollments, tasks, today, replies, range);
  const byCampaign = rollup((e) => (e.campaignId ? { key: e.campaignId, label: name(campaigns, e.campaignId, 'Deleted campaign') } : { key: 'none', label: 'Not in a campaign' }), enrollments, tasks, today, replies, range);

  const channels = (Object.keys(ACTION_LABELS) as ActionType[]).map((action) => {
    const ts = tasks.filter((t) => (t.chosenAction ?? t.action) === action);
    return {
      action,
      label: ACTION_LABELS[action],
      pending: ts.filter((t) => t.state === 'PENDING' && t.enrollment.status !== 'PAUSED').length,
      overdue: ts.filter((t) => t.state === 'PENDING' && t.enrollment.status !== 'PAUSED' && (t.snoozedTo ?? t.dueDate) < today).length,
      done: ts.filter((t) => t.state === 'DONE').length,
      observed: ts.filter((t) => t.state === 'DONE' && t.completionSource && t.completionSource.startsWith('OBSERVED')).length,
      manual: ts.filter((t) => t.state === 'DONE' && t.completionSource === 'MANUAL').length,
      skipped: ts.filter((t) => t.state === 'SKIPPED').length,
      cancelled: ts.filter((t) => t.state === 'CANCELLED').length,
    };
  });


  // Only replies to outreach: a message from someone nobody has enrolled answers nothing here.
  const repliedRows = inbound
    .filter((t) => t.occurredAt >= d28 && t.occurredAt < end && credited.has(t.id))
    .map((t) => ({ foUserId: credited.get(t.id)!.foUserId, repliedAt: t.occurredAt as Date | null }))
    .filter((r) => !filters?.foUserId || r.foUserId === filters.foUserId);
  const answeredKeys = new Set(settings.rules.callDispositions.filter((d) => d.answered).map((d) => d.key));
  const activity = users
    .filter((u) => enrollments.some((e) => e.foUserId === u.id) || doneTasks.some((t) => t.foUserId === u.id))
    .map((u) => {
      const mine = doneTasks.filter((t) => t.foUserId === u.id);
      const window = (since: Date) => {
        const ts = mine.filter((t) => t.completedAt && t.completedAt >= since);
        const chosen = (t: (typeof ts)[number]) => t.chosenAction ?? t.action;
        return {
          emails: ts.filter((t) => chosen(t) === 'EMAIL').length,
          calls: ts.filter((t) => chosen(t) === 'CALL').length,
          answered: ts.filter((t) => chosen(t) === 'CALL' && t.disposition && answeredKeys.has(t.disposition)).length,
          linkedin: ts.filter((t) => chosen(t).startsWith('LINKEDIN')).length,
          observed: ts.filter((t) => t.completionSource?.startsWith('OBSERVED')).length,
          total: ts.length,
          replies: repliedRows.filter((r) => r.foUserId === u.id && r.repliedAt! >= since).length,
          meetings: meetingRows.filter((r) => r.foUserId === u.id && r.meetingAt! >= since).length,
        };
      };
      return { id: u.id, name: u.name, period: window(d28) };
    })
    .filter((row) => !range || row.period.total || row.period.replies || row.period.meetings || enrollments.some((e) => e.foUserId === row.id && e.createdAt >= range.fromInstant && e.createdAt < range.toInstant))
    .sort((a, b) => b.period.total - a.period.total || a.name.localeCompare(b.name));

  // Day by day across the range, for sparklines; the funnel of the cohort.
  const dayKey = (d: Date) => toLocalDate(d, reportingTimezone());
  const from = range?.from ?? toLocalDate(d28, reportingTimezone());
  const to = range?.to ?? today;
  const days: LocalDate[] = [];
  for (let d = from; d <= to && days.length < 400; d = addDays(d, 1)) days.push(d);
  const daily = days.map((date) => ({
    date,
    enrollments: enrollments.filter((e) => dayKey(e.createdAt) === date).length,
    tasksDone: doneTasks.filter((t) => t.completedAt && dayKey(t.completedAt) === date).length,
    replies: repliedRows.filter((r) => r.repliedAt && dayKey(r.repliedAt) === date).length,
    meetings: meetingRows.filter((r) => r.meetingAt && dayKey(r.meetingAt) === date).length,
    byChannel: {
      EMAIL: doneTasks.filter((t) => t.completedAt && dayKey(t.completedAt) === date && (t.chosenAction ?? t.action) === 'EMAIL').length,
      CALL: doneTasks.filter((t) => t.completedAt && dayKey(t.completedAt) === date && (t.chosenAction ?? t.action) === 'CALL').length,
      LINKEDIN: doneTasks.filter((t) => t.completedAt && dayKey(t.completedAt) === date && (t.chosenAction ?? t.action).startsWith('LINKEDIN')).length,
    },
  }));
  const cohort = range ? enrollments.filter((e) => e.createdAt >= range.fromInstant && e.createdAt < range.toInstant) : enrollments;
  const cohortIds = new Set(cohort.map((e) => e.id));
  const touched = new Set(tasks.filter((t) => t.state === 'DONE' && cohortIds.has(t.enrollmentId)).map((t) => t.enrollmentId));
  // Nested stages: a meeting counts as a reply, and a reply as contact, so no stage can exceed the one before.
  const met = (e: EnrollmentLite) => !!e.meetingAt || e.status === 'MEETING';
  const answered = (e: EnrollmentLite) => (replies.get(e.id)?.length ?? 0) > 0 || met(e);
  const funnel = {
    enrolled: cohort.length,
    touched: cohort.filter((e) => touched.has(e.id) || answered(e)).length,
    replied: cohort.filter(answered).length,
    meeting: cohort.filter(met).length,
  };

  return {
    today,
    range: { from, to },
    daily,
    funnel,
    activity,
    totals: {
      enrollments: range ? enrollments.filter((e) => e.createdAt >= range.fromInstant && e.createdAt < range.toInstant).length : enrollments.length,
      active: enrollments.filter((e) => e.status === 'ACTIVE' || e.status === 'PAUSED').length,
      replied: repliedRows.length,
      meeting: range ? meetingRows.length : enrollments.filter((e) => e.status === 'MEETING').length,
      tasksDone: tasks.filter((t) => t.state === 'DONE').length,
    },
    byPod,
    byFo,
    byCampaign,
    channels,
  };
}
