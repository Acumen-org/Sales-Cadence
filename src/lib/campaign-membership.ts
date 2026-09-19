import type { CampaignStatus, EnrollmentStatus } from '@prisma/client';
import { prisma } from './db';
import { addDays, todayIn, type LocalDate } from './dates';
import { workspaceTimezone } from './workspace';
import { safeParseSteps } from './sequences/steps';
import type { SessionUser } from './auth/current-user';
import { canChangeCampaignMembers, visiblePodIds } from './auth/rbac';

/**
 * Who is in which campaign - before it starts as well as after.
 *
 * A campaign that has not launched holds its people only as a list of ids; once it launches they
 * become enrollments. Every page that shows a person's campaign reads both through this one
 * module, so an upcoming campaign is visible on the people, accounts and tasks it will touch, from
 * the moment it is created (owner's rule, 18 September 2026).
 */
export type MembershipKind = 'upcoming' | 'running' | 'finished';
export type Membership = {
  campaignId: string;
  campaignName: string;
  campaignStatus: CampaignStatus;
  kind: MembershipKind;
  startDate: LocalDate;
  endDate: LocalDate | null;
  podId: string;
  /** The person's own state inside the campaign; null before it launches. */
  enrollmentId: string | null;
  enrollmentStatus: EnrollmentStatus | null;
  sequenceId: string;
  sequenceName: string;
  /** Zero-based current step and the plan's step count; step is null before anything is generated. */
  step: number | null;
  steps: number;
};

const UPCOMING: CampaignStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED'];
/** Upcoming and past the draft: it has a date and will start unless somebody stops it. */
const UPCOMING_LIVE: CampaignStatus[] = ['PENDING_APPROVAL', 'SCHEDULED'];

export function membershipLabel(m: Membership): { label: string; tone: 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'purple' } {
  if (m.kind === 'upcoming') return { label: m.campaignStatus === 'PENDING_APPROVAL' ? 'Awaiting approval' : 'Upcoming', tone: 'purple' };
  switch (m.enrollmentStatus) {
    case 'ACTIVE': return { label: 'Active', tone: 'green' };
    case 'PAUSED': return { label: 'Paused', tone: 'amber' };
    case 'REPLIED': return { label: 'Finished (Replied)', tone: 'blue' };
    case 'MEETING': return { label: 'Meeting booked', tone: 'blue' };
    case 'COMPLETED': return { label: 'Finished (No reply)', tone: 'gray' };
    case 'EXITED': return { label: 'Removed', tone: 'gray' };
    default: return { label: m.campaignStatus === 'STOPPED' ? 'Stopped' : 'Finished', tone: 'gray' };
  }
}

/** Every campaign each of these people belongs to, current ones first. */
export async function membershipFor(personIds: string[]): Promise<Map<string, Membership[]>> {
  const out = new Map<string, Membership[]>();
  if (!personIds.length) return out;
  const [scheduled, enrollments] = await Promise.all([
    prisma.campaign.findMany({ where: { status: { in: UPCOMING }, personIds: { hasSome: personIds } }, select: { id: true, name: true, status: true, startDate: true, endDate: true, podId: true, personIds: true, sequenceId: true, sequence: { select: { name: true, steps: true } } } }),
    prisma.enrollment.findMany({ where: { personId: { in: personIds }, campaignId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, personId: true, status: true, currentStep: true, campaign: { select: { id: true, name: true, status: true, startDate: true, endDate: true, podId: true, sequenceId: true, sequence: { select: { name: true, steps: true } } } } } }),
  ]);
  const want = new Set(personIds);
  const stepCount = (steps: unknown) => { const parsed = safeParseSteps(steps); return parsed.ok ? parsed.steps.length : 0; };
  const push = (personId: string, m: Membership) => { const list = out.get(personId) ?? []; list.push(m); out.set(personId, list); };
  for (const c of scheduled) for (const id of c.personIds) if (want.has(id)) push(id, { campaignId: c.id, campaignName: c.name, campaignStatus: c.status, kind: 'upcoming', startDate: c.startDate, endDate: c.endDate, podId: c.podId, enrollmentId: null, enrollmentStatus: null, sequenceId: c.sequenceId, sequenceName: c.sequence.name, step: null, steps: stepCount(c.sequence.steps) });
  for (const e of enrollments) {
    const c = e.campaign!;
    const running = e.status === 'ACTIVE' || e.status === 'PAUSED';
    push(e.personId, { campaignId: c.id, campaignName: c.name, campaignStatus: c.status, kind: running ? 'running' : 'finished', startDate: c.startDate, endDate: c.endDate, podId: c.podId, enrollmentId: e.id, enrollmentStatus: e.status, sequenceId: c.sequenceId, sequenceName: c.sequence.name, step: e.currentStep >= 0 ? e.currentStep : null, steps: stepCount(c.sequence.steps) });
  }
  const order: Record<MembershipKind, number> = { running: 0, upcoming: 1, finished: 2 };
  for (const list of out.values()) list.sort((a, b) => order[a.kind] - order[b.kind]);
  return out;
}

