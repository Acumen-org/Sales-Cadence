import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR } from '../audit';
import { cachedPersonName } from '../person-cache';
import { getSettings } from '../settings';
import { firstNameOf } from '../names';
import { getTwentyClient, type TwentyClient } from '../twenty';
import { channelOf, type ActionType } from '../sequences/steps';

/**
 * Rule 7: Twenty sync out. Every completed action becomes an activity note on the person
 * (`[Cadence] Email 2 sent by Alisa`); open tasks are optionally mirrored as Twenty Tasks.
 * Cadence only edits records it created (ids stored on Task.twentyTaskId / twentyNoteId).
 * Failures never block the engine: the write is kept as a FAILED TwentyWrite (the outbox) that
 * the worker retries with backoff and Settings > Activity log shows with a Retry button.
 */

export type SyncTask = Prisma.TaskGetPayload<{
  include: { enrollment: { include: { person: true; sequence: true } }; fo: true };
}>;

export const syncTaskInclude = { enrollment: { include: { person: true, sequence: true } }, fo: true } as const;

export async function loadSyncTasks(ids: string[]): Promise<SyncTask[]> {
  if (!ids.length) return [];
  return prisma.task.findMany({ where: { id: { in: ids } }, include: syncTaskInclude });
}

export async function loadSyncTask(id: string): Promise<SyncTask | null> {
  return prisma.task.findUnique({ where: { id }, include: syncTaskInclude });
}

function verbFor(action: ActionType): string {
  const ch = channelOf(action);
  if (ch === 'EMAIL') return 'sent';
  if (ch === 'CALL') return 'made';
  return 'done';
}

export function completionNoteTitle(task: Pick<SyncTask, 'label' | 'chosenAction' | 'action'> & { fo: { name: string }; disposition?: string | null }, prefix: string, dispositionLabel?: string | null): string {
  const action = (task.chosenAction ?? task.action) as ActionType;
  const outcome = dispositionLabel ?? task.disposition;
  return `${prefix} ${task.label} ${verbFor(action)} by ${firstNameOf(task.fo.name)}${outcome ? ` - ${outcome}` : ''}`;
}

export function mirroredTaskTitle(task: SyncTask): string {
  return `Cadence: ${task.label} - ${cachedPersonName(task.enrollment.person)}`;
}

async function recordWrite(client: TwentyClient, operation: string, objectType: string, payload: unknown, twentyId: string | null, taskId: string | null) {
  if (client.kind === 'dry-run') return; // the dry-run wrapper records its own log
  await prisma.twentyWrite.create({ data: { operation, objectType, payload: payload as object, twentyId, taskId, dryRun: false } });
}

type FailedWrite = { objectType: string; payload: object; twentyId?: string | null };

/** First retry a minute later, doubling each time, never more than six hours apart. */
export function retryDelayMs(attempts: number): number {
  return Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 9));
}

