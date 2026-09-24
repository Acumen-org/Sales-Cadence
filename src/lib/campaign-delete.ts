import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { canDeleteCampaign } from './auth/rbac';
import { getTwentyClient } from './twenty';

/** Explicit erasure, restricted to campaigns that cannot generate new work; see canDeleteCampaign for who. */
export async function deleteCampaignPermanently(id: string, name: string, user: SessionUser) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('campaign-planner-publication'))`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const c = await tx.campaign.findUniqueOrThrow({ where: { id }, include: { enrollments: { include: { tasks: true } } } });
    if (!canDeleteCampaign(user, { status: c.status, podId: c.podId, everLaunched: c.enrollments.length > 0 })) {
      if (user.role === 'ADMIN') throw new Error('Stop this campaign before permanently deleting it.');
      throw new Error(['DRAFT', 'PENDING_APPROVAL'].includes(c.status) && c.enrollments.length ? 'This campaign has run before, so only an admin can delete it.' : ['DRAFT', 'PENDING_APPROVAL'].includes(c.status) ? 'You cannot delete campaigns in this pod.' : 'Only an admin can delete a campaign that has been published.');
    }
    if (c.name !== name) throw new Error('Enter the exact campaign name to confirm deletion.');
    if (await tx.campaign.count({ where: { followupSourceId: id } })) throw new Error('Remove this campaign’s follow-up campaigns first.');
    const tasks = c.enrollments.flatMap(e => e.tasks);
    // Notes and real messages are CRM relationship history, not campaign records.
    // Refuse an ambiguous purge instead of deleting third-party conversation data.
    if (tasks.some(t => t.twentyNoteId)) throw new Error('This campaign has notes in Twenty. Remove them there first.');
    const mirrored = [...new Set(tasks.flatMap(t => t.twentyTaskId ? [t.twentyTaskId] : []))];
    if (mirrored.length) {
      const client = await getTwentyClient();
      if (client.kind === 'dry-run') throw new Error('This campaign cannot be deleted yet: its tasks are still in Twenty.');
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
