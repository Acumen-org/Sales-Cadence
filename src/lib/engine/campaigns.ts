import { lockAccounts } from '../account-lock';
import { activateCalendarCampaign } from './campaign-calendar';
import type { CampaignStatus } from '@prisma/client';
import { prisma } from '../db';
import { planCampaignCapacity } from './capacity';
import { logAudit, type AuditActor, SYSTEM_ACTOR } from '../audit';
import { todayIn } from '../dates';
import { workspaceTimezone } from '../workspace';
import { previewEnrollment, resumeEnrollment } from './enrollment';
import { advanceEnrollment, syncCancelled, type EngineContext } from './tasks';
import { nonReplierCandidates } from '../campaigns-query';
import { notify, podLeaders } from '../notifications';

/** Status and related enrollment changes share a lock with task generation. */
export async function changeCampaignStatus(id: string, status: 'PAUSED' | 'STOPPED' | 'ACTIVE', actor: AuditActor, now = new Date()) {
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const campaign = await tx.campaign.findUniqueOrThrow({ where: { id }, include: { pod: true } });
    if (campaign.pod.archived && status === 'ACTIVE') throw new Error(`${campaign.pod.name} has been archived, so this campaign cannot resume. An admin can restore the pod in Settings.`);
    if (campaign.plannerDraft && status === 'ACTIVE' && campaign.endDate && campaign.endDate < todayIn(workspaceTimezone(), now)) throw new Error('Its end date has passed, so it cannot resume. Stop it, then use Plan another run to set new dates.');
    const allowed: CampaignStatus[] = status === 'PAUSED' ? ['ACTIVE','SCHEDULED'] : status === 'ACTIVE' ? ['PAUSED'] : ['ACTIVE','PAUSED','SCHEDULED','PENDING_APPROVAL','DRAFT'];
    if (!allowed.includes(campaign.status)) throw new Error('Someone else changed this campaign a moment ago. Refresh the page to see where it stands.');
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
    // P04: one person who cannot be resumed now does not hold back the rest; the worker resumes
    // anyone left Paused in a running campaign (resumeReleasedEnrollments).
    for (const e of paused) {
      try { await resumeEnrollment(e.id, { actor, now }); } catch (error) { console.warn('[campaign] resume left for the worker', e.id, error); }
    }
    await activateCampaign(id, { actor, now });
  }
  return result;
}

