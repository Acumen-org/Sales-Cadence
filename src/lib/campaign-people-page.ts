import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { todayIn } from './dates';
import { workspaceTimezone } from './workspace';
import { personSearchWhere } from './search-terms';
import { cachedPersonName } from './person-cache';
import type { CampaignDraft } from './campaign-planner';
import type { PublishedCalendar } from './campaign-planning-service';
import { coldRef, personRef, subjectHref } from './subject';

export const CAMPAIGN_PEOPLE_PAGE = 50;

/** `href` is the person's page through the subject layer: People, or the cold contact's page (8.13). */
export type CampaignPersonRow = { id: string; personId: string; href: string; name: string; company: string | null; fo: string | null; flowId: string; step: number | null; status: string | null; exitReason: string | null; foUserId?: string; startDate?: string; nextStep?: string | null };
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
export async function campaignPeoplePage(campaign: { id: string; personIds: string[]; plannerDraft: Prisma.JsonValue; publishedPlan: Prisma.JsonValue; audience?: 'CRM' | 'SANDBOX' }, pageParam: string | undefined, qParam: string | undefined): Promise<CampaignPeoplePage> {
  if (campaign.audience === 'SANDBOX') return coldCampaignPeoplePage(campaign, pageParam, qParam);
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
      rows: enrollments.map((e) => ({ id: e.id, personId: e.personId!, href: subjectHref(personRef(e.personId!)), name: cachedPersonName(e.person!), company: e.person!.companyName, fo: e.fo.name, flowId: flowOf(e.personId!), step: Math.max(0, e.currentStep + 1), status: e.status, exitReason: e.exitReason })),
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
    rows: ids.flatMap((id) => { const p = people.get(id); return p ? [{ id, personId: id, href: subjectHref(personRef(id)), name: cachedPersonName(p), company: p.companyName, fo: foOfPerson.get(id) ?? (p.ownerMemberId ? owners.get(p.ownerMemberId) ?? null : null), flowId: flowOf(id), step: null, status: null, exitReason: null }] : []; }),
  };
}

/** A cold contact's search: name, email, firm or title, every word. */
function coldSearch(q: string): Prisma.SandboxContactWhereInput | null {
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 5);
  if (!terms.length) return null;
  return { AND: terms.map((term) => { const like = { contains: term, mode: 'insensitive' as const }; return { OR: [{ firstName: like }, { lastName: like }, { email: like }, { companyName: like }, { jobTitle: like }] }; }) };
}
const coldName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim() || 'Removed contact';

/**
 * A cold campaign's contacts, the same page as a CRM campaign's (B134): its enrollments once it has
 * launched, with the earliest open step of each (B198), or its planned contacts before. Every link is
 * the cold contact's own page, never /people (8.13).
 */
