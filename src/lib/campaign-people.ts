import { Prisma, type Campaign } from '@prisma/client';
import { prisma, type Tx } from './db';
import type { SessionUser } from './auth/current-user';
import { campaignAudienceIssues, whoAndWhy } from './campaign-audience';
import { canAddFromAnyPod, canApproveCampaign, canEditCampaign, canManageCampaigns } from './auth/rbac';
import { addFoWindow } from './campaign-add-fo';
import type { CampaignDraft } from './campaign-planner';
import { replanScheduledCampaign, type PublishedCalendar } from './campaign-planning-service';
import { logAudit, userActor } from './audit';

/**
 * The FOs working a campaign: its plan's team and anyone running one of its enrollments. These
 * are the FOs who may change its people (see canChangeCampaignPeople).
 */
export async function campaignFoIds(c: Pick<Campaign, 'id' | 'plannerDraft' | 'publishedPlan'>, db: Tx = prisma): Promise<string[]> {
  const draft = c.plannerDraft as unknown as CampaignDraft | null;
  const plan = c.publishedPlan as unknown as PublishedCalendar | null;
  const running = await db.enrollment.findMany({ where: { campaignId: c.id }, distinct: ['foUserId'], select: { foUserId: true } });
  return [...new Set([...(draft?.fos ?? []).map((f) => f.id), ...(plan?.fos ?? []).map((f) => f.id), ...running.map((e) => e.foUserId)])];
}

/**
 * Who works a campaign, for canChangeCampaignPeople. A campaign from before the studio has no plan
 * of its own: until it runs, everyone who works its pod; once it runs, the FOs running it.
 */
export async function campaignTeam(c: Pick<Campaign, 'id' | 'podId' | 'plannerDraft' | 'publishedPlan'>, db: Tx = prisma) {
  const foIds = await campaignFoIds(c, db);
  return { podId: c.podId, foIds, podWide: !c.plannerDraft && foIds.length === 0 };
}

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
/** " Not added: Jane Doe (marked Do not contact in Twenty)." - each reason once, with who it stops. */
const skipped = (items: { name: string; reason: string }[]) => (items.length ? ` Not added: ${whoAndWhy(items)}.` : '');

/** A scheduled campaign that went back to draft: that it will not start, why, and who can put it right. */
function backInDraft(user: SessionUser, campaign: Campaign, podName: string, why: string | null) {
  const canPublish = canEditCampaign(user, campaign) && (!campaign.followupSourceId || canApproveCampaign(user, campaign.podId));
  const fixer = canPublish ? 'Open it, fix this and publish it again.' : campaign.followupSourceId ? '' : `Ask whoever created it, or a Senior FO, Sales Leader or Pod Manager of ${podName}, to publish it again.`;
  return `${campaign.name} is no longer scheduled and will not start until it is published again. ${why ?? ''} ${fixer}`.replace(/  +/g, ' ').trim();
}

/**
 * People added from People to a campaign planned in the studio.
 * - Draft or waiting for approval: they join its audience; the plan is made when it is published.
 * - Scheduled: planned again and published in place, or back for review when that cannot hold.
 * - Running: its plan is fixed; a new FO with their people can join on the start day, from the campaign.
 * Whoever cannot be in it is skipped, with the reason, the way the studio would leave them out.
 */