/** Launch is atomic. A crash leaves either a scheduled campaign or a complete enrolled run. */
export async function activateCampaign(id: string, ctx: EngineContext = { actor: SYSTEM_ACTOR }) {
  const now = ctx.now ?? new Date();
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { sequence: true, pod: true } });
  if (!campaign || campaign.status !== 'SCHEDULED' || campaign.startDate > todayIn(workspaceTimezone(), now)) return { enrolled: 0, skipped: 0 };
  // Every cold campaign is a studio campaign (W14; the release moved the old ones onto the studio), so
  // the calendar launch is the only one it has: without a published calendar it refuses to start.
  if (campaign.plannerDraft || campaign.audience === 'SANDBOX') return activateCalendarCampaign(id, ctx);
  if (campaign.pod.archived || campaign.sequence.archived) throw new Error(campaign.pod.archived ? `Not started: ${campaign.pod.name} has been archived.` : `Not started: its sequence, ${campaign.sequence.name}, has been archived.`);
  let ids = campaign.personIds;
  if (campaign.followupSourceId) {
    const eligible = await nonReplierCandidates(campaign.followupSourceId, campaign.followupWaitDays, now, campaign.followupSourceRun ?? undefined);
    const eligibleIds = new Set(eligible.map(e => e.personId));
    ids = ids.filter(personId => eligibleIds.has(personId));
  }
  // The window decides the pace: each FO starts the planner's rate per day, and nobody starts after
  // the last day from which the plan still finishes by the end date.
  const window = campaign.endDate ? await planCampaignCapacity({ sequenceId: campaign.sequenceId, podId: campaign.podId, startDate: campaign.startDate, endDate: campaign.endDate, maxRate: campaign.startsPerFoPerDay, excludeCampaignId: id }) : null;
  const plan = window && !('error' in window) ? window : null;
  if (plan?.tooShort) {
    await launchFailed(campaign, `The sequence spans ${plan.durationDays} days; the campaign ends ${campaign.endDate}`, ctx.actor);
    return { enrolled: 0, skipped: campaign.personIds.length };
  }
  const preview = await previewEnrollment({ personIds: ids, sequenceId: campaign.sequenceId, podId: campaign.podId, campaignId: id, startDate: campaign.startDate, assignment: { mode: campaign.assignmentMode === 'ROUND_ROBIN' ? 'ROUND_ROBIN' : 'OWNER' }, dailyRampPerFo: campaign.startsPerFoPerDay, dailyRampByFo: plan ? Object.fromEntries(plan.perFo.map((f) => [f.id, f.rate])) : null, lastStartDate: plan?.lastStart ?? null, actor: ctx.actor });
  // Nobody fits before the last start day: the campaign stays scheduled and says so, rather than
  // completing with nobody in it.
  if (!preview.candidates.length && preview.conflicts.some((c) => c.reason === 'no_room')) {
    await launchFailed(campaign, `No room before ${plan?.lastStart ?? campaign.endDate}: the window fits ${plan?.total ?? 0} people`, ctx.actor);
    return { enrolled: 0, skipped: campaign.personIds.length };
  }
  const busyAtPreview = preview.conflicts.filter((c) => c.reason === 'already_active' || c.reason === 'scheduled_elsewhere').length;
  const created = await prisma.$transaction(async tx => {
    const candidatePeople = await tx.personCache.findMany({ where: { id: { in: preview.candidates.map(candidate => candidate.personId) } }, select: { companyId: true } });
    await lockAccounts(tx, candidatePeople.map(person => person.companyId));
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const current = await tx.campaign.findUniqueOrThrow({ where: { id }, include: { sequence: true, pod: true } });
    await tx.$queryRaw`SELECT id FROM "Pod" WHERE id = ${current.podId} FOR UPDATE`;
    if (current.status !== 'SCHEDULED' || current.runNumber !== campaign.runNumber) return [];
    const lockedPod = await tx.pod.findUniqueOrThrow({ where: { id: current.podId } });
    if (lockedPod.archived || current.sequence.archived) throw new Error(lockedPod.archived ? `Not started: ${lockedPod.name} has been archived.` : `Not started: its sequence, ${current.sequence.name}, has been archived.`);
    const personIds = preview.candidates.map(c => c.personId);
    const people = await tx.personCache.findMany({ where: { id: { in: personIds }, dnd: false, optedOut: false, deletedAt: null } });
    const busy = await tx.enrollment.findMany({ where: { personId: { in: personIds }, status: { in: ['ACTIVE','PAUSED'] } }, select: { personId: true } });
    const blocked = new Set(busy.map(e => e.personId));
    if (current.followupSourceId) {
      const replied = await tx.touch.findMany({ where: { personId: { in: personIds }, direction: 'INBOUND', occurredAt: { gte: campaign.createdAt } }, select: { personId: true } });
      for (const reply of replied) blocked.add(reply.personId);
    }
    if (current.runNumber > 1) {
      // A restart does not approach anyone an earlier run already won: they replied or booked.
      // P10: nor anyone an earlier run ended for good: not interested, bounced, wrong details, opted out.
      const won = await tx.enrollment.findMany({ where: { campaignId: id, personId: { in: personIds }, OR: [{ status: { in: ['REPLIED', 'MEETING'] } }, { status: 'EXITED', exitReason: { in: [...FINAL_EXITS] } }] }, select: { personId: true } });
      for (const w of won) blocked.add(w.personId);
    }
    const blockedAccounts = new Set((await tx.blockedAccount.findMany({ select: { companyId: true } })).map(account => account.companyId));
    for (const person of people) if (person.companyId && blockedAccounts.has(person.companyId)) blocked.add(person.id);
    const peopleById = new Map(people.map(p => [p.id,p]));
    const proposedFos = [...new Set(preview.candidates.map(c => c.foUserId))].sort();
    for (const userId of proposedFos) await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR SHARE`;
    const availableFos = await tx.user.findMany({ where: { id: { in: proposedFos }, active: true, pods: { some: { podId: current.podId } } }, select: { id: true } });
    const availableFoIds = new Set(availableFos.map(u => u.id));
    const candidates = preview.candidates.filter(c => peopleById.has(c.personId) && !blocked.has(c.personId) && availableFoIds.has(c.foUserId));
    // P19: nobody can start, and someone is only in another sequence for now: it stays scheduled and tries again.
    if (!candidates.length && (busyAtPreview || busy.length)) return null;
    await tx.enrollment.createMany({ data: candidates.map(c => ({ personId: c.personId, companyId: peopleById.get(c.personId)?.companyId, foUserId: c.foUserId, podId: campaign.podId, campaignId: id, campaignRun: current.runNumber, sequenceId: campaign.sequenceId, startDate: c.startDate, status: 'ACTIVE', createdById: ctx.actor.type === 'USER' ? ctx.actor.id : null, createdAt: now, audience: 'CRM' as const })), skipDuplicates: true });
    const enrollments = await tx.enrollment.findMany({ where: { campaignId: id, campaignRun: current.runNumber }, select: { id: true, personId: true } });
    await tx.campaign.update({ where: { id }, data: { status: enrollments.length ? 'ACTIVE' : 'COMPLETED' } });
    await logAudit({ entityType: 'campaign', entityId: id, action: 'started', actor: ctx.actor, details: { run: current.runNumber, enrolled: enrollments.length, skipped: campaign.personIds.length - enrollments.length } }, tx);
    for (const e of enrollments) await logAudit({ entityType: 'enrollment', entityId: e.id, action: 'enrolled', actor: ctx.actor, details: { campaignId: id, personId: e.personId, run: current.runNumber } }, tx);
    return enrollments;
  }, { timeout: 60000 });
  if (!created) {
    await launchFailed(campaign, 'Nobody on its list can start yet: everyone left is still in another sequence or campaign. It stays scheduled and starts once they are free.', ctx.actor);
    return { enrolled: 0, skipped: campaign.personIds.length };
  }
  for (const e of created) await advanceEnrollment(e.id, ctx);
  return { enrolled: created.length, skipped: campaign.personIds.length - created.length };
}

/** P10: how an earlier run ended someone for good; a restart of the same campaign leaves them out. */
export const FINAL_EXITS = ['not_interested', 'bounced', 'bad_data', 'opted_out'] as const;

/** P11: a scheduled campaign that cannot start is tried again after this long, or at once when it is edited. */
export const LAUNCH_RETRY_MS = 60 * 60_000;

/**
 * P11: a launch that failed is recorded for the campaign page, and the first failure since the
 * campaign was last changed rings its creator and its pod's leaders, so somebody fixes it.
 */
export async function launchFailed(campaign: { id: string; name: string; podId: string; createdById: string | null; updatedAt: Date }, error: string, actor: AuditActor) {
  const earlier = await prisma.auditLog.count({ where: { entityType: 'campaign', entityId: campaign.id, action: 'launch_failed', createdAt: { gte: campaign.updatedAt } } });
  await logAudit({ entityType: 'campaign', entityId: campaign.id, action: 'launch_failed', actor, details: { error } });
  if (!earlier) await notify([campaign.createdById, ...(await podLeaders([campaign.podId]))], { kind: 'campaign_launch_failed', payload: { campaignId: campaign.id, name: campaign.name, text: error } });
}

export async function launchScheduledCampaigns(ctx: EngineContext) {
  // P33: oldest first, and P11: one that failed waits an hour (or an edit) before it is tried again,
  // so failing campaigns neither write a row a minute nor crowd out the rest.
  const due = await prisma.campaign.findMany({ where: { status: 'SCHEDULED', startDate: { lte: todayIn(workspaceTimezone(), ctx.now) } }, select: { id: true, name: true, podId: true, createdById: true, updatedAt: true }, orderBy: [{ startDate: 'asc' }, { id: 'asc' }] });
  const failed = due.length ? await prisma.auditLog.groupBy({ by: ['entityId'], where: { entityType: 'campaign', action: 'launch_failed', entityId: { in: due.map((c) => c.id) } }, _max: { createdAt: true } }) : [];
  const lastFailed = new Map(failed.map((f) => [f.entityId, f._max.createdAt]));
  const ready = due.filter((c) => { const last = lastFailed.get(c.id); return !last || last < c.updatedAt || Date.now() - last.getTime() >= LAUNCH_RETRY_MS; }).slice(0, 100);
  for (const campaign of ready) {
    try { await activateCampaign(campaign.id, ctx); }
    catch (error) { await launchFailed(campaign, error instanceof Error ? error.message : 'Launch failed', ctx.actor); }
  }
}
