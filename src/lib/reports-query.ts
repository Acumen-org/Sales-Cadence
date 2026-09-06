import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isJuniorFo, visiblePodIds } from './auth/rbac';
import { cachedPersonName } from './person-cache';
import { addDays, diffDays, parseLocalDate, type LocalDate } from './dates';
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

type EnrollmentLite = { id: string; status: string; podId: string | null; foUserId: string; campaignId: string | null; sequenceId: string };
type TaskLite = { enrollmentId: string; state: string; dueDate: string; snoozedTo: string | null; action: string; completionSource: string | null; foUserId: string };

function enrollmentScope(user: SessionUser): Prisma.EnrollmentWhereInput {
  if (isJuniorFo(user)) return { foUserId: user.id };
  const pods = visiblePodIds(user);
  if (pods === null) return {};
  return { OR: [{ podId: { in: pods } }, { foUserId: user.id }] };
}

function rollup(label: (e: EnrollmentLite) => { key: string; label: string } | null, enrollments: EnrollmentLite[], tasks: TaskLite[], today: LocalDate): GroupRow[] {
  const rows = new Map<string, GroupRow>();
  const byEnrollment = new Map<string, string>();
  for (const e of enrollments) {
    const k = label(e);
    if (!k) continue;
    byEnrollment.set(e.id, k.key);
    const row = rows.get(k.key) ?? { key: k.key, label: k.label, enrolled: 0, active: 0, replied: 0, meeting: 0, completed: 0, exited: 0, replyRate: 0, meetingRate: 0, tasksDone: 0, tasksSkipped: 0, overdue: 0 };
    row.enrolled += 1;
    if (e.status === 'ACTIVE' || e.status === 'PAUSED') row.active += 1;
    else if (e.status === 'REPLIED') row.replied += 1;
    else if (e.status === 'MEETING') row.meeting += 1;
    else if (e.status === 'COMPLETED') row.completed += 1;
    else if (e.status === 'EXITED') row.exited += 1;
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
    const engaged = row.enrolled - row.exited;
    row.replyRate = engaged ? (row.replied + row.meeting) / engaged : 0;
    row.meetingRate = engaged ? row.meeting / engaged : 0;
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export type Reports = Awaited<ReturnType<typeof buildReports>>;

export async function buildReports(user: SessionUser, today: LocalDate, stalledDays: number) {
  const scope = enrollmentScope(user);
  const [enrollments, pods, users, campaigns, sequences] = await Promise.all([
    prisma.enrollment.findMany({ where: scope, select: { id: true, status: true, podId: true, foUserId: true, campaignId: true, sequenceId: true } }),
    prisma.pod.findMany({ select: { id: true, name: true } }),
    prisma.user.findMany({ select: { id: true, name: true } }),
    prisma.campaign.findMany({ select: { id: true, name: true } }),
    prisma.sequence.findMany({ select: { id: true, name: true } }),
  ]);
  const enrollmentIds = enrollments.map((e) => e.id);
  const tasks = await prisma.task.findMany({
    where: { enrollmentId: { in: enrollmentIds } },
    select: { enrollmentId: true, state: true, dueDate: true, snoozedTo: true, action: true, completionSource: true, foUserId: true },
  });
  const name = (list: { id: string; name: string }[], id: string | null, fallback: string) => list.find((x) => x.id === id)?.name ?? fallback;

  const byPod = rollup((e) => ({ key: e.podId ?? 'none', label: name(pods, e.podId, 'No pod') }), enrollments, tasks, today);
  const byFo = rollup((e) => ({ key: e.foUserId, label: name(users, e.foUserId, 'Unknown') }), enrollments, tasks, today);
  const byCampaign = rollup((e) => (e.campaignId ? { key: e.campaignId, label: name(campaigns, e.campaignId, 'Deleted campaign') } : { key: 'none', label: 'Ad-hoc enrollments' }), enrollments, tasks, today);
  const bySequence = rollup((e) => ({ key: e.sequenceId, label: name(sequences, e.sequenceId, 'Unknown') }), enrollments, tasks, today);

  const channels = (Object.keys(ACTION_LABELS) as ActionType[]).map((action) => {
    const ts = tasks.filter((t) => t.action === action);
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

  const overdue = await prisma.task.findMany({
    where: { enrollmentId: { in: enrollmentIds }, state: 'PENDING', OR: [{ snoozedTo: null, dueDate: { lt: today } }, { snoozedTo: { lt: today } }] },
    include: { enrollment: { include: { person: true, pod: { select: { name: true } } } }, fo: { select: { name: true } } },
    orderBy: { dueAt: 'asc' },
    take: 200,
  });

  // Stalled: active enrollments with no touch for N days (or none at all and enrolled > N days ago)
  const active = await prisma.enrollment.findMany({
    where: { ...scope, status: 'ACTIVE' },
    include: { person: true, fo: { select: { name: true } }, pod: { select: { name: true } } },
  });
  const lastTouches = await prisma.touch.groupBy({ by: ['personId'], where: { personId: { in: active.map((e) => e.personId) } }, _max: { occurredAt: true } });
  const lastByPerson = new Map(lastTouches.map((t) => [t.personId, t._max.occurredAt]));
  // Measured from the report date so "stalled" means "no touch for N days as of today".
  const cutoff = parseLocalDate(addDays(today, -stalledDays));
  const stalled = active
    .map((e) => ({ enrollment: e, lastTouch: lastByPerson.get(e.personId) ?? null }))
    .filter(({ enrollment, lastTouch }) => (lastTouch ? lastTouch < cutoff : enrollment.createdAt < cutoff))
    .sort((a, b) => (a.lastTouch?.getTime() ?? 0) - (b.lastTouch?.getTime() ?? 0))
    .slice(0, 200);

  return {
    today,
    totals: {
      enrollments: enrollments.length,
      active: enrollments.filter((e) => e.status === 'ACTIVE' || e.status === 'PAUSED').length,
      replied: enrollments.filter((e) => e.status === 'REPLIED').length,
      meeting: enrollments.filter((e) => e.status === 'MEETING').length,
      tasksDone: tasks.filter((t) => t.state === 'DONE').length,
      overdue: overdue.length,
      stalled: stalled.length,
    },
    byPod,
    byFo,
    byCampaign,
    bySequence,
    channels,
    overdue: overdue.map((t) => ({
      id: t.id,
      person: cachedPersonName(t.enrollment.person),
      company: t.enrollment.person.companyName,
      label: t.label,
      fo: t.fo.name,
      pod: t.enrollment.pod?.name ?? '-',
      due: t.snoozedTo ?? t.dueDate,
      daysOverdue: diffDays(t.snoozedTo ?? t.dueDate, today),
    })),
    stalled: stalled.map(({ enrollment, lastTouch }) => ({
      id: enrollment.id,
      person: cachedPersonName(enrollment.person),
      company: enrollment.person.companyName,
      fo: enrollment.fo.name,
      pod: enrollment.pod?.name ?? '-',
      lastTouch,
      startDate: enrollment.startDate,
      currentStep: enrollment.currentStep,
    })),
  };
}
