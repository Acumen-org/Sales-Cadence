import type { Prisma } from '@prisma/client';
import { subjectOf } from '../subject';
import { personalizeAction } from './personalize';
import { parseSteps } from './steps';

/**
 * L12: steps handed to another rep (reassign, a cold contact's transfer, delegate) carry the copy filled
 * in for the rep they were made for. Their copy is filled in again for the rep they now belong to, and
 * the first rep's saved draft goes, so nothing is sent signed with someone else's name.
 */
export async function refillDraftsFor(tx: Prisma.TransactionClient, taskIds: string[]): Promise<number> {
  if (!taskIds.length) return 0;
  const tasks = await tx.task.findMany({
    where: { id: { in: taskIds }, state: 'PENDING' },
    select: { id: true, stepId: true, actionId: true, actionSnapshot: true, fo: { select: { name: true } }, enrollment: { select: { sequence: { select: { steps: true } }, person: true, sandboxContact: true } } },
  });
  let refilled = 0;
  for (const t of tasks) {
    if (!t.actionSnapshot) continue;
    const action = parseSteps(t.enrollment.sequence.steps).find((s) => s.id === t.stepId)?.actions.find((a) => a.id === t.actionId);
    if (!action) continue;
    const snapshot = personalizeAction(action, { person: subjectOf(t.enrollment), fo: { name: t.fo.name } });
    await tx.task.update({ where: { id: t.id }, data: { actionSnapshot: snapshot as Prisma.InputJsonValue, draftSubject: null, draftHtml: null } });
    refilled++;
  }
  return refilled;
}
