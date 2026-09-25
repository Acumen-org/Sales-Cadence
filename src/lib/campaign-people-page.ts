import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { todayIn } from './dates';
import { workspaceTimezone } from './workspace';
import { personSearchWhere } from './search-terms';
import { cachedPersonName } from './person-cache';
import type { CampaignDraft } from './campaign-planner';
import type { PublishedCalendar } from './campaign-planning-service';

export const CAMPAIGN_PEOPLE_PAGE = 50;

export type CampaignPersonRow = { id: string; personId: string; name: string; company: string | null; fo: string | null; flowId: string; step: number | null; status: string | null; exitReason: string | null };
export type CampaignPeoplePage = {
  launched: boolean;
  rows: CampaignPersonRow[];
  total: number;
  page: number;
  pages: number;
  /** finished: people whose outreach has ended, the ones a follow-up can reach. */
  stats: { completedSteps: number; late: number; replies: number; meetings: number; finished: number };
};

/**
 * A studio campaign's people, fifty at a time, in any state: its enrollments once it has launched,
 * the planned audience before. The headline numbers are counted in the database, so a page never
 * loads every enrollment and task to show fifty rows.
 */
export async function campaignPeoplePage(campaign: { id: string; personIds: string[]; plannerDraft: Prisma.JsonValue; publishedPlan: Prisma.JsonValue }, pageParam: string | undefined, qParam: string | undefined): Promise<CampaignPeoplePage> {
  const q = (qParam ?? '').trim();
  const search = q ? personSearchWhere(q) : null;
  const requested = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1);
  const launched = (await prisma.enrollment.count({ where: { campaignId: campaign.id } })) > 0;
  const draft = campaign.plannerDraft as unknown as CampaignDraft | null;
  const flowOf = (personId: string) => draft?.assignments?.[personId] ?? 'default';

  if (launched) {
    const where: Prisma.EnrollmentWhereInput = { campaignId: campaign.id, ...(search ? { person: search } : {}) };
    const today = todayIn(workspaceTimezone());
    const [total, replies, meetings, late, states, finished] = await Promise.all([
      prisma.enrollment.count({ where }),
      prisma.enrollment.count({ where: { campaignId: campaign.id, repliedAt: { not: null } } }),
      prisma.enrollment.count({ where: { campaignId: campaign.id, meetingAt: { not: null } } }),
      // Overdue the way Tasks counts it: by the day a step is worked (its snoozed day, if snoozed),
      // and never a step held by a pause. Counting the first due date alone kept every snoozed
      // step here as overdue while Tasks showed none.
      prisma.task.findMany({ where: { enrollment: { campaignId: campaign.id, status: 'ACTIVE' }, state: 'PENDING', OR: [{ snoozedTo: null, dueDate: { lt: today } }, { snoozedTo: { not: null, lt: today } }] }, distinct: ['enrollmentId'], select: { enrollmentId: true } }),
      prisma.task.groupBy({ by: ['enrollmentId', 'stepId', 'state'], where: { enrollment: { campaignId: campaign.id } } }),
      prisma.enrollment.count({ where: { campaignId: campaign.id, status: { notIn: ['ACTIVE', 'PAUSED'] } } }),
    ]);
    // A step is complete when every one of its activities is done.
    const byStep = new Map<string, Set<string>>();
    for (const s of states) { const key = `${s.enrollmentId}:${s.stepId}`; (byStep.get(key) ?? byStep.set(key, new Set()).get(key)!).add(s.state); }
    const completedSteps = [...byStep.values()].filter((set) => set.size === 1 && set.has('DONE')).length;
    const pages = Math.max(1, Math.ceil(total / CAMPAIGN_PEOPLE_PAGE));
    const page = Math.min(requested, pages);
    const enrollments = await prisma.enrollment.findMany({ where, include: { person: true, fo: { select: { name: true } } }, orderBy: [{ startDate: 'asc' }, { id: 'asc' }], skip: (page - 1) * CAMPAIGN_PEOPLE_PAGE, take: CAMPAIGN_PEOPLE_PAGE });
    return {
      launched, total, page, pages, stats: { completedSteps, late: late.length, replies, meetings, finished },
      rows: enrollments.map((e) => ({ id: e.id, personId: e.personId, name: cachedPersonName(e.person), company: e.person.companyName, fo: e.fo.name, flowId: flowOf(e.personId), step: Math.max(0, e.currentStep + 1), status: e.status, exitReason: e.exitReason })),
    };
  }

  // Before launch: the planned audience, by name, with the FO the plan gives each person.
  const plan = campaign.publishedPlan as unknown as PublishedCalendar | null;
  const foOfPerson = new Map<string, string>();
  if (plan) for (const b of plan.batches) for (const id of b.personIds) foOfPerson.set(id, plan.fos.find((f) => f.id === b.foId)?.name ?? '');
  const all = await prisma.personCache.findMany({ where: { id: { in: campaign.personIds }, ...(search ?? {}) }, select: { id: true }, orderBy: [{ sortName: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }] });
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / CAMPAIGN_PEOPLE_PAGE));
  const page = Math.min(requested, pages);
  const ids = all.slice((page - 1) * CAMPAIGN_PEOPLE_PAGE, page * CAMPAIGN_PEOPLE_PAGE).map((p) => p.id);
  const people = new Map((await prisma.personCache.findMany({ where: { id: { in: ids } } })).map((p) => [p.id, p]));
  // Unpublished: the FO who owns the contact in Twenty, when they are on this campaign.
  const owners = plan ? new Map<string, string>() : new Map((await prisma.user.findMany({ where: { id: { in: draft?.fos.map((f) => f.id) ?? [] }, twentyMemberId: { not: null } }, select: { name: true, twentyMemberId: true } })).map((u) => [u.twentyMemberId!, u.name]));
  return {
    launched, total, page, pages, stats: { completedSteps: 0, late: 0, replies: 0, meetings: 0, finished: 0 },
    rows: ids.flatMap((id) => { const p = people.get(id); return p ? [{ id, personId: id, name: cachedPersonName(p), company: p.companyName, fo: foOfPerson.get(id) ?? (p.ownerMemberId ? owners.get(p.ownerMemberId) ?? null : null), flowId: flowOf(id), step: null, status: null, exitReason: null }] : []; }),
  };
}
