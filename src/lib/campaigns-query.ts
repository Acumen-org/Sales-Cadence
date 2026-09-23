import type { CampaignDraft } from './campaign-planner';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { visiblePodIds } from './auth/rbac';
import { foPeopleWhere } from './people-scope';
import { parseSteps } from './sequences/steps';

export type CampaignSummary = {
  calendarPlan: boolean;
  id: string;
  name: string;
  status: string;
  sequenceName: string;
  sequenceId: string;
  podName: string;
  podId: string;
  startDate: string;
  startsPerFoPerDay: number | null;
  endDate: string | null;
  productInterest: string[];
  description: string | null;
  hardStopAtEnd: boolean;
  assignmentMode: string;
  sourceType: string;
  createdAt: Date;
  /** People on the list before launch; after it, enrollments carry the count. */
  audience: number;
  touches: { done: number; open: number; planned: number };
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

export type CampaignListFilters = { q?: string; podId?: string | null; sequenceId?: string | null; product?: string | null; foUserId?: string | null; from?: string | null; to?: string | null };

/**
 * Touches done, still open, and "planned" per campaign. Tasks are generated step by step, so a
 * count of rows undersells the plan: somebody live still owes every touch of the sequence, and
 * somebody finished owes the ones that were generated (done or skipped) before they finished.
 */
async function touchesByCampaign(ids: string[]): Promise<Map<string, { done: number; open: number; endedPlanned: number }>> {
  const out = new Map<string, { done: number; open: number; endedPlanned: number }>();
  if (!ids.length) return out;
  const rows = await prisma.$queryRaw<Array<{ campaignId: string; state: string; live: boolean; n: bigint }>>`
    SELECT e."campaignId" AS "campaignId", t.state AS state, (e.status IN ('ACTIVE', 'PAUSED')) AS live, COUNT(*) AS n
    FROM "Task" t JOIN "Enrollment" e ON e.id = t."enrollmentId"
    WHERE e."campaignId" = ANY(${ids}) AND e."campaignRun" = (SELECT c."runNumber" FROM "Campaign" c WHERE c.id = e."campaignId")
    GROUP BY e."campaignId", t.state, (e.status IN ('ACTIVE', 'PAUSED'))`;
  for (const r of rows) {
    const row = out.get(r.campaignId) ?? { done: 0, open: 0, endedPlanned: 0 };
    if (r.state === 'DONE') row.done += Number(r.n);
    if (r.state === 'PENDING') row.open += Number(r.n);
    if (!r.live && (r.state === 'DONE' || r.state === 'SKIPPED')) row.endedPlanned += Number(r.n);
    out.set(r.campaignId, row);
  }
  return out;
}

/** Touches one person owes a sequence: every action of every step. */
export function touchesPerPerson(steps: unknown): number {
  try { return parseSteps(steps).reduce((n, s) => n + s.actions.length, 0); } catch { return 0; }
}

export async function listCampaigns(user: SessionUser, filters: CampaignListFilters = {}): Promise<CampaignSummary[]> {
  const where: Prisma.CampaignWhereInput = { AND: [campaignScope(user)] };
  const and = where.AND as Prisma.CampaignWhereInput[];
  if (filters.q?.trim()) and.push({ OR: filters.q.trim().split(/\s+/).slice(0, 6).map((term) => ({ name: { contains: term, mode: 'insensitive' as const } })) });
  if (filters.podId) and.push({ podId: filters.podId });
  if (filters.sequenceId) and.push({ sequenceId: filters.sequenceId });
  if (filters.product) and.push({ productInterest: { has: filters.product } });
  // Before launch a campaign has no enrollments: it is the FO's when they own anyone in it.
  const foPeople = filters.foUserId ? new Set((await prisma.personCache.findMany({ where: foPeopleWhere(filters.foUserId, (await prisma.user.findUnique({ where: { id: filters.foUserId }, select: { twentyMemberId: true } }))?.twentyMemberId), select: { id: true } })).map((p) => p.id)) : null;
  if (filters.foUserId) and.push({ OR: [{ enrollments: { some: { foUserId: filters.foUserId } } }, { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED'] } }] });
  // A date range means the campaign's window overlaps it.
  if (filters.from) and.push({ OR: [{ endDate: null }, { endDate: { gte: filters.from } }] });
  if (filters.to) and.push({ startDate: { lte: filters.to } });
  const campaigns = (await prisma.campaign.findMany({ where, include: { sequence: { select: { name: true, steps: true } }, pod: { select: { name: true } } }, orderBy: [{ status: 'asc' }, { startDate: 'desc' }, { createdAt: 'desc' }] }))
    .filter((c) => !foPeople || !['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED'].includes(c.status) || (c.plannerDraft ? (c.plannerDraft as CampaignDraft).fos.some(f => f.id === filters.foUserId) : c.personIds.some((id) => foPeople.has(id))));
  const [groups, touches] = await Promise.all([
    prisma.enrollment.groupBy({ by: ['campaignId', 'campaignRun', 'status'], where: { campaignId: { in: campaigns.map((c) => c.id) } }, _count: { _all: true } }),
    touchesByCampaign(campaigns.map((c) => c.id)),
  ]);
  return campaigns.map((c) => ({
    calendarPlan: Boolean(c.plannerDraft),
    id: c.id,
    name: c.name,
    status: c.status,
    sequenceName: c.plannerDraft ? `${(c.plannerDraft as CampaignDraft).flows.length} outreach group${(c.plannerDraft as CampaignDraft).flows.length === 1 ? '' : 's'}` : c.sequence.name,
    sequenceId: c.sequenceId,
    podName: c.pod.name,
    podId: c.podId,
    startDate: c.startDate,
    startsPerFoPerDay: c.startsPerFoPerDay,
    endDate: c.endDate,
    productInterest: c.productInterest,
    description: c.description,
    hardStopAtEnd: c.hardStopAtEnd,
    assignmentMode: c.assignmentMode,
    sourceType: c.sourceType,
    createdAt: c.createdAt,
    audience: c.personIds.length,
    touches: (() => {
      const t = touches.get(c.id) ?? { done: 0, open: 0, endedPlanned: 0 };
      const perPerson = touchesPerPerson(c.sequence.steps);
      const live = groups.filter((g) => g.campaignId === c.id && g.campaignRun === c.runNumber && (g.status === 'ACTIVE' || g.status === 'PAUSED')).reduce((n, g) => n + g._count._all, 0);
      let planned = ['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED'].includes(c.status) ? c.personIds.length * perPerson : live * perPerson + t.endedPlanned;
      if (c.plannerDraft) {
        const d = c.plannerDraft as CampaignDraft;
        planned = d.personIds.reduce((n, id) => n + touchesPerPerson(d.flows.find(f => f.id === (d.assignments[id] ?? 'default'))?.steps), 0);
      }
      return { done: t.done, open: t.open, planned };
    })(),
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