/** Everyone in a campaign right now: scheduled in one that has not started, or in a live enrollment of one that has. */
export async function liveCampaignMemberIds(): Promise<Set<string>> {
  const [scheduled, enrolled] = await Promise.all([
    prisma.campaign.findMany({ where: { status: { in: UPCOMING } }, select: { personIds: true } }),
    prisma.enrollment.findMany({ where: { campaignId: { not: null }, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { personId: true }, distinct: ['personId'] }),
  ]);
  return new Set([...scheduled.flatMap((c) => c.personIds), ...enrolled.map((e) => e.personId)]);
}

/** The one membership a directory row shows: running first, then upcoming, then the latest finished. */
export function primaryMembership(list: Membership[] | undefined): Membership | null {
  return list?.[0] ?? null;
}

/** People filter: in this campaign, before or after launch. */
export async function campaignMemberWhere(campaignId: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { personIds: true, status: true } });
  if (!campaign) return { id: '__none__' };
  if (UPCOMING.includes(campaign.status)) return { id: { in: campaign.personIds } };
  return { enrollments: { some: { campaignId } } };
}

export type CampaignChoice = { id: string; name: string; status: CampaignStatus; kind: 'upcoming' | 'running'; startDate: LocalDate; endDate: LocalDate | null; podId: string; podName: string; members: number };

/** Campaigns a person can be added to: upcoming and running ones the reader may manage, or read. */
export async function campaignChoices(user: SessionUser, opts: { manageOnly?: boolean } = {}): Promise<CampaignChoice[]> {
  const pods = visiblePodIds(user);
  const campaigns = await prisma.campaign.findMany({
    where: { status: { in: [...UPCOMING, 'ACTIVE', 'PAUSED'] }, ...(pods === null ? {} : { podId: { in: pods } }) },
    orderBy: [{ status: 'asc' }, { startDate: 'asc' }],
    select: { id: true, name: true, status: true, startDate: true, endDate: true, podId: true, personIds: true, pod: { select: { name: true } }, _count: { select: { enrollments: { where: { status: { in: ['ACTIVE', 'PAUSED'] } } } } } },
  });
  return campaigns
    .filter((c) => !opts.manageOnly || canChangeCampaignMembers(user, c.podId))
    .map((c) => ({ id: c.id, name: c.name, status: c.status, kind: UPCOMING.includes(c.status) ? 'upcoming' as const : 'running' as const, startDate: c.startDate, endDate: c.endDate, podId: c.podId, podName: c.pod.name, members: UPCOMING.includes(c.status) ? c.personIds.length : c._count.enrollments }));
}

export type StartingSoon = { id: string; name: string; startDate: LocalDate; endDate: LocalDate | null; podName: string; people: number; mine: number; daysUntil: number };

/**
 * Campaigns that start inside the coming week, with how many of their people are this reader's.
 * Tasks, Home and the record pages show them so a campaign exists on screen before its first task.
 */
export async function startingSoon(user: SessionUser, opts: { days?: number; personIds?: string[]; now?: Date; podId?: string | null } = {}): Promise<StartingSoon[]> {
  const today = todayIn(workspaceTimezone(), opts.now ?? new Date());
  const until = addDays(today, opts.days ?? 7);
  const pods = visiblePodIds(user);
  const campaigns = await prisma.campaign.findMany({
    where: { status: { in: UPCOMING_LIVE }, startDate: { gte: today, lte: until }, ...(opts.podId ? { podId: opts.podId } : pods === null ? {} : { podId: { in: pods } }), ...(opts.personIds ? { personIds: { hasSome: opts.personIds } } : {}) },
    orderBy: { startDate: 'asc' },
    select: { id: true, name: true, startDate: true, endDate: true, personIds: true, pod: { select: { name: true } } },
  });
  if (!campaigns.length) return [];
  const mine = user.twentyMemberId ? new Set((await prisma.personCache.findMany({ where: { id: { in: [...new Set(campaigns.flatMap((c) => c.personIds))] }, ownerMemberId: user.twentyMemberId }, select: { id: true } })).map((p) => p.id)) : new Set<string>();
  const dayOf = (d: LocalDate) => Math.round((new Date(`${d}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000);
  return campaigns.map((c) => ({ id: c.id, name: c.name, startDate: c.startDate, endDate: c.endDate, podName: c.pod.name, people: opts.personIds ? c.personIds.filter((id) => opts.personIds!.includes(id)).length : c.personIds.length, mine: c.personIds.filter((id) => mine.has(id)).length, daysUntil: dayOf(c.startDate) }));
}
