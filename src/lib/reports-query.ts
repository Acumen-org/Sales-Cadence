import type { Prisma } from '@prisma/client';
import { WORKSPACE_TIMEZONE } from './workspace';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isJuniorFo, visiblePodIds } from './auth/rbac';
import { addDays, isLocalDate, startOfLocalDay, type LocalDate } from './dates';
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

export const REPORTING_TIMEZONE = WORKSPACE_TIMEZONE;
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
  return { from: first, to: last, fromInstant: startOfLocalDay(first, REPORTING_TIMEZONE), toInstant: startOfLocalDay(addDays(last, 1), REPORTING_TIMEZONE), error };
}

export type ReportFilters = { range: ReportingRange; podId?: string | null; foUserId?: string | null };

type EnrollmentLite = { id: string; status: string; podId: string | null; foUserId: string; campaignId: string | null; sequenceId: string; createdAt: Date; repliedAt: Date | null; meetingAt: Date | null; completedAt: Date | null; exitedAt: Date | null };
type TaskLite = { enrollmentId: string; state: string; dueDate: string; snoozedTo: string | null; action: string; chosenAction: string | null; completionSource: string | null; foUserId: string };

function enrollmentScope(user: SessionUser): Prisma.EnrollmentWhereInput {
  if (isJuniorFo(user)) return { foUserId: user.id };
  const pods = visiblePodIds(user);
  if (pods === null) return {};
  return { OR: [{ podId: { in: pods } }, { foUserId: user.id }] };
}

