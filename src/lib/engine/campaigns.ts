import type { CampaignStatus } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, type AuditActor, SYSTEM_ACTOR } from '../audit';
import { todayIn } from '../dates';
import { WORKSPACE_TIMEZONE } from '../workspace';
import { previewEnrollment, resumeEnrollment } from './enrollment';
import { advanceEnrollment, syncCancelled, type EngineContext } from './tasks';
import { nonReplierCandidates } from '../campaigns-query';

/** Status and related enrollment changes share a lock with task generation. */
export async function changeCampaignStatus(id: string, status: 'PAUSED' | 'STOPPED' | 'ACTIVE', actor: AuditActor, now = new Date()) {
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id }, include: { pod: true } });
    if (campaign.pod.archived && status === 'ACTIVE') throw new Error('Restore the pod before resuming this campaign.');
    const allowed: CampaignStatus[] = status === 'PAUSED' ? ['ACTIVE','SCHEDULED'] : status === 'ACTIVE' ? ['PAUSED'] : ['ACTIVE','PAUSED','SCHEDULED','PENDING_APPROVAL','DRAFT'];
    if (!allowed.includes(campaign.status)) throw new Error('Campaign state changed. Refresh and try again.');
    const cancelled: string[] = [];
    if (status === 'PAUSED') await tx.enrollment.updateMany({ where: { campaignId: id, status: 'ACTIVE' }, data: { status: 'PAUSED', pausedAt: now, pauseReason: 'campaign_paused' } });
    if (status === 'STOPPED') {
      const tasks = await tx.task.findMany({ where: { state: 'PENDING', enrollment: { campaignId: id } }, select: { id: true } });
      cancelled.push(...tasks.map(t => t.id));
      await tx.task.updateMany({ where: { id: { in: cancelled }, state: 'PENDING' }, data: { state: 'CANCELLED', cancelReason: 'campaign_stopped' } });
      await tx.enrollment.updateMany({ where: { campaignId: id, status: { in: ['ACTIVE','PAUSED'] } }, data: { status: 'EXITED', exitReason: 'campaign_stopped', exitedAt: now } });
    }
    const hasRun = status === 'ACTIVE' ? await tx.enrollment.count({ where: { campaignId: id, campaignRun: campaign.runNumber } }) : 0;
    const nextStatus = status === 'ACTIVE' && !hasRun ? 'SCHEDULED' : status;
    await tx.campaign.update({ where: { id }, data: { status: nextStatus } });
    await logAudit({ entityType: 'campaign', entityId: id, action: status === 'PAUSED' ? 'paused' : status === 'STOPPED' ? 'stopped' : 'resumed', actor, details: { status: nextStatus } }, tx);
    return { cancelled, nextStatus };
  });
  if (result.cancelled.length) await syncCancelled(result.cancelled, { actor });
  if (status === 'ACTIVE') {
    const paused = await prisma.enrollment.findMany({ where: { campaignId: id, status: 'PAUSED', pauseReason: 'campaign_paused' }, select: { id: true } });
    for (const e of paused) await resumeEnrollment(e.id, { actor, now });
    await activateCampaign(id, { actor, now });
  }
  return result;
}

