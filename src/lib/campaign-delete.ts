import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { whyNotDeleteCampaign } from './auth/rbac';
import { getTwentyClient } from './twenty';

/** Explicit erasure, restricted to campaigns that cannot generate new work; see canDeleteCampaign for who, and whyNotDeleteCampaign for what a refusal says. */
export async function deleteCampaignPermanently(id: string, name: string, user: SessionUser) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('campaign-planner-publication'))`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const c = await tx.campaign.findUniqueOrThrow({ where: { id }, include: { pod: { select: { name: true } }, enrollments: { include: { tasks: true } } } });
    const refused = whyNotDeleteCampaign(user, { status: c.status, podId: c.podId, createdById: c.createdById, everLaunched: c.enrollments.length > 0 }, c.pod.name);
    if (refused) throw new Error(refused);
    if (c.name !== name) throw new Error(`The name you typed does not match. Type ${c.name} exactly to delete it.`);
    const followups = await tx.campaign.findMany({ where: { followupSourceId: id }, select: { name: true } });
    if (followups.length) throw new Error(`Delete its follow-up ${followups.length === 1 ? 'campaign' : 'campaigns'} first: ${followups.map(f => f.name).join(', ')}.`);
    const tasks = c.enrollments.flatMap(e => e.tasks);
    // Notes and real messages are CRM relationship history, not campaign records.
    // Refuse an ambiguous purge instead of deleting third-party conversation data.
    if (tasks.some(t => t.twentyNoteId)) throw new Error('This campaign wrote notes to Twenty, and deleting it would lose that history. Delete those notes in Twenty first.');
    const mirrored = [...new Set(tasks.flatMap(t => t.twentyTaskId ? [t.twentyTaskId] : []))];
    if (mirrored.length) {
      const client = await getTwentyClient();
      if (client.kind === 'dry-run') throw new Error('Not deleted: its tasks are still in Twenty, and Cadence cannot remove them while dry run is on.');
      for (let i = 0; i < mirrored.length; i += 8) await Promise.all(mirrored.slice(i, i + 8).map(async taskId => {
        if (await client.getTask(taskId)) await client.deleteTask(taskId);
      }));
    }
    const taskIds = tasks.map(t => t.id);
    const enrollmentIds = c.enrollments.map(e => e.id);
    const sequenceIds = [...new Set([c.sequenceId, ...c.enrollments.map(e => e.sequenceId), ...Object.values((c.plannerDraft as { sequenceIds?: Record<string, string> } | null)?.sequenceIds ?? {})])];
    await tx.twentyWrite.deleteMany({ where: { taskId: { in: taskIds } } });
    await tx.touch.deleteMany({ where: { externalId: { in: taskIds.map(id => `task:${id}`) } } });
    await tx.activityEvent.deleteMany({ where: { objectType: 'task', externalId: { in: mirrored } } });
    await tx.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [id, ...enrollmentIds, ...taskIds] } }, { details: { path: ['campaignId'], equals: id } }, { details: { path: ['sourceCampaignId'], equals: id } }] } });
    await tx.enrollment.deleteMany({ where: { campaignId: id } });
    await tx.campaign.delete({ where: { id } });
    // Only the campaign's own outreach goes with it; a library sequence stays even when nothing else uses it.
    const unused = await tx.sequence.findMany({ where: { id: { in: sequenceIds }, campaignOwned: true, campaigns: { none: {} }, enrollments: { none: {} } }, select: { id: true } });
    await tx.auditLog.deleteMany({ where: { entityType: 'sequence', entityId: { in: unused.map(s => s.id) } } });
    await tx.sequence.deleteMany({ where: { id: { in: unused.map(s => s.id) } } });
    return { enrollments: enrollmentIds.length, tasks: taskIds.length };
  }, { timeout: 120000 });
}
