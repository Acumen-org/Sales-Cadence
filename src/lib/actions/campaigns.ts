'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canManageCampaigns } from '../auth/rbac';
import { logAudit, userActor } from '../audit';
import { parsePersonIds } from '../csv';
import { isLocalDate, todayIn } from '../dates';
import { enrollPeople, exitEnrollment, pauseEnrollment, previewEnrollment, resumeEnrollment, type EnrollPreview } from '../engine/enrollment';
import { nonReplierCandidates } from '../campaigns-query';
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
  const user = await requireUser();
  const parsed = readCampaignForm(formData);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const d = parsed.data;
  if (!canManageCampaigns(toActor(user), d.podId)) return { ok: false, error: 'You cannot create campaigns for this pod.' };
  if (!isLocalDate(d.startDate)) return { ok: false, error: 'Pick a valid start date.' };
  try {
    const { ids, sourceRef } = await resolvePersonIds(d);
    const campaign = await prisma.campaign.create({
      data: {
        name: d.name,
        sequenceId: d.sequenceId,
        podId: d.podId,
        sourceType: d.sourceType,
        sourceRef,
        personIds: ids,
        assignmentMode: d.assignmentMode,
        startDate: d.startDate,
        dailyRampPerFo: d.dailyRampPerFo || null,
        status: 'ACTIVE',
        notes: d.notes ?? null,
        createdById: user.id,
      },
    });
    await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'created', actor: userActor(user), details: { people: ids.length, sourceType: d.sourceType } });
    const r = await enrollPeople({
      personIds: ids,
      sequenceId: d.sequenceId,
      podId: d.podId,
      campaignId: campaign.id,
      startDate: d.startDate,
      assignment: { mode: d.assignmentMode },
      dailyRampPerFo: d.dailyRampPerFo || null,
      actor: userActor(user),
    });
    revalidatePath('/campaigns');
    revalidatePath('/tasks');
    revalidatePath('/people');
    return { ok: true, message: `Campaign created: ${r.enrolled.length} enrolled, ${r.conflicts.length} skipped.`, redirectTo: `/campaigns/${campaign.id}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function loadCampaignForUser(campaignId: string) {
  const user = await requireUser();
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return { user, campaign: null, error: 'Campaign not found.' };
  if (!canManageCampaigns(toActor(user), campaign.podId)) return { user, campaign: null, error: 'You cannot manage this campaign.' };
  return { user, campaign, error: null };
}

export async function pauseCampaignAction(formData: FormData): Promise<ActionResult> {
  const { user, campaign, error } = await loadCampaignForUser(String(formData.get('campaignId') ?? ''));
  if (!campaign) return { ok: false, error: error ?? 'Not found.' };
  const active = await prisma.enrollment.findMany({ where: { campaignId: campaign.id, status: 'ACTIVE' }, select: { id: true } });
  for (const e of active) await pauseEnrollment(e.id, { reason: 'campaign_paused', actor: userActor(user) });
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'PAUSED' } });
  await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'paused', actor: userActor(user), details: { enrollments: active.length } });
  revalidatePath(`/campaigns/${campaign.id}`);
  revalidatePath('/campaigns');
  revalidatePath('/tasks');
  return { ok: true, message: `Paused ${active.length} enrollments.` };
}

export async function resumeCampaignAction(formData: FormData): Promise<ActionResult> {
  const { user, campaign, error } = await loadCampaignForUser(String(formData.get('campaignId') ?? ''));
  if (!campaign) return { ok: false, error: error ?? 'Not found.' };
  const paused = await prisma.enrollment.findMany({ where: { campaignId: campaign.id, status: 'PAUSED', pauseReason: 'campaign_paused' }, select: { id: true } });
  for (const e of paused) await resumeEnrollment(e.id, { actor: userActor(user) });
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'ACTIVE' } });
  await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'resumed', actor: userActor(user), details: { enrollments: paused.length } });
  revalidatePath(`/campaigns/${campaign.id}`);
  revalidatePath('/campaigns');
  revalidatePath('/tasks');
  return { ok: true, message: `Resumed ${paused.length} enrollments.` };
}

export async function stopCampaignAction(formData: FormData): Promise<ActionResult> {
  const { user, campaign, error } = await loadCampaignForUser(String(formData.get('campaignId') ?? ''));
  if (!campaign) return { ok: false, error: error ?? 'Not found.' };
  const open = await prisma.enrollment.findMany({ where: { campaignId: campaign.id, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true } });
  for (const e of open) await exitEnrollment(e.id, { reason: 'campaign_stopped', actor: userActor(user) });
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'STOPPED' } });
  await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'stopped', actor: userActor(user), details: { enrollments: open.length } });
  revalidatePath(`/campaigns/${campaign.id}`);
  revalidatePath('/campaigns');
  revalidatePath('/tasks');
  return { ok: true, message: `Stopped. ${open.length} enrollments exited.` };
}

const ReenrollSchema = z.object({
  campaignId: z.string().min(1),
  sequenceId: z.string().min(1),
  days: z.coerce.number().int().min(0).max(365),
  name: z.string().trim().min(1).max(120),
  startDate: z.string().trim().optional(),
  confirm: z.string().optional(),
});

/** Re-enrol people who finished this campaign without replying into another sequence. */
export async function reenrollNonRepliersAction(formData: FormData): Promise<ActionResult> {
  const parsed = ReenrollSchema.safeParse({
    campaignId: formData.get('campaignId'),
    sequenceId: formData.get('sequenceId'),
    days: formData.get('days') ?? 0,
    name: formData.get('name'),
    startDate: formData.get('startDate') || undefined,
    confirm: formData.get('confirm') || undefined,
  });
  if (!parsed.success) return { ok: false, error: 'Pick a sequence, a wait time and a name for the new campaign.' };
  const d = parsed.data;
  const { user, campaign, error } = await loadCampaignForUser(d.campaignId);
  if (!campaign) return { ok: false, error: error ?? 'Not found.' };
  const candidates = await nonReplierCandidates(campaign.id, d.days);
  if (!candidates.length) return { ok: false, error: `Nobody qualifies yet (completed at least ${d.days} days ago, no reply, not enrolled elsewhere).` };
  if (d.confirm !== 'yes') return { ok: true, message: `${candidates.length} people qualify. Confirm to create the follow-up campaign.`, data: { count: candidates.length } };

  const startDate = d.startDate && isLocalDate(d.startDate) ? d.startDate : todayIn(user.timezone);
  const next = await prisma.campaign.create({
    data: {
      name: d.name,
      sequenceId: d.sequenceId,
      podId: campaign.podId,
      sourceType: 'IDS',
      sourceRef: `re-enrol non-repliers of ${campaign.name}`,
      personIds: candidates.map((c) => c.personId),
      assignmentMode: campaign.assignmentMode,
      startDate,
      dailyRampPerFo: campaign.dailyRampPerFo,
      status: 'ACTIVE',
      createdById: user.id,
    },
  });
  await logAudit({ entityType: 'campaign', entityId: next.id, action: 'created', actor: userActor(user), details: { reenrollFrom: campaign.id, people: candidates.length, afterDays: d.days } });
  // Keep the same FO where possible, so the relationship continues.
  let enrolled = 0;
  const byFo = new Map<string, string[]>();
  for (const c of candidates) byFo.set(c.foUserId, [...(byFo.get(c.foUserId) ?? []), c.personId]);
  for (const [foUserId, personIds] of byFo) {
    const r = await enrollPeople({ personIds, sequenceId: d.sequenceId, podId: campaign.podId, campaignId: next.id, startDate, assignment: { mode: 'FIXED', foUserId }, dailyRampPerFo: campaign.dailyRampPerFo, actor: userActor(user) });
    enrolled += r.enrolled.length;
  }
  revalidatePath('/campaigns');
  revalidatePath('/tasks');
  return { ok: true, message: `Created "${next.name}" with ${enrolled} people.`, redirectTo: `/campaigns/${next.id}` };
}
