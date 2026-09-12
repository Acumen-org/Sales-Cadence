import { prisma } from '../db';
import { logAudit, userActor } from '../audit';
import { canManageEnrollment, needsPod } from '../auth/rbac';
import type { SessionUser } from '../auth/current-user';
import { loadSyncTasks, syncTaskInclude, syncTaskResolved, syncTasksCreated, type SyncTask } from './sync-out';

/**
 * Hand one touchpoint (every open module of it) to a pod-mate. The enrollment keeps its FO -
 * the next step still goes to them - so this is "please do this one for me", not a transfer.
 * The mirrored Twenty task moves with it: the old one is closed, a new one is created for the
 * new owner.
 */
export async function delegateTasks(taskIds: string[], toUserId: string, actor: SessionUser): Promise<{ ok: true; count: number; toName: string } | { ok: false; error: string }> {
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (!ids.length) return { ok: false, error: 'Nothing to delegate.' };
  const tasks = await prisma.task.findMany({ where: { id: { in: ids } }, include: syncTaskInclude });
  if (tasks.length !== ids.length) return { ok: false, error: 'One of these touchpoints no longer exists.' };
  if (tasks.some((t) => t.state !== 'PENDING')) return { ok: false, error: 'Only open touchpoints can be delegated.' };
  if (tasks.some((t) => !canManageEnrollment(actor, { foUserId: t.foUserId, podId: t.enrollment.podId }))) return { ok: false, error: 'You can delegate work in your own pods only.' };
  const to = await prisma.user.findUnique({ where: { id: toUserId }, include: { pods: { select: { podId: true } } } });
  if (!to?.active || !needsPod(to.role)) return { ok: false, error: 'Choose an active sales team member.' };
  if (tasks.some((t) => t.enrollment.podId && !to.pods.some((p) => p.podId === t.enrollment.podId))) return { ok: false, error: `${to.name} is not in this pod.` };
  if (tasks.every((t) => t.foUserId === to.id)) return { ok: false, error: `${to.name} already has this touchpoint.` };

  const mirrored: SyncTask[] = tasks.filter((t) => t.twentyTaskId);
  class ChangedTask extends Error {}
  try {
    await prisma.$transaction(async (tx) => {
      // A completion or another delegation may have won since the list was opened. Roll back
      // the whole selection rather than claiming every module moved when only some did.
      for (const t of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
        const changed = await tx.task.updateMany({ where: { id: t.id, state: 'PENDING', foUserId: t.foUserId, twentyTaskId: t.twentyTaskId }, data: { foUserId: to.id, twentyTaskId: null } });
        if (changed.count !== 1) throw new ChangedTask();
        await logAudit({ entityType: 'task', entityId: t.id, action: 'delegated', actor: userActor(actor), details: { from: t.foUserId, to: to.id, toName: to.name, personId: t.enrollment.personId } }, tx);
      }
    });
  } catch (error) {
    if (error instanceof ChangedTask) return { ok: false, error: 'A selected task changed. Refresh the task list and try again.' };
    throw error;
  }
  for (const t of mirrored) await syncTaskResolved(t);
  await syncTasksCreated(await loadSyncTasks(ids));
  return { ok: true, count: ids.length, toName: to.name };
}