async function coldCampaignPeoplePage(campaign: { id: string; personIds: string[]; plannerDraft: Prisma.JsonValue; publishedPlan: Prisma.JsonValue }, pageParam: string | undefined, qParam: string | undefined): Promise<CampaignPeoplePage> {
  const search = coldSearch((qParam ?? '').trim());
  const requested = Math.max(1, Number.parseInt(pageParam ?? '1', 10) || 1);
  const launched = (await prisma.enrollment.count({ where: { campaignId: campaign.id } })) > 0;
  const draft = campaign.plannerDraft as unknown as CampaignDraft | null;
  const flowOf = (id: string) => draft?.assignments?.[id] ?? 'default';
  if (launched) {
    const where: Prisma.EnrollmentWhereInput = { campaignId: campaign.id, ...(search ? { sandboxContact: search } : {}) };
    const today = todayIn(workspaceTimezone());
    const [total, replies, meetings, late, done, finished] = await Promise.all([
      prisma.enrollment.count({ where }),
      prisma.enrollment.count({ where: { campaignId: campaign.id, repliedAt: { not: null } } }),
      prisma.enrollment.count({ where: { campaignId: campaign.id, meetingAt: { not: null } } }),
      prisma.task.findMany({ where: { enrollment: { campaignId: campaign.id, status: 'ACTIVE' }, state: 'PENDING', OR: [{ snoozedTo: null, dueDate: { lt: today } }, { snoozedTo: { not: null, lt: today } }] }, distinct: ['enrollmentId'], select: { enrollmentId: true } }),
      prisma.task.groupBy({ by: ['enrollmentId', 'stepId', 'state'], where: { enrollment: { campaignId: campaign.id } } }),
      prisma.enrollment.count({ where: { campaignId: campaign.id, status: { notIn: ['ACTIVE', 'PAUSED'] } } }),
    ]);
    const byStep = new Map<string, Set<string>>();
    for (const s of done) { const key = `${s.enrollmentId}:${s.stepId}`; (byStep.get(key) ?? byStep.set(key, new Set()).get(key)!).add(s.state); }
    const pages = Math.max(1, Math.ceil(total / CAMPAIGN_PEOPLE_PAGE));
    const page = Math.min(requested, pages);
    const enrollments = await prisma.enrollment.findMany({
      where, orderBy: [{ startDate: 'asc' }, { id: 'asc' }], skip: (page - 1) * CAMPAIGN_PEOPLE_PAGE, take: CAMPAIGN_PEOPLE_PAGE,
      include: { sandboxContact: { select: { id: true, firstName: true, lastName: true, companyName: true } }, fo: { select: { name: true } }, tasks: { where: { state: 'PENDING' }, orderBy: [{ dueDate: 'asc' }, { stepIndex: 'asc' }, { actionIndex: 'asc' }], take: 1, select: { label: true, dueDate: true, snoozedTo: true } } },
    });
    return {
      launched, total, page, pages, stats: { completedSteps: [...byStep.values()].filter((set) => set.size === 1 && set.has('DONE')).length, late: late.length, replies, meetings, finished },
      rows: enrollments.map((e) => {
        const next = e.tasks[0];
        const id = e.sandboxContactId ?? e.id;
        // A contact moved since keeps its row here; its link follows it to its CRM person.
        const href = e.personId ? subjectHref(personRef(e.personId)) : subjectHref(coldRef(id));
        return { id: e.id, personId: id, href, name: e.sandboxContact ? coldName(e.sandboxContact) : 'Removed contact', company: e.sandboxContact?.companyName ?? null, fo: e.fo.name, foUserId: e.foUserId, flowId: flowOf(id), step: Math.max(0, e.currentStep + 1), status: e.status, exitReason: e.exitReason, startDate: e.startDate, nextStep: next ? `${next.label} · ${next.snoozedTo ?? next.dueDate}` : null };
      }),
    };
  }
  const plan = campaign.publishedPlan as unknown as PublishedCalendar | null;
  const foOfPerson = new Map<string, string>();
  if (plan) for (const b of plan.batches) for (const id of b.personIds) foOfPerson.set(id, plan.fos.find((f) => f.id === b.foId)?.name ?? '');
  const all = await prisma.sandboxContact.findMany({ where: { id: { in: campaign.personIds }, ...(search ?? {}) }, select: { id: true }, orderBy: [{ sortName: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }] });
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / CAMPAIGN_PEOPLE_PAGE));
  const page = Math.min(requested, pages);
  const ids = all.slice((page - 1) * CAMPAIGN_PEOPLE_PAGE, page * CAMPAIGN_PEOPLE_PAGE).map((p) => p.id);
  const contacts = new Map((await prisma.sandboxContact.findMany({ where: { id: { in: ids } }, include: { owner: { select: { name: true, active: true } } } })).map((c) => [c.id, c]));
  return {
    launched, total, page, pages, stats: { completedSteps: 0, late: 0, replies: 0, meetings: 0, finished: 0 },
    rows: ids.flatMap((id) => { const c = contacts.get(id); return c ? [{ id, personId: id, href: subjectHref(coldRef(id)), name: coldName(c), company: c.companyName, fo: foOfPerson.get(id) ?? (c.owner?.active ? c.owner.name : null), flowId: flowOf(id), step: null, status: null, exitReason: null }] : []; }),
  };
}
