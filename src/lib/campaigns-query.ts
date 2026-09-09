import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { visiblePodIds } from './auth/rbac';
import { parseSteps } from './sequences/steps';

export type CampaignSummary = {
  id: string;
  name: string;
  status: string;
  sequenceName: string;
  sequenceId: string;
  podName: string;
  podId: string;
  startDate: string;
  dailyRampPerFo: number | null;
  assignmentMode: string;
  sourceType: string;
  createdAt: Date;
  counts: { total: number; active: number; paused: number; replied: number; meeting: number; completed: number; exited: number };
  replyRate: number;
  meetingRate: number;
};

function summarise(rows: Array<{ status: string; _count: { _all: number } }>) {
  const c = { total: 0, active: 0, paused: 0, replied: 0, meeting: 0, completed: 0, exited: 0 };
  for (const r of rows) {
    const k = r.status.toLowerCase() as keyof typeof c;
    if (k in c) c[k] += r._count._all;
    c.total += r._count._all;
  }
  const engaged = c.total - c.exited;
  return { counts: c, replyRate: engaged ? (c.replied + c.meeting) / engaged : 0, meetingRate: engaged ? c.meeting / engaged : 0 };
}

export function campaignScope(user: SessionUser): Prisma.CampaignWhereInput {
  const pods = visiblePodIds(user);
  return pods === null ? {} : { podId: { in: pods } };
}

export async function listCampaigns(user: SessionUser): Promise<CampaignSummary[]> {
  const campaigns = await prisma.campaign.findMany({ where: campaignScope(user), include: { sequence: { select: { name: true } }, pod: { select: { name: true } } }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }] });
  const groups = await prisma.enrollment.groupBy({ by: ['campaignId', 'campaignRun', 'status'], where: { campaignId: { in: campaigns.map((c) => c.id) } }, _count: { _all: true } });
  return campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    sequenceName: c.sequence.name,
    sequenceId: c.sequenceId,
    podName: c.pod.name,
    podId: c.podId,
    startDate: c.startDate,
    dailyRampPerFo: c.dailyRampPerFo,
    assignmentMode: c.assignmentMode,
    sourceType: c.sourceType,
    createdAt: c.createdAt,
    ...summarise(groups.filter((g) => g.campaignId === c.id && g.campaignRun === c.runNumber)),
  }));
}

export type CampaignDetail = Awaited<ReturnType<typeof campaignDetail>>;

export async function campaignDetail(id: string, today: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { sequence: true, pod: { include: { users: { include: { user: { select: { id: true, name: true, active: true } } } } } } },
  });
  if (!campaign) return null;
  const history = await prisma.enrollment.findMany({
    where: { campaignId: id },
    include: {
      person: true,
      fo: { select: { id: true, name: true } },
      tasks: { select: { id: true, state: true, stepIndex: true, stepId: true, label: true, dueDate: true, snoozedTo: true, action: true, completedAt: true } },
    },
    orderBy: [{ status: 'asc' }, { startDate: 'asc' }],
  });
  const steps = parseSteps(campaign.sequence.steps);
  const enrollments = history.filter(e => e.campaignRun === campaign.runNumber);
  const statusRows = await prisma.enrollment.groupBy({ by: ['status'], where: { campaignId: id, campaignRun: campaign.runNumber }, _count: { _all: true } });
  const summary = summarise(statusRows);

  // Funnel by step: who is at each step now, who got through it
  const byStep = steps.map((step, index) => {
    const at = enrollments.filter((e) => e.currentStep === index || e.tasks.some((t) => t.stepIndex === index && t.stepId === step.id && e.currentStep === index));
    const reached = enrollments.filter((e) => e.tasks.some((t) => t.stepId === step.id));
    const done = enrollments.filter((e) => e.tasks.some((t) => t.stepId === step.id && t.state === 'DONE'));
    return {
      index,
      day: step.day,
      label: step.actions.map((a) => a.label).join(' + '),
      reached: reached.length,
      active: at.filter((e) => e.status === 'ACTIVE' || e.status === 'PAUSED').length,
      done: done.length,
      replied: at.filter((e) => e.status === 'REPLIED').length,
      meeting: at.filter((e) => e.status === 'MEETING').length,
      overdue: enrollments.reduce((n, e) => n + e.tasks.filter((t) => t.stepId === step.id && t.state === 'PENDING' && (t.snoozedTo ?? t.dueDate) < today).length, 0),
    };
  });

  // By FO
  const fos = new Map<string, { id: string; name: string; total: number; active: number; replied: number; meeting: number; completed: number; exited: number; overdue: number; doneTasks: number }>();
  for (const e of enrollments) {
    const row = fos.get(e.foUserId) ?? { id: e.foUserId, name: e.fo.name, total: 0, active: 0, replied: 0, meeting: 0, completed: 0, exited: 0, overdue: 0, doneTasks: 0 };
    row.total += 1;
    if (e.status === 'ACTIVE' || e.status === 'PAUSED') row.active += 1;
    if (e.status === 'REPLIED') row.replied += 1;
    if (e.status === 'MEETING') row.meeting += 1;
    if (e.status === 'COMPLETED') row.completed += 1;
    if (e.status === 'EXITED') row.exited += 1;
    row.overdue += e.tasks.filter((t) => t.state === 'PENDING' && (t.snoozedTo ?? t.dueDate) < today).length;
    row.doneTasks += e.tasks.filter((t) => t.state === 'DONE').length;
    fos.set(e.foUserId, row);
  }

  return {
    campaign,
    steps,
    enrollments,
    history,
    summary,
    byStep,
    byFo: [...fos.values()].sort((a, b) => a.name.localeCompare(b.name)),
    podFos: campaign.pod.users.map((u) => u.user).filter((u) => u.active),
  };
}

/** Enrollments in a campaign that finished the sequence without a reply, at least `days` ago. */
export async function nonReplierCandidates(campaignId: string, days: number, now = new Date(), sourceRun?: number) {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return [];
  const finished = await prisma.enrollment.findMany({
    where: { campaignId, campaignRun: sourceRun ?? campaign.runNumber, status: 'COMPLETED', completedAt: { lte: cutoff }, repliedAt: null, meetingAt: null },
    include: { person: true, fo: { select: { id: true, name: true } } },
  });
  // Exclude anyone re-enrolled elsewhere, removed, or marked do-not-contact in either system.
  const ids = finished.map((f) => f.personId);
  const busy = await prisma.enrollment.findMany({ where: { personId: { in: ids }, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { personId: true } });
  const busySet = new Set(busy.map((b) => b.personId));
  const inbound = await prisma.touch.findMany({ where: { personId: { in: ids }, direction: 'INBOUND', occurredAt: { gte: campaign.createdAt } }, select: { personId: true } });
  for (const reply of inbound) busySet.add(reply.personId);
  return finished.filter((f) => !busySet.has(f.personId) && !f.person.dnd && !f.person.optedOut && !f.person.deletedAt);
}
