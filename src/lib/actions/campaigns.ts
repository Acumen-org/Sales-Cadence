'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canApproveCampaign, canManageCampaigns } from '../auth/rbac';
import { logAudit, userActor } from '../audit';
import { parsePersonIds } from '../csv';
import { isLocalDate, todayIn } from '../dates';
import { enrollPeople, exitEnrollment, previewEnrollment, type EnrollPreview } from '../engine/enrollment';
import { campaignChoices } from '../campaign-membership';
import { enrollConflictLabel } from '../campaign-status';
import { endDateThatFits, planCampaignCapacity, type CapacityPlan } from '../engine/capacity';
import { nonReplierCandidates } from '../campaigns-query';
import { activateCampaign, changeCampaignStatus } from '../engine/campaigns';
import { defaultTwentySchema } from '../twenty/twenty-schema';
import type { ActionResult } from './users';

/**
 * A campaign is a plan, a pod, a product, two dates and its people. Its size follows from the
 * dates: the planner says how many the pod can start between them and still finish by the end,
 * and a bigger audience is refused with the two ways out - a later end date, or fewer people.
 */
const CampaignSchema = z.object({
  name: z.string().trim().min(1, 'Name the campaign.').max(120),
  sequenceId: z.string().min(1, 'Choose a sequence.'),
  podId: z.string().min(1, 'Choose a pod.'),
  productInterest: z.array(z.string().min(1)).min(1, 'Choose at least one product.'),
  startDate: z.string().trim(),
  endDate: z.string().trim(),
  description: z.string().trim().max(2000).optional(),
  sourceType: z.enum(['PICK', 'CSV']).default('PICK'),
  personIds: z.array(z.string().min(1)).default([]),
  csvText: z.string().default(''),
  /** A ceiling on starts per FO per day chosen by hand; blank lets the cap decide. */
  startsPerFoPerDay: z.coerce.number().int().min(1).max(500).optional().nullable(),
});

type CampaignInput = z.infer<typeof CampaignSchema>;

function readCampaignForm(formData: FormData) {
  let personIds: string[] = [];
  try {
    const raw = JSON.parse(String(formData.get('personIds') ?? '[]'));
    if (Array.isArray(raw)) personIds = raw.filter((v): v is string => typeof v === 'string');
  } catch {
    personIds = [];
  }
  const products = formData.getAll('productInterest').map(String).filter((v) => (defaultTwentySchema.personValues.productInterest as readonly string[]).includes(v));
  return CampaignSchema.safeParse({
    name: formData.get('name'),
    sequenceId: formData.get('sequenceId'),
    podId: formData.get('podId'),
    productInterest: products,
    startDate: formData.get('startDate'),
    endDate: formData.get('endDate'),
    description: formData.get('description') || undefined,
    sourceType: formData.get('sourceType') ?? 'PICK',
    personIds,
    csvText: formData.get('csvText') ?? '',
    startsPerFoPerDay: formData.get('startsPerFoPerDay') === '' || formData.get('startsPerFoPerDay') === null ? null : formData.get('startsPerFoPerDay'),
  });
}

function formError(parsed: { success: false; error: z.ZodError }): ActionResult {
  return { ok: false, error: parsed.error.issues.map((i) => i.message).join(' ') };
}

/** The campaign's people: picked in the form, or the id column of a CSV export. */
function resolvePersonIds(d: CampaignInput): { ids: string[]; sourceRef: string | null; note: string | null } {
  if (d.sourceType === 'CSV') {
    const parsed = parsePersonIds(d.csvText);
    if (!parsed.ids.length) throw new Error('No person ids found in the file. It needs an id or personId column.');
    return { ids: parsed.ids, sourceRef: `CSV${parsed.column ? ` (column ${parsed.column})` : ''}`, note: parsed.skipped ? `${parsed.skipped} rows skipped` : null };
  }
  return { ids: [...new Set(d.personIds)], sourceRef: 'picked', note: null };
}

function checkWindow(d: Pick<CampaignInput, 'startDate' | 'endDate'>): string | null {
  if (!isLocalDate(d.startDate)) return 'Pick a valid start date.';
  if (!isLocalDate(d.endDate)) return 'Pick a valid end date.';
  if (d.endDate < d.startDate) return 'The end date is before the start date.';
  return null;
}