export async function addPeopleToCalendarCampaign(user: SessionUser, campaign: Campaign, ids: string[]): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (['STOPPED', 'COMPLETED'].includes(campaign.status)) return { ok: false, error: `${campaign.name} has ended.` };
  if (!['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED'].includes(campaign.status)) return { ok: false, error: `${campaign.name} has started, so its people can't change.${addFoWindow(campaign).open && canManageCampaigns(user, campaign.podId) ? ' Today is its start day, so you can still add a new FO with their own people from the campaign page.' : ''}` };
  if (campaign.followupSourceId) return { ok: false, error: `${campaign.name} is a follow-up: it holds only the people who did not reply to the campaign before it.` };
  const fresh = ids.filter((id) => !campaign.personIds.includes(id));
  if (!fresh.length) return { ok: true, message: 'Everyone chosen is already in this campaign.' };
  const pod = await prisma.pod.findUniqueOrThrow({ where: { id: campaign.podId } });
  const draft = campaign.plannerDraft as unknown as CampaignDraft & { request?: CampaignDraft };
  const fos = await prisma.user.findMany({ where: { id: { in: (draft.request ?? draft).fos.map((f) => f.id) } }, select: { twentyMemberId: true } });
  const ownerMemberIds = fos.flatMap((f) => (f.twentyMemberId ? [f.twentyMemberId] : []));
  const issues = await campaignAudienceIssues(fresh, { podId: pod.id, podOwnerValue: pod.podOwnerValue, podName: pod.name, ownerMemberIds, campaignId: campaign.id, checkOwners: ownerMemberIds.length > 0, anyPod: canAddFromAnyPod(user) });
  const refused = new Set(issues.map((i) => i.id));
  const accepted = fresh.filter((id) => !refused.has(id));
  const note = skipped(issues);
  if (!accepted.length) return { ok: false, error: `Nobody could be added to ${campaign.name}: ${whoAndWhy(issues)}.` };
  const add = (d: CampaignDraft) => ({ ...d, personIds: [...new Set([...d.personIds, ...accepted])] });

  if (campaign.status === 'SCHEDULED') {
    const r = await replanScheduledCampaign(campaign.id, add, user, 'people_added');
    if (r.outcome === 'withdrawn') return { ok: true, message: `${people(accepted.length)} added. ${backInDraft(user, campaign, pod.name, r.reason)}${note}` };
    const planned = new Set(r.plan!.draft.personIds);
    const out = accepted.filter((id) => !planned.has(id));
    const why = r.plan!.leftOut.filter((l) => out.includes(l.id));
    if (out.length === accepted.length) return { ok: false, error: `Nobody could be added to ${campaign.name}: ${whoAndWhy([...issues, ...why])}.` };
    return { ok: true, message: `${people(accepted.length - out.length)} added to ${campaign.name}, and its calendar was updated.${skipped([...issues, ...why])}` };
  }

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${campaign.id}`}))`;
    const now = await tx.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(now.status)) throw new Error('This campaign changed. Refresh and try again.');
    const d = now.plannerDraft as unknown as CampaignDraft & { request?: CampaignDraft };
    await tx.campaign.update({ where: { id: now.id }, data: { personIds: [...new Set([...now.personIds, ...accepted])], plannerDraft: { ...add(d), ...(d.request ? { request: add(d.request) } : {}) } as unknown as Prisma.InputJsonValue } });
    await logAudit({ entityType: 'campaign', entityId: now.id, action: 'people_added', actor: userActor(user), details: { added: accepted.length, skipped: issues.length } }, tx);
  });
  return { ok: true, message: `${people(accepted.length)} added to ${campaign.name}. They are planned when it is published.${note}` };
}

/**
 * People taken out, from People, of a studio campaign that has not started. A scheduled one is
 * planned again and published in place; when it cannot hold without them it goes back for review.
 */
export async function removePeopleFromUpcomingCalendar(user: SessionUser, campaign: Campaign, ids: string[]): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const drop = new Set(ids);
  const count = campaign.personIds.filter((id) => drop.has(id)).length + ((campaign.plannerDraft as unknown as { request?: CampaignDraft })?.request?.personIds.filter((id) => drop.has(id) && !campaign.personIds.includes(id)).length ?? 0);
  if (!count) return { ok: true, message: 'Nobody chosen was in this campaign.' };
  const without = (d: CampaignDraft) => ({ ...d, personIds: d.personIds.filter((id) => !drop.has(id)), assignments: Object.fromEntries(Object.entries(d.assignments).filter(([id]) => !drop.has(id))), ...(d.foAssignments ? { foAssignments: Object.fromEntries(Object.entries(d.foAssignments).filter(([id]) => !drop.has(id))) } : {}) });
  if (campaign.status === 'SCHEDULED') {
    const r = await replanScheduledCampaign(campaign.id, without, user, 'people_removed');
    return { ok: true, message: r.outcome === 'republished' ? `${people(count)} removed from ${campaign.name}, and its calendar was updated.` : `${people(count)} removed. ${backInDraft(user, campaign, (await prisma.pod.findUnique({ where: { id: campaign.podId }, select: { name: true } }))?.name ?? 'its pod', r.reason)}` };
  }
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('campaign-planner-publication'))`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${campaign.id}`}))`;
    const now = await tx.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(now.status)) throw new Error('This campaign changed. Refresh and try again.');
    const d = now.plannerDraft as unknown as CampaignDraft & { request?: CampaignDraft };
    await tx.campaign.update({ where: { id: now.id }, data: { personIds: now.personIds.filter((id) => !drop.has(id)), plannerDraft: { ...without(d), ...(d.request ? { request: without(d.request) } : {}) } as unknown as Prisma.InputJsonValue } });
    await logAudit({ entityType: 'campaign', entityId: now.id, action: 'people_removed', actor: userActor(user), details: { removed: count } }, tx);
  });
  return { ok: true, message: `${people(count)} removed from ${campaign.name}.` };
}