/** Launch is atomic. A crash leaves either a scheduled campaign or a complete enrolled run. */
export async function activateCampaign(id: string, ctx: EngineContext = { actor: SYSTEM_ACTOR }) {
  const now = ctx.now ?? new Date();
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { sequence: true, pod: true } });
  if (!campaign || campaign.status !== 'SCHEDULED' || campaign.startDate > todayIn(WORKSPACE_TIMEZONE, now)) return { enrolled: 0, skipped: 0 };
  if (campaign.pod.archived || campaign.sequence.archived) throw new Error('Campaign needs an available pod and sequence.');
  let ids = campaign.personIds;
  if (campaign.followupSourceId) {
    const eligible = await nonReplierCandidates(campaign.followupSourceId, campaign.followupWaitDays, now, campaign.followupSourceRun ?? undefined);
    const eligibleIds = new Set(eligible.map(e => e.personId));
    ids = ids.filter(personId => eligibleIds.has(personId));
  }
  const preview = await previewEnrollment({ personIds: ids, sequenceId: campaign.sequenceId, podId: campaign.podId, campaignId: id, startDate: campaign.startDate, assignment: { mode: campaign.assignmentMode === 'ROUND_ROBIN' ? 'ROUND_ROBIN' : 'OWNER' }, dailyRampPerFo: campaign.dailyRampPerFo, actor: ctx.actor });
  const created = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const current = await tx.campaign.findUniqueOrThrow({ where: { id }, include: { sequence: true, pod: true } });
    await tx.$queryRaw`SELECT id FROM "Pod" WHERE id = ${current.podId} FOR UPDATE`;
    if (current.status !== 'SCHEDULED' || current.runNumber !== campaign.runNumber) return [];
    const lockedPod = await tx.pod.findUniqueOrThrow({ where: { id: current.podId } });
    if (lockedPod.archived || current.sequence.archived) throw new Error('Pod or sequence is unavailable.');
    const personIds = preview.candidates.map(c => c.personId);
    const people = await tx.personCache.findMany({ where: { id: { in: personIds }, dnd: false, optedOut: false, deletedAt: null } });
    const busy = await tx.enrollment.findMany({ where: { personId: { in: personIds }, status: { in: ['ACTIVE','PAUSED'] } }, select: { personId: true } });
    const blocked = new Set(busy.map(e => e.personId));
    if (current.followupSourceId) {
      const replied = await tx.touch.findMany({ where: { personId: { in: personIds }, direction: 'INBOUND', occurredAt: { gte: campaign.createdAt } }, select: { personId: true } });
      for (const reply of replied) blocked.add(reply.personId);
    }
    const peopleById = new Map(people.map(p => [p.id,p]));
    const proposedFos = [...new Set(preview.candidates.map(c => c.foUserId))].sort();
    for (const userId of proposedFos) await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR SHARE`;
    const availableFos = await tx.user.findMany({ where: { id: { in: proposedFos }, active: true, pods: { some: { podId: current.podId } } }, select: { id: true } });
    const availableFoIds = new Set(availableFos.map(u => u.id));
    const candidates = preview.candidates.filter(c => peopleById.has(c.personId) && !blocked.has(c.personId) && availableFoIds.has(c.foUserId));
    await tx.enrollment.createMany({ data: candidates.map(c => ({ personId: c.personId, companyId: peopleById.get(c.personId)?.companyId, foUserId: c.foUserId, podId: campaign.podId, campaignId: id, campaignRun: current.runNumber, sequenceId: campaign.sequenceId, startDate: c.startDate, status: 'ACTIVE', createdById: ctx.actor.type === 'USER' ? ctx.actor.id : null, createdAt: now })), skipDuplicates: true });
    const enrollments = await tx.enrollment.findMany({ where: { campaignId: id, campaignRun: current.runNumber }, select: { id: true, personId: true } });
    await tx.campaign.update({ where: { id }, data: { status: enrollments.length ? 'ACTIVE' : 'COMPLETED' } });
    await logAudit({ entityType: 'campaign', entityId: id, action: 'started', actor: ctx.actor, details: { run: current.runNumber, enrolled: enrollments.length, skipped: campaign.personIds.length - enrollments.length } }, tx);
    for (const e of enrollments) await logAudit({ entityType: 'enrollment', entityId: e.id, action: 'enrolled', actor: ctx.actor, details: { campaignId: id, personId: e.personId, run: current.runNumber } }, tx);
    return enrollments;
  }, { timeout: 60000 });
  for (const e of created) await advanceEnrollment(e.id, ctx);
  return { enrolled: created.length, skipped: campaign.personIds.length - created.length };
}

export async function launchScheduledCampaigns(ctx: EngineContext) {
  const due = await prisma.campaign.findMany({ where: { status: 'SCHEDULED', startDate: { lte: todayIn(WORKSPACE_TIMEZONE, ctx.now) } }, select: { id: true }, take: 100 });
  for (const campaign of due) {
    try { await activateCampaign(campaign.id, ctx); }
    catch (error) { await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'launch_failed', actor: ctx.actor, details: { error: error instanceof Error ? error.message : 'Launch failed' } }); }
  }
}