export type CapacitySummary = {
  total: number;
  touchesPerPerson: number;
  durationDays: number;
  startingDays: number;
  lastStart: string | null;
  tooShort: boolean;
  perFo: { id: string; name: string; rate: number; capacity: number; cap: number }[];
  /** The audience the summary was computed for, and the end date that would take all of it when it does not fit. */
  forAudience: number;
  endDateThatFits: string | null;
};

function summarise(plan: CapacityPlan & { durationDays: number }, audience: number, fits: string | null): CapacitySummary {
  return {
    total: plan.total,
    touchesPerPerson: plan.touchesPerPerson,
    durationDays: plan.durationDays,
    startingDays: plan.startingDays.length,
    lastStart: plan.lastStart,
    tooShort: plan.tooShort,
    perFo: plan.perFo.map((f) => ({ id: f.id, name: f.name, rate: f.rate, capacity: f.capacity, cap: f.cap })),
    forAudience: audience,
    endDateThatFits: fits,
  };
}

/** What the window can take, for the form's live line. Only the fields it needs have to be filled. */
export async function planCampaignAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const sequenceId = String(formData.get('sequenceId') ?? '');
  const podId = String(formData.get('podId') ?? '');
  const startDate = String(formData.get('startDate') ?? '');
  const endDate = String(formData.get('endDate') ?? '');
  const audience = Number(formData.get('audience') ?? 0) || 0;
  const rateRaw = String(formData.get('startsPerFoPerDay') ?? '').trim();
  const maxRate = rateRaw ? Number(rateRaw) : null;
  if (!sequenceId || !podId) return { ok: false, error: 'Choose a sequence and a pod.' };
  if (!canManageCampaigns(toActor(user), podId)) return { ok: false, error: 'You cannot create campaigns for this pod.' };
  const windowError = checkWindow({ startDate, endDate });
  if (windowError) return { ok: false, error: windowError };
  const plan = await planCampaignCapacity({ sequenceId, podId, startDate, endDate, maxRate: maxRate && maxRate > 0 ? maxRate : null });
  if ('error' in plan) return { ok: false, error: plan.error };
  const fits = audience > plan.total ? endDateThatFits(plan.input, audience) : null;
  return { ok: true, data: summarise(plan, audience, fits) };
}

export type CampaignPreview = EnrollPreview & { ids: string[]; note: string | null; capacity: CapacitySummary };