function rollup(label: (e: EnrollmentLite) => { key: string; label: string } | null, enrollments: EnrollmentLite[], tasks: TaskLite[], today: LocalDate, range?: ReportingRange): GroupRow[] {
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
    if (range ? within(e.repliedAt) : e.status === 'REPLIED') row.replied += 1;
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
    const replied = (e: EnrollmentLite) => range ? !!e.repliedAt && e.repliedAt < range.toInstant : !!e.repliedAt || e.status === 'REPLIED' || e.status === 'MEETING';
    const meeting = (e: EnrollmentLite) => range ? !!e.meetingAt && e.meetingAt < range.toInstant : !!e.meetingAt || e.status === 'MEETING';
    row.replyRate = engaged.length ? engaged.filter((e) => replied(e) || meeting(e)).length / engaged.length : 0;
    row.meetingRate = engaged.length ? engaged.filter(meeting).length / engaged.length : 0;
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export type Reports = Awaited<ReturnType<typeof buildReports>>;

export async function buildReports(user: SessionUser, today: LocalDate, filters?: ReportFilters) {
  const range = filters?.range;
  const scope: Prisma.EnrollmentWhereInput = { AND: [enrollmentScope(user), ...(filters?.podId ? [{ podId: filters.podId }] : []), ...(filters?.foUserId ? [{ foUserId: filters.foUserId }] : [])] };
  const [enrollments, pods, users, campaigns, sequences] = await Promise.all([
    prisma.enrollment.findMany({ where: { AND: [scope, ...(range ? [{ createdAt: { lt: range.toInstant } }] : [])] }, select: { id: true, status: true, podId: true, foUserId: true, campaignId: true, sequenceId: true, createdAt: true, repliedAt: true, meetingAt: true, completedAt: true, exitedAt: true } }),
    prisma.pod.findMany({ select: { id: true, name: true } }),
    prisma.user.findMany({ select: { id: true, name: true } }),
    prisma.campaign.findMany({ select: { id: true, name: true } }),
    prisma.sequence.findMany({ select: { id: true, name: true } }),
  ]);
  const enrollmentIds = enrollments.map((e) => e.id);
  const tasks = await prisma.task.findMany({
    where: { enrollmentId: { in: enrollmentIds }, ...(range ? { OR: [{ state: { in: ['DONE', 'SKIPPED'] }, completedAt: { gte: range.fromInstant, lt: range.toInstant } }, { state: { in: ['PENDING', 'CANCELLED'] }, dueDate: { gte: range.from, lte: range.to } }] } : {}) },
    select: { enrollmentId: true, state: true, dueDate: true, snoozedTo: true, action: true, chosenAction: true, completionSource: true, foUserId: true },
  });
  const name = (list: { id: string; name: string }[], id: string | null, fallback: string) => list.find((x) => x.id === id)?.name ?? fallback;

  const byPod = rollup((e) => ({ key: e.podId ?? 'none', label: name(pods, e.podId, 'No pod') }), enrollments, tasks, today, range);
  const byFo = rollup((e) => ({ key: e.foUserId, label: name(users, e.foUserId, 'Unknown') }), enrollments, tasks, today, range);
  const byCampaign = rollup((e) => (e.campaignId ? { key: e.campaignId, label: name(campaigns, e.campaignId, 'Deleted campaign') } : { key: 'none', label: 'Direct enrollments' }), enrollments, tasks, today, range);
  const bySequence = rollup((e) => ({ key: e.sequenceId, label: name(sequences, e.sequenceId, 'Unknown') }), enrollments, tasks, today, range);

  const channels = (Object.keys(ACTION_LABELS) as ActionType[]).map((action) => {
    const ts = tasks.filter((t) => (t.chosenAction ?? t.action) === action);
    return {
      action,
      label: ACTION_LABELS[action],
      pending: ts.filter((t) => t.state === 'PENDING').length,
      overdue: ts.filter((t) => t.state === 'PENDING' && (t.snoozedTo ?? t.dueDate) < today).length,
      done: ts.filter((t) => t.state === 'DONE').length,
      observed: ts.filter((t) => t.state === 'DONE' && t.completionSource && t.completionSource.startsWith('OBSERVED')).length,
      manual: ts.filter((t) => t.state === 'DONE' && t.completionSource === 'MANUAL').length,
      skipped: ts.filter((t) => t.state === 'SKIPPED').length,
      cancelled: ts.filter((t) => t.state === 'CANCELLED').length,
    };
  });


  const d7 = range?.fromInstant ?? startOfLocalDay(addDays(today, -6), REPORTING_TIMEZONE);
  const d28 = range?.fromInstant ?? startOfLocalDay(addDays(today, -27), REPORTING_TIMEZONE);
  const end = range?.toInstant ?? startOfLocalDay(addDays(today, 1), REPORTING_TIMEZONE);
  const doneTasks = await prisma.task.findMany({
    where: { enrollmentId: { in: enrollmentIds }, state: 'DONE', completedAt: { gte: d28, lt: end } },
    select: { foUserId: true, action: true, chosenAction: true, disposition: true, completedAt: true, completionSource: true },
  });
  const repliedRows = await prisma.enrollment.findMany({ where: { ...scope, repliedAt: { gte: d28, lt: end } }, select: { foUserId: true, repliedAt: true } });
  const meetingRows = await prisma.enrollment.findMany({ where: { ...scope, meetingAt: { gte: d28, lt: end } }, select: { foUserId: true, meetingAt: true } });
  const answeredKeys = new Set((await import('./settings').then((m) => m.getSettings())).rules.callDispositions.filter((d) => d.answered).map((d) => d.key));
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
      return { id: u.id, name: u.name, period: window(d28), last7: window(d7), last28: window(d28) };
    })
    .filter((row) => !range || row.period.total || row.period.replies || row.period.meetings || enrollments.some((e) => e.foUserId === row.id && e.createdAt >= range.fromInstant && e.createdAt < range.toInstant))
    .sort((a, b) => b.period.total - a.period.total || a.name.localeCompare(b.name));

  return {
    today,
    activity,
    totals: {
      enrollments: range ? enrollments.filter((e) => e.createdAt >= range.fromInstant && e.createdAt < range.toInstant).length : enrollments.length,
      active: enrollments.filter((e) => e.status === 'ACTIVE' || e.status === 'PAUSED').length,
      replied: range ? repliedRows.length : enrollments.filter((e) => e.status === 'REPLIED').length,
      meeting: range ? meetingRows.length : enrollments.filter((e) => e.status === 'MEETING').length,
      tasksDone: tasks.filter((t) => t.state === 'DONE').length,
    },
    byPod,
    byFo,
    byCampaign,
    bySequence,
    channels,
  };
}
