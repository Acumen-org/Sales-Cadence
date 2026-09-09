'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canApproveCampaign, canManageCampaigns } from '../auth/rbac';
import { logAudit, userActor } from '../audit';
import { parsePersonIds } from '../csv';
import { isLocalDate, todayIn } from '../dates';
import { previewEnrollment, type EnrollPreview } from '../engine/enrollment';
import { nonReplierCandidates } from '../campaigns-query';
import { activateCampaign, changeCampaignStatus } from '../engine/campaigns';
import { upsertPersonCache } from '../person-cache';
import { getTwentyClient } from '../twenty';
import type { ActionResult } from './users';

const CampaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sequenceId: z.string().min(1),
  podId: z.string().min(1),
  sourceType: z.enum(['IDS', 'CSV', 'TWENTY_VIEW']),
  personIdsText: z.string().optional().default(''),
  viewId: z.string().trim().optional().default(''),
  assignmentMode: z.enum(['OWNER', 'ROUND_ROBIN']).default('OWNER'),
  startDate: z.string().trim(),
  dailyRampPerFo: z.coerce.number().int().min(0).optional().nullable(),
  notes: z.string().trim().max(2000).optional(),
});

type CampaignInput = z.infer<typeof CampaignSchema>;

function readCampaignForm(formData: FormData) {
  return CampaignSchema.safeParse({
    name: formData.get('name'),
    sequenceId: formData.get('sequenceId'),
    podId: formData.get('podId'),
    sourceType: formData.get('sourceType'),
    personIdsText: formData.get('personIdsText') ?? '',
    viewId: formData.get('viewId') ?? '',
    assignmentMode: formData.get('assignmentMode') ?? 'OWNER',
    startDate: formData.get('startDate'),
    dailyRampPerFo: formData.get('dailyRampPerFo') === '' || formData.get('dailyRampPerFo') === null ? null : formData.get('dailyRampPerFo'),
    notes: formData.get('notes') || undefined,
  });
}

/** Resolve the campaign's people: pasted ids, CSV text, or a saved Twenty view. */
async function resolvePersonIds(d: CampaignInput): Promise<{ ids: string[]; sourceRef: string | null; note: string | null }> {
  if (d.sourceType === 'TWENTY_VIEW') {
    if (!d.viewId) throw new Error('Enter the Twenty view id.');
    const client = await getTwentyClient();
    const { view, people } = await client.getViewPeople(d.viewId);
    for (const p of people) await upsertPersonCache(p);
    return { ids: people.map((p) => p.id), sourceRef: `${view.name} (${view.id})`, note: `${people.length} people from view "${view.name}"` };
  }
  const parsed = parsePersonIds(d.personIdsText);
  if (!parsed.ids.length) throw new Error('No person ids found. Paste one id per line, or a CSV with an id column.');
  return { ids: parsed.ids, sourceRef: d.sourceType === 'CSV' ? `CSV${parsed.column ? ` (column ${parsed.column})` : ''}` : 'pasted ids', note: parsed.skipped ? `${parsed.skipped} rows skipped` : null };
}

export type CampaignPreview = EnrollPreview & { ids: string[]; note: string | null };

export async function previewCampaignAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = readCampaignForm(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const d = parsed.data;
  if (!canManageCampaigns(toActor(user), d.podId)) return { ok: false, error: 'You cannot create campaigns for this pod.' };
  if (!isLocalDate(d.startDate)) return { ok: false, error: 'Pick a valid start date.' };
  try {
    const { ids, note } = await resolvePersonIds(d);
    const preview = await previewEnrollment({
      personIds: ids,
      sequenceId: d.sequenceId,
      podId: d.podId,
      startDate: d.startDate,
      assignment: { mode: d.assignmentMode },
      dailyRampPerFo: d.dailyRampPerFo || null,
      actor: userActor(user),
    });
    const data: CampaignPreview = { ...preview, ids, note };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function createCampaignAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser(); const parsed = readCampaignForm(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map(i => i.message).join('; ') };
  const d = parsed.data;
  if (!canManageCampaigns(user, d.podId)) return { ok: false, error: 'You cannot create campaigns for this pod.' };
  if (!isLocalDate(d.startDate)) return { ok: false, error: 'Pick a valid start date.' };
  try {
    const { ids, sourceRef } = await resolvePersonIds(d);
    const sequence = await prisma.sequence.findUnique({ where: { id: d.sequenceId } });
    if (!sequence || sequence.archived) return { ok: false, error: 'Choose an available sequence.' };
    const preview = await previewEnrollment({ personIds: ids, sequenceId: d.sequenceId, podId: d.podId, startDate: d.startDate, assignment: { mode: d.assignmentMode }, actor: userActor(user) });
    if (!preview.candidates.length) return { ok: false, error: 'No eligible contacts. Review the audience and assignment.' };
    const campaign = await prisma.campaign.create({ data: { name: d.name, sequenceId: d.sequenceId, podId: d.podId, sourceType: d.sourceType, sourceRef, personIds: ids, assignmentMode: d.assignmentMode, startDate: d.startDate, dailyRampPerFo: d.dailyRampPerFo || null, status: 'SCHEDULED', approvedAt: new Date(), approvedById: user.id, createdById: user.id } });
    await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'created', actor: userActor(user), details: { people: ids.length, startDate: d.startDate } });
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
  const next = await prisma.campaign.create({ data: { name: d.name, sequenceId: d.sequenceId, podId: campaign.podId, sourceType: 'IDS', sourceRef: campaign.id, personIds: candidates.map(c => c.personId), assignmentMode: campaign.assignmentMode, startDate: d.startDate, dailyRampPerFo: campaign.dailyRampPerFo, status: 'PENDING_APPROVAL', followupSourceId: campaign.id, followupSourceRun: campaign.runNumber, followupWaitDays: d.days, createdById: user.id } });
  await logAudit({ entityType: 'campaign', entityId: next.id, action: 'approval_requested', actor: userActor(user), details: { sourceCampaignId: campaign.id, people: candidates.length } });
  refreshCampaign(next.id);
  return { ok: true, message: 'Follow-up submitted for approval.', redirectTo: '/campaigns/' + next.id };
}