/** Who would start, who is skipped and why, and whether the window has room for them all. */
export async function previewCampaignAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = readCampaignForm(formData);
  if (!parsed.success) return formError(parsed);
  const d = parsed.data;
  if (!canManageCampaigns(toActor(user), d.podId)) return { ok: false, error: 'You cannot create campaigns for this pod.' };
  const windowError = checkWindow(d);
  if (windowError) return { ok: false, error: windowError };
  try {
    const { ids, note } = resolvePersonIds(d);
    const plan = await planCampaignCapacity({ sequenceId: d.sequenceId, podId: d.podId, startDate: d.startDate, endDate: d.endDate, maxRate: d.startsPerFoPerDay ?? null });
    if ('error' in plan) return { ok: false, error: plan.error };
    const preview = await previewEnrollment({
      personIds: ids,
      sequenceId: d.sequenceId,
      podId: d.podId,
      startDate: d.startDate,
      assignment: { mode: 'OWNER' },
      dailyRampByFo: Object.fromEntries(plan.perFo.map((f) => [f.id, f.rate])),
      lastStartDate: plan.lastStart,
      actor: userActor(user),
    });
    const wanted = preview.candidates.length + preview.conflicts.filter((c) => c.reason === 'no_room').length;
    const fits = wanted > plan.total ? endDateThatFits(plan.input, wanted) : null;
    const data: CampaignPreview = { ...preview, ids, note, capacity: summarise(plan, wanted, fits) };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function createCampaignAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = readCampaignForm(formData);
  if (!parsed.success) return formError(parsed);
  const d = parsed.data;
  if (!canManageCampaigns(user, d.podId)) return { ok: false, error: 'You cannot create campaigns for this pod.' };
  const windowError = checkWindow(d);
  if (windowError) return { ok: false, error: windowError };
  try {
    const { ids, sourceRef } = resolvePersonIds(d);
    if (!ids.length) return { ok: false, error: 'Choose at least one person.' };
    const sequence = await prisma.sequence.findUnique({ where: { id: d.sequenceId } });
    if (!sequence || sequence.archived) return { ok: false, error: 'Choose an available sequence.' };
    const plan = await planCampaignCapacity({ sequenceId: d.sequenceId, podId: d.podId, startDate: d.startDate, endDate: d.endDate, maxRate: d.startsPerFoPerDay ?? null });
    if ('error' in plan) return { ok: false, error: plan.error };
    if (plan.tooShort) return { ok: false, error: `This sequence needs ${plan.durationDays} days and the campaign runs ${d.startDate} to ${d.endDate}. The earliest end date that works is ${endDateThatFits(plan.input, 1) ?? 'more than a year away'}.` };
    const preview = await previewEnrollment({ personIds: ids, sequenceId: d.sequenceId, podId: d.podId, startDate: d.startDate, assignment: { mode: 'OWNER' }, dailyRampByFo: Object.fromEntries(plan.perFo.map((f) => [f.id, f.rate])), lastStartDate: plan.lastStart, actor: userActor(user) });
    const noRoom = preview.conflicts.filter((c) => c.reason === 'no_room').length;
    if (noRoom) {
      const wanted = preview.candidates.length + noRoom;
      const later = endDateThatFits(plan.input, wanted);
      return { ok: false, error: `The window fits ${plan.total} people and ${wanted} were chosen. ${later ? `Ending on ${later} would take them all, or` : 'Even a year would not take them all;'} trim the audience by ${noRoom}.` };
    }
    if (!preview.candidates.length) return { ok: false, error: 'Nobody in this audience can start. The review names each reason.' };
    const campaign = await prisma.campaign.create({
      data: {
        name: d.name, sequenceId: d.sequenceId, podId: d.podId, sourceType: d.sourceType === 'CSV' ? 'CSV' : 'IDS', sourceRef, personIds: ids,
        assignmentMode: 'OWNER', startDate: d.startDate, endDate: d.endDate, startsPerFoPerDay: d.startsPerFoPerDay ?? null, productInterest: d.productInterest,
        description: d.description?.trim() || null, status: 'SCHEDULED', approvedAt: new Date(), approvedById: user.id, createdById: user.id,
      },
    });
    await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'created', actor: userActor(user), details: { people: ids.length, startDate: d.startDate, endDate: d.endDate, capacity: plan.total } });
    await activateCampaign(campaign.id, { actor: userActor(user) });
    refreshCampaign(campaign.id);
    return { ok: true, message: 'Campaign created.', redirectTo: '/campaigns/' + campaign.id };
  } catch (error) { return failure(error); }
}
function failure(error: unknown): ActionResult { return { ok: false, error: error instanceof Error ? error.message : 'Campaign could not be updated.' }; }
function refreshCampaign(id: string) { revalidatePath('/campaigns'); revalidatePath('/campaigns/' + id); revalidatePath('/tasks'); revalidatePath('/people'); }
async function loadCampaignForUser(campaignId: string) {
  const user = await requireUser(); const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return { user, campaign: null, error: 'Campaign not found.' };
  if (!canManageCampaigns(user, campaign.podId)) return { user, campaign: null, error: 'You cannot manage this campaign.' };
  return { user, campaign, error: null };
}
async function transition(formData: FormData, status: 'PAUSED' | 'ACTIVE' | 'STOPPED'): Promise<ActionResult> {
  const { user, campaign, error } = await loadCampaignForUser(String(formData.get('campaignId') ?? ''));
  if (!campaign) return { ok: false, error: error ?? 'Not found.' };
  try { await changeCampaignStatus(campaign.id, status, userActor(user)); refreshCampaign(campaign.id); return { ok: true, message: status === 'PAUSED' ? 'Campaign paused.' : status === 'STOPPED' ? 'Campaign stopped.' : 'Campaign resumed.' }; } catch (error) { return failure(error); }
}
export async function pauseCampaignAction(data: FormData) { return transition(data, 'PAUSED'); }
export async function resumeCampaignAction(data: FormData) { return transition(data, 'ACTIVE'); }
export async function stopCampaignAction(data: FormData) { return transition(data, 'STOPPED'); }

