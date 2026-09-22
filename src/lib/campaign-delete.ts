import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { getTwentyClient } from './twenty';

/** Explicit admin erasure, restricted to campaigns that cannot generate new work. */
export async function deleteCampaignPermanently(id: string, name: string, user: SessionUser) {
  if (user.role !== 'ADMIN') throw new Error('Only an admin can permanently delete a campaign.');
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('campaign-planner-publication'))`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${id}`}))`;
    const c = await tx.campaign.findUniqueOrThrow({ where: { id }, include: { enrollments: { include: { tasks: true } } } });
    if (c.name !== name) throw new Error('Enter the exact campaign name to confirm deletion.');
    if (!['STOPPED', 'COMPLETED', 'DRAFT'].includes(c.status)) throw new Error('Stop this campaign before permanently deleting it.');
    if (await tx.campaign.count({ where: { followupSourceId: id } })) throw new Error('Remove this campaign’s follow-up campaigns first.');
    const tasks = c.enrollments.flatMap(e => e.tasks);
    // Notes and real messages are CRM relationship history, not campaign records.
    // Refuse an ambiguous purge instead of deleting third-party conversation data.
    if (tasks.some(t => t.twentyNoteId)) throw new Error('This campaign has completion notes in Twenty. Remove those campaign-generated CRM notes before erasing its history.');
    const mirrored = [...new Set(tasks.flatMap(t => t.twentyTaskId ? [t.twentyTaskId] : []))];
    if (mirrored.length) {
      const client = await getTwentyClient();
      if (client.kind === 'dry-run') throw new Error('CRM writes must be enabled to remove this campaign’s mirrored tasks.');
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
    const unused = await tx.sequence.findMany({ where: { id: { in: sequenceIds }, campaigns: { none: {} }, enrollments: { none: {} } }, select: { id: true } });
    await tx.auditLog.deleteMany({ where: { entityType: 'sequence', entityId: { in: unused.map(s => s.id) } } });
    await tx.sequence.deleteMany({ where: { id: { in: unused.map(s => s.id) } } });
    return { enrollments: enrollmentIds.length, tasks: taskIds.length };
  }, { timeout: 120000 });
}
