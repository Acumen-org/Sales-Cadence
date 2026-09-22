import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, type Tx } from './db';
import type { SessionUser } from './auth/current-user';
import { canManageCampaigns, canApproveCampaign, ROLES_NEEDING_POD } from './auth/rbac';
import { externalPeopleWhere } from './internal-organizations';
import { cachedPersonName } from './person-cache';
import { cleanRichText } from './rich-text';
import { CampaignDraftSchema, buildCampaignCalendar, campaignBatches, suggestCampaignCalendar, type CampaignDraft, type CampaignCalendar } from './campaign-planner';
import { logAudit, userActor } from './audit';
import { todayIn } from './dates';
import { workspaceTimezone } from './workspace';
import { lockAccounts } from './account-lock';
import { nonReplierCandidates } from './campaigns-query';
import { defaultTwentySchema } from './twenty/twenty-schema';
import { fitCampaignStarter, outreachLimits } from './campaign-starter';

export type PublishedCalendar = CampaignCalendar & { sequenceIds: Record<string, string> };
const json = (data: unknown) => JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
export const calendarFingerprint = (draft: CampaignDraft, calendar: CampaignCalendar) => createHash('sha256').update(JSON.stringify({ draft, calendar })).digest('hex');

export async function prepareCampaign(draftInput: unknown, user: SessionUser, campaignId?: string, db: Tx = prisma) {
  const draft = CampaignDraftSchema.parse(draftInput);
  if (draft.productInterest.some(p => !(defaultTwentySchema.personValues.productInterest as readonly string[]).includes(p))) throw new Error('Choose an available product.');
  if (!canManageCampaigns(user, draft.podId)) throw new Error('You cannot manage campaigns for this pod.');
  const pod = await db.pod.findUnique({ where: { id: draft.podId } });
  if (!pod || pod.archived) throw new Error('Choose an available pod.');
  const fos = await db.user.findMany({ where: { id: { in: draft.fos.map(f => f.id) }, active: true, role: { in: ROLES_NEEDING_POD }, pods: { some: { podId: pod.id } } }, select: { id: true, name: true, twentyMemberId: true }, orderBy: { id: 'asc' } });
  if (fos.length !== draft.fos.length) throw new Error('A selected FO is unavailable or no longer belongs to this pod.');
  const people = await db.personCache.findMany({ where: { id: { in: draft.personIds }, deletedAt: null, dnd: false, optedOut: false, AND: [await externalPeopleWhere()], OR: [{ podOwner: pod.podOwnerValue }, { ownerMemberId: { in: fos.flatMap(f => f.twentyMemberId ? [f.twentyMemberId] : []) } }] }, orderBy: { id: 'asc' } });
  if (people.length !== draft.personIds.length) throw new Error('Some selected people are unavailable, blocked, opted out, or outside this pod. Review the audience.');
  const otherCampaigns = await db.campaign.findMany({ where: { id: campaignId ? { not: campaignId } : undefined, status: { in: ['SCHEDULED', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED'] }, personIds: { hasSome: draft.personIds } }, select: { personIds: true, name: true } });
  const busy = await db.enrollment.findFirst({ where: { personId: { in: draft.personIds }, status: { in: ['ACTIVE', 'PAUSED'] }, ...(campaignId ? { OR: [{ campaignId: null }, { campaignId: { not: campaignId } }] } : {}) } });
  if (otherCampaigns.length || busy) throw new Error('Some people already belong to another upcoming or active campaign. Remove them before publishing.');
  const blocked = await db.blockedAccount.count({ where: { companyId: { in: people.flatMap(p => p.companyId ? [p.companyId] : []) } } });
  if (blocked) throw new Error('The audience includes a blocked account. Remove it before continuing.');
  const records = people.map(p => ({ id: p.id, name: cachedPersonName(p), ownerMemberId: p.ownerMemberId, tags: p.tags, contactType: p.contactType, tier: p.tier }));
  const calendar = buildCampaignCalendar(draft, records, fos);
  return { draft, calendar, fingerprint: calendarFingerprint(draft, calendar), companyIds: people.map(p => p.companyId) };
}

export async function previewCampaignCalendar(input: unknown, user: SessionUser, campaignId?: string) {
  const p = await prepareCampaign(input, user, campaignId);
  return { ...p, limits: outreachLimits(p.draft, p.calendar.people, p.calendar.fos), suggestions: p.calendar.valid ? [] : suggestCampaignCalendar(p.draft, p.calendar.people, p.calendar.fos) };
}

export async function prepareCampaignStudio(input: unknown, user: SessionUser, campaignId?: string, fit = false) {
  const p = await prepareCampaign(input, user, campaignId);
  if (p.draft.startDate < todayIn(workspaceTimezone())) throw new Error('Choose a current or future start date.');
  if (!p.draft.personIds.length) throw new Error('Select the people for this campaign.');
  const grouped = campaignBatches(p.draft, p.calendar.people, p.calendar.fos);
  if (grouped.issues.length) throw new Error(grouped.issues.map(i => i.title).join(' '));
  const emptyFos = p.calendar.fos.filter(f => !grouped.batches.some(b => b.foId === f.id));
  if (emptyFos.length) throw new Error(`No audience is assigned to ${emptyFos.map(f => f.name).join(', ')}. Add their contacts or deselect them here.`);
  if (!fit) return previewCampaignCalendar(p.draft, user, campaignId);
  const fitted = fitCampaignStarter(p.draft, p.calendar.people, p.calendar.fos);
  if (!fitted) return { ...p, limits: outreachLimits(p.draft, p.calendar.people, p.calendar.fos), suggestions: suggestCampaignCalendar(p.draft, p.calendar.people, p.calendar.fos), starterBlocked: true as const };
  return { ...p, ...fitted, fingerprint: calendarFingerprint(fitted.draft, fitted.calendar), limits: outreachLimits(fitted.draft, p.calendar.people, p.calendar.fos), suggestions: [] };
}

export async function saveCampaignCalendar(input: unknown, user: SessionUser, options: { id?: string; revision?: string; publish?: boolean; fingerprint?: string }) {
  const checked = await prepareCampaign(input, user, options.id);
  const d = checked.draft;
  if (options.publish && d.startDate < todayIn(workspaceTimezone())) throw new Error('The start date has passed. Choose a current or future start date and review the calendar.');
  const id = options.id ?? randomUUID();
  return prisma.$transaction(async tx => {
    await lockAccounts(tx, checked.companyIds);
    // All planner publications reserve membership atomically, even across different campaigns.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('campaign-planner-publication'))`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const existing = await tx.campaign.findUnique({ where: { id } });
    if (options.id && !existing) throw new Error('Campaign no longer exists.');
    if (existing) {
      if (!canManageCampaigns(user, existing.podId)) throw new Error('You cannot edit this campaign.');
      if (options.publish && existing.followupSourceId && !canApproveCampaign(user, d.podId)) throw new Error('A Sales Leader, Pod Manager or admin must review and publish this follow-up campaign.');
      if (options.publish && existing.followupSourceId) {
        const eligible = new Set((await nonReplierCandidates(existing.followupSourceId, existing.followupWaitDays, new Date(), existing.followupSourceRun ?? undefined)).map(e => e.personId));
        if (d.personIds.some(id => !eligible.has(id))) throw new Error('Some people no longer qualify for this follow-up. Remove them and review the calendar again.');
      }
      if (!['DRAFT', 'SCHEDULED', 'PENDING_APPROVAL'].includes(existing.status) || await tx.enrollment.count({ where: { campaignId: id } })) throw new Error('This campaign has already started. Its plan is locked.');
      if (existing.updatedAt.toISOString() !== options.revision) throw new Error('Someone changed this campaign. Reload before saving to protect their changes.');
    }
    const fresh = await prepareCampaign(d, user, options.id, tx);
    if (options.publish && (!fresh.calendar.valid || fresh.fingerprint !== options.fingerprint)) throw new Error('The calendar needs another review. People or scheduling inputs changed, or the plan has unresolved issues.');
    const sequenceIds: Record<string, string> = {};
    const oldIds = (existing?.plannerDraft as (CampaignDraft & { sequenceIds?: Record<string, string> }) | null)?.sequenceIds ?? {};
    for (const flow of d.flows) {
      const steps = flow.steps.map(s => ({ ...s, actions: s.actions.map(a => ({ ...a, ...(a.bodyHtml ? { bodyHtml: cleanRichText(a.bodyHtml) } : {}) })) }));
      const data = { name: flow.id === 'default' ? 'Default' : flow.name, campaignOwned: true, steps: json(steps) };
      const owned = oldIds[flow.id] ? await tx.sequence.findFirst({ where: { id: oldIds[flow.id], campaignOwned: true } }) : null;
      const sequence = owned ? await tx.sequence.update({ where: { id: owned.id }, data }) : await tx.sequence.create({ data });
      sequenceIds[flow.id] = sequence.id;
    }
    const data = {
      name: d.name, podId: d.podId, startDate: d.startDate, endDate: d.endDate, personIds: d.personIds,
      productInterest: d.productInterest, startsPerFoPerDay: d.defaultBatchSize, sequenceId: sequenceIds.default,
      plannerDraft: json({ ...d, sequenceIds }), publishedPlan: options.publish ? json({ ...fresh.calendar, sequenceIds }) : Prisma.DbNull,
      status: options.publish ? 'SCHEDULED' as const : existing?.followupSourceId ? 'PENDING_APPROVAL' as const : 'DRAFT' as const, hardStopAtEnd: true,
      approvedAt: options.publish ? new Date() : null, approvedById: options.publish ? user.id : null,
    };
    const campaign = existing ? await tx.campaign.update({ where: { id }, data }) : await tx.campaign.create({ data: { id, ...data, createdById: user.id } });
    await tx.sequence.deleteMany({ where: { id: { in: Object.values(oldIds).filter(id => !Object.values(sequenceIds).includes(id)) }, campaignOwned: true, campaigns: { none: {} }, enrollments: { none: {} } } });
    await logAudit({ entityType: 'campaign', entityId: id, action: options.publish ? 'calendar_published' : 'draft_saved', actor: userActor(user), details: { people: d.personIds.length, batches: fresh.calendar.batches.length } }, tx);
    return campaign;
  }, { timeout: 60000 });
}