export async function restartCampaignAction(data: FormData): Promise<ActionResult> {
  const { user, campaign, error } = await loadCampaignForUser(String(data.get('campaignId') ?? ''));
  if (!campaign) return { ok: false, error: error ?? 'Not found.' };
  const startDate = String(data.get('startDate') ?? todayIn(user.timezone));
  if (!isLocalDate(startDate)) return { ok: false, error: 'Pick a valid start date.' };
  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${'campaign:' + campaign.id}))`;
      const changed = await tx.campaign.updateMany({ where: { id: campaign.id, status: { in: ['STOPPED','COMPLETED'] }, runNumber: campaign.runNumber }, data: { status: campaign.followupSourceId ? 'PENDING_APPROVAL' : 'SCHEDULED', startDate, runNumber: { increment: 1 }, approvedAt: campaign.followupSourceId ? null : new Date(), approvedById: campaign.followupSourceId ? null : user.id } });
      if (!changed.count) throw new Error('Only stopped or completed campaigns can restart. Refresh to see its current state.');
      await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'restarted', actor: userActor(user), details: { run: campaign.runNumber + 1, startDate } }, tx);
    });
    await activateCampaign(campaign.id, { actor: userActor(user) }); refreshCampaign(campaign.id);
    return { ok: true, message: 'New campaign run scheduled. Previous history is retained.' };
  } catch (error) { return failure(error); }
}
export async function approveCampaignAction(data: FormData): Promise<ActionResult> {
  const { user, campaign, error } = await loadCampaignForUser(String(data.get('campaignId') ?? ''));
  if (!campaign) return { ok: false, error: error ?? 'Not found.' };
  if (!canApproveCampaign(user, campaign.podId)) return { ok: false, error: 'A Sales Leader for this pod or an admin must approve this campaign.' };
  try {
    const eligible = campaign.followupSourceId ? await nonReplierCandidates(campaign.followupSourceId, campaign.followupWaitDays, new Date(), campaign.followupSourceRun ?? undefined) : [];
    const ids = new Set(eligible.map(e => e.personId));
    const people = campaign.followupSourceId ? campaign.personIds.filter(id => ids.has(id)) : campaign.personIds;
    if (!people.length) return { ok: false, error: 'No contacts remain eligible. The request is still pending for review.' };
    const changed = await prisma.campaign.updateMany({ where: { id: campaign.id, status: 'PENDING_APPROVAL' }, data: { status: 'SCHEDULED', personIds: people, approvedAt: new Date(), approvedById: user.id } });
    if (!changed.count) return { ok: false, error: 'This request was already handled.' };
    await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'approved', actor: userActor(user), details: { people: people.length, startDate: campaign.startDate } });
    await activateCampaign(campaign.id, { actor: userActor(user) }); refreshCampaign(campaign.id);
    return { ok: true, message: 'Campaign approved.' };
  } catch (error) { return failure(error); }
}
export async function rejectCampaignAction(data: FormData): Promise<ActionResult> {
  const { user, campaign, error } = await loadCampaignForUser(String(data.get('campaignId') ?? ''));
  if (!campaign) return { ok: false, error: error ?? 'Not found.' };
  if (!canApproveCampaign(user, campaign.podId)) return { ok: false, error: 'A Sales Leader for this pod or an admin must review this request.' };
  const changed = await prisma.campaign.updateMany({ where: { id: campaign.id, status: 'PENDING_APPROVAL' }, data: { status: 'STOPPED' } });
  if (!changed.count) return { ok: false, error: 'This request was already handled.' };
  await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'rejected', actor: userActor(user) }); refreshCampaign(campaign.id);
  return { ok: true, message: 'Request declined.' };
}

const ReenrollSchema = z.object({ campaignId: z.string().min(1), sequenceId: z.string().min(1), days: z.coerce.number().int().min(0).max(365), name: z.string().trim().min(1).max(120), startDate: z.string(), confirm: z.string().optional() });
export type FollowupPreview = { candidates: Array<{ id: string; name: string; company: string | null; fo: string; completedAt: string | null }> };
export async function reenrollNonRepliersAction(data: FormData): Promise<ActionResult> {
  const parsed = ReenrollSchema.safeParse(Object.fromEntries(data.entries()));
  if (!parsed.success || !isLocalDate(parsed.data.startDate)) return { ok: false, error: 'Choose a sequence, campaign name, wait time and start date.' };
  const d = parsed.data; const { user, campaign, error } = await loadCampaignForUser(d.campaignId);
  if (!campaign) return { ok: false, error: error ?? 'Not found.' };
  const sequence = await prisma.sequence.findFirst({ where: { id: d.sequenceId, archived: false } });
  if (!sequence) return { ok: false, error: 'Choose an available sequence.' };
  const candidates = await nonReplierCandidates(campaign.id, d.days);
  const preview: FollowupPreview = { candidates: candidates.map(c => ({ id: c.personId, name: [c.person.firstName,c.person.lastName].filter(Boolean).join(' '), company: c.person.companyName, fo: c.fo.name, completedAt: c.completedAt?.toISOString() ?? null })) };
  if (d.confirm !== 'yes') return { ok: true, data: preview };
  if (!candidates.length) return { ok: false, error: 'No contacts qualify yet.' };
  const next = await prisma.campaign.create({ data: { name: d.name, sequenceId: d.sequenceId, podId: campaign.podId, sourceType: 'IDS', sourceRef: campaign.id, personIds: candidates.map(c => c.personId), assignmentMode: campaign.assignmentMode, startDate: d.startDate, endDate: campaign.endDate, startsPerFoPerDay: campaign.startsPerFoPerDay, productInterest: campaign.productInterest, status: 'PENDING_APPROVAL', followupSourceId: campaign.id, followupSourceRun: campaign.runNumber, followupWaitDays: d.days, createdById: user.id } });
  await logAudit({ entityType: 'campaign', entityId: next.id, action: 'approval_requested', actor: userActor(user), details: { sourceCampaignId: campaign.id, people: candidates.length } });
  refreshCampaign(next.id);
  return { ok: true, message: 'Follow-up submitted for approval.', redirectTo: '/campaigns/' + next.id };
}

// ---------------------------------------------------------------------------
// Membership: adding people to a campaign and taking them out, before or after it launches
// ---------------------------------------------------------------------------

function idsField(formData: FormData): string[] {
  try {
    const raw = JSON.parse(String(formData.get('personIds') ?? '[]'));
    return Array.isArray(raw) ? [...new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0))] : [];
  } catch {
    return [];
  }
}

/** The campaigns the reader may add people to, with the places each still has. */
export async function campaignChoicesAction(): Promise<ActionResult> {
  const user = await requireUser();
  const choices = await campaignChoices(user, { manageOnly: true });
  const today = todayIn(user.timezone);
  const withRoom = await Promise.all(choices.map(async (c) => {
    if (!c.endDate) return { ...c, placesLeft: null as number | null };
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id }, select: { sequenceId: true, startsPerFoPerDay: true } });
    const from = c.kind === 'upcoming' ? c.startDate : today > c.startDate ? today : c.startDate;
    const plan = await planCampaignCapacity({ sequenceId: campaign.sequenceId, podId: c.podId, startDate: from, endDate: c.endDate, maxRate: campaign.startsPerFoPerDay });
    // A running campaign's members already hold their places in the FO load the planner read, so
    // what it reports is room for newcomers; an upcoming one has committed nothing yet.
    return { ...c, placesLeft: 'error' in plan ? null : c.kind === 'upcoming' ? Math.max(0, plan.total - c.members) : plan.total };
  }));
  return { ok: true, data: withRoom };
}

export async function addPeopleToCampaignAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const campaignId = String(formData.get('campaignId') ?? '');
  const ids = idsField(formData);
  if (!ids.length) return { ok: false, error: 'Choose at least one person.' };
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return { ok: false, error: 'Campaign not found.' };
  if (!canManageCampaigns(user, campaign.podId)) return { ok: false, error: 'You cannot change this campaign.' };
  try {
    if (['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED'].includes(campaign.status)) {
      // The same check launch will run, so somebody promised elsewhere, do-not-contact or in
      // another pod is refused now, by name, rather than skipped silently on the day.
      const fresh = ids.filter((id) => !campaign.personIds.includes(id));
      if (!fresh.length) return { ok: true, message: 'Everyone chosen is already in this campaign.' };
      const check = await previewEnrollment({ personIds: fresh, sequenceId: campaign.sequenceId, podId: campaign.podId, campaignId, startDate: campaign.startDate, assignment: { mode: 'OWNER' }, actor: userActor(user) });
      if ('error' in check) return { ok: false, error: String(check.error) };
      const accepted = check.candidates.map((c) => c.personId);
      const merged = [...new Set([...campaign.personIds, ...accepted])];
      const added = merged.length - campaign.personIds.length;
      const skippedNote = check.conflicts.length ? `; ${check.conflicts.length} skipped (${[...new Set(check.conflicts.map((c) => enrollConflictLabel(c.reason)))].join(', ')})` : '';
      if (!added) return { ok: false, error: `Nobody could be added${skippedNote}.` };
      if (campaign.endDate) {
        const plan = await planCampaignCapacity({ sequenceId: campaign.sequenceId, podId: campaign.podId, startDate: campaign.startDate, endDate: campaign.endDate, maxRate: campaign.startsPerFoPerDay });
        if (!('error' in plan) && merged.length > plan.total) {
          const later = endDateThatFits(plan.input, merged.length);
          return { ok: false, error: `${campaign.name} fits ${plan.total} people and would hold ${merged.length}. ${later ? `Ending on ${later} would take them all.` : 'Even a year would not take them all.'}` };
        }
      }
      await prisma.campaign.update({ where: { id: campaignId }, data: { personIds: merged } });
      await logAudit({ entityType: 'campaign', entityId: campaignId, action: 'people_added', actor: userActor(user), details: { added, total: merged.length, skipped: check.conflicts.length } });
      refreshCampaign(campaignId);
      return { ok: true, message: `${added} added to ${campaign.name}${skippedNote}.` };
    }
    if (campaign.status !== 'ACTIVE') return { ok: false, error: `${campaign.name} is ${campaign.status.toLowerCase()}; people can be added to upcoming or active campaigns.` };
    // Running: they start now, within what the rest of the window can take.
    const today = todayIn(user.timezone);
    const start = today > campaign.startDate ? today : campaign.startDate;
    const plan = campaign.endDate ? await planCampaignCapacity({ sequenceId: campaign.sequenceId, podId: campaign.podId, startDate: start, endDate: campaign.endDate, maxRate: campaign.startsPerFoPerDay }) : null;
    const window = plan && !('error' in plan) ? plan : null;
    if (window?.tooShort) return { ok: false, error: `${campaign.name} ends on ${campaign.endDate}; there is no room to finish the sequence from today.` };
    const outcome = await enrollPeople({ personIds: ids, sequenceId: campaign.sequenceId, podId: campaign.podId, campaignId, startDate: start, assignment: { mode: 'OWNER' }, dailyRampByFo: window ? Object.fromEntries(window.perFo.map((f) => [f.id, f.rate])) : null, lastStartDate: window?.lastStart ?? null, actor: userActor(user) });
    await prisma.campaign.update({ where: { id: campaignId }, data: { personIds: [...new Set([...campaign.personIds, ...outcome.enrolled.map((e) => e.personId)])] } });
    refreshCampaign(campaignId);
    const skipped = outcome.conflicts.length;
    return { ok: true, message: `${outcome.enrolled.length} added to ${campaign.name}${skipped ? `; ${skipped} skipped (${[...new Set(outcome.conflicts.map((c) => enrollConflictLabel(c.reason)))].join(', ')})` : ''}.` };
  } catch (error) { return failure(error); }
}

export async function removePeopleFromCampaignAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const campaignId = String(formData.get('campaignId') ?? '');
  const ids = idsField(formData);
  if (!ids.length) return { ok: false, error: 'Choose at least one person.' };
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return { ok: false, error: 'Campaign not found.' };
  if (!canManageCampaigns(user, campaign.podId)) return { ok: false, error: 'You cannot change this campaign.' };
  try {
    const wanted = new Set(ids);
    const remaining = campaign.personIds.filter((id) => !wanted.has(id));
    const dropped = campaign.personIds.length - remaining.length;
    const live = await prisma.enrollment.findMany({ where: { campaignId, personId: { in: ids }, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true } });
    for (const e of live) await exitEnrollment(e.id, { reason: 'removed', actor: userActor(user) });
    if (dropped) await prisma.campaign.update({ where: { id: campaignId }, data: { personIds: remaining } });
    await logAudit({ entityType: 'campaign', entityId: campaignId, action: 'people_removed', actor: userActor(user), details: { removed: ids.length, endedEnrollments: live.length } });
    refreshCampaign(campaignId);
    const n = Math.max(dropped, live.length);
    return { ok: true, message: n ? `${n} removed from ${campaign.name}${live.length ? `; ${live.length} sequence${live.length === 1 ? '' : 's'} ended` : ''}.` : 'Nobody chosen was in this campaign.' };
  } catch (error) { return failure(error); }
}

/** The end-date switch: soft (people finish) or hard (what is left ends on the day). */
export async function setHardStopAction(formData: FormData): Promise<ActionResult> {
  const { user, campaign, error } = await loadCampaignForUser(String(formData.get('campaignId') ?? ''));
  if (!campaign) return { ok: false, error: error ?? 'Not found.' };
  const on = String(formData.get('on') ?? '') === '1';
  await prisma.campaign.update({ where: { id: campaign.id }, data: { hardStopAtEnd: on } });
  await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'updated', actor: userActor(user), details: { hardStopAtEnd: on } });
  refreshCampaign(campaign.id);
  return { ok: true, message: on ? 'What is left will stop at the end date.' : 'People mid-sequence will finish after the end date.' };
}