async function reportFailure(task: SyncTask, operation: string, err: unknown, write?: FailedWrite) {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[sync-out] ${operation} failed for task ${task.id}: ${message}`);
  try {
    await logAudit({ entityType: 'task', entityId: task.id, action: 'sync_failed', actor: SYSTEM_ACTOR, details: { operation, message } });
    if (write) {
      await prisma.twentyWrite.create({
        data: { operation, objectType: write.objectType, payload: write.payload, twentyId: write.twentyId ?? null, taskId: task.id, dryRun: false, status: 'FAILED', error: message, attempts: 1, nextAttemptAt: new Date(Date.now() + retryDelayMs(1)) },
      });
    }
  } catch {
    /* ignore */
  }
}

/** Mirror freshly generated tasks as open Twenty Tasks. */
export async function syncTasksCreated(tasks: SyncTask[]): Promise<void> {
  if (!tasks.length) return;
  const settings = await getSettings();
  if (!settings.sync.mirrorOpenTasks) return;
  let client: TwentyClient | null = null;
  let clientError: unknown = null;
  try {
    client = await getTwentyClient();
  } catch (err) {
    clientError = err;
  }
  for (const task of tasks) {
    if (task.twentyTaskId || task.state !== 'PENDING') continue;
    const input = {
      title: mirroredTaskTitle(task),
      bodyMarkdown: `Sequence "${task.enrollment.sequence.name}", step ${task.stepIndex + 1} (day ${task.stepDay}).\nDue ${task.dueDate}. Managed by Cadence.`,
      dueAt: task.dueAt.toISOString(),
      assigneeMemberId: task.fo.twentyMemberId,
      personId: task.enrollment.personId,
      ...(settings.sync.writeCadenceTaskIdField ? { cadenceTaskId: task.id } : {}),
    };
    if (!client) {
      await reportFailure(task, 'createTask', clientError, { objectType: 'task', payload: input });
      continue;
    }
    try {
      const { id } = await client.createTask(input);
      await prisma.task.update({ where: { id: task.id }, data: { twentyTaskId: id } });
      await recordWrite(client, 'createTask', 'task', input, id, task.id);
    } catch (err) {
      await reportFailure(task, 'createTask', err, { objectType: 'task', payload: input });
    }
  }
}

/** Completion note + close the mirrored task. */
export async function syncTaskCompleted(task: SyncTask): Promise<void> {
  const settings = await getSettings();
  if (!settings.sync.writeCompletionNotes && !task.twentyTaskId) return;
  let client: TwentyClient | null = null;
  let clientError: unknown = null;
  try {
    client = await getTwentyClient();
  } catch (err) {
    clientError = err;
  }
  if (settings.sync.writeCompletionNotes && !task.twentyNoteId) {
    const action = (task.chosenAction ?? task.action) as ActionType;
    const dispositionLabel = settings.rules.callDispositions.find((d) => d.key === task.disposition)?.label ?? task.disposition ?? null;
    const input = {
      title: completionNoteTitle(task, settings.matching.cadencePrefix, dispositionLabel),
      bodyMarkdown: [
        `${task.label} (${action.toLowerCase().replace('_', ' ')}) completed by ${task.fo.name} in Cadence.`,
        `Sequence "${task.enrollment.sequence.name}", step ${task.stepIndex + 1} (day ${task.stepDay}).`,
        ...(dispositionLabel ? [`Outcome: ${dispositionLabel}.`] : []),
        ...(task.note ? ['', task.note] : []),
        `Source: ${task.completionSource ?? 'MANUAL'}${task.evidenceId ? ` (${task.evidenceId})` : ''}.`,
      ].join('\n'),
      personId: task.enrollment.personId,
      companyId: task.enrollment.companyId,
    };
    try {
      if (!client) throw clientError;
      const { id } = await client.createNote(input);
      await prisma.task.update({ where: { id: task.id }, data: { twentyNoteId: id } });
      await recordWrite(client, 'createNote', 'note', input, id, task.id);
    } catch (err) {
      await reportFailure(task, 'createNote', err, { objectType: 'note', payload: input });
    }
  }
  if (task.twentyTaskId) {
    const patch = { id: task.twentyTaskId, status: 'DONE' as const };
    try {
      if (!client) throw clientError;
      await client.updateTask(task.twentyTaskId, { status: 'DONE' });
      await recordWrite(client, 'updateTask', 'task', patch, task.twentyTaskId, task.id);
    } catch (err) {
      await reportFailure(task, 'updateTask', err, { objectType: 'task', payload: patch, twentyId: task.twentyTaskId });
    }
  }
}

/** Skipped or cancelled: remove (or close) the mirrored task. */
export async function syncTaskResolved(task: SyncTask): Promise<void> {
  if (!task.twentyTaskId) return;
  const settings = await getSettings();
  const remove = settings.sync.deleteMirroredTaskOnSkip;
  const payload = remove
    ? { id: task.twentyTaskId, reason: task.state }
    : { id: task.twentyTaskId, status: 'DONE' as const, title: `${mirroredTaskTitle(task)} (${task.state.toLowerCase()})` };
  const operation = remove ? 'deleteTask' : 'updateTask';
  try {
    const client = await getTwentyClient();
    if (remove) await client.deleteTask(task.twentyTaskId);
    else await client.updateTask(task.twentyTaskId, { status: 'DONE', title: (payload as { title: string }).title });
    await recordWrite(client, operation, 'task', payload, task.twentyTaskId, task.id);
    await prisma.task.update({ where: { id: task.id }, data: { twentyTaskId: null } });
  } catch (err) {
    await reportFailure(task, operation, err, { objectType: 'task', payload, twentyId: task.twentyTaskId });
  }
}

/** Due date or assignee changed (snooze, reassign, resume). */
export async function syncTaskRescheduled(task: SyncTask): Promise<void> {
  if (!task.twentyTaskId) return;
  const payload = { id: task.twentyTaskId, dueAt: task.dueAt.toISOString(), title: mirroredTaskTitle(task) };
  try {
    const client = await getTwentyClient();
    await client.updateTask(task.twentyTaskId, { dueAt: payload.dueAt, title: payload.title });
    await recordWrite(client, 'updateTask', 'task', payload, task.twentyTaskId, task.id);
  } catch (err) {
    await reportFailure(task, 'updateTask', err, { objectType: 'task', payload, twentyId: task.twentyTaskId });
  }
}
