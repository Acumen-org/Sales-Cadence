'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canActOnTask, canSnoozeFreely } from '../auth/rbac';
import { userActor } from '../audit';
import { isLocalDate, todayIn } from '../dates';
import { completeTask, nextWorkingDaySnooze, skipTask, snoozeTask } from '../engine/tasks';
import { ACTION_TYPES } from '../sequences/steps';
import { getSettings } from '../settings';
import type { ActionResult } from './users';

async function loadForUser(taskId: string) {
  const user = await requireUser();
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { enrollment: { select: { podId: true } } } });
  if (!task) return { user, task: null, error: 'Task not found.' };
  if (!canActOnTask(toActor(user), { foUserId: task.foUserId, podId: task.enrollment.podId })) {
    return { user, task: null, error: 'You cannot act on this task.' };
  }
  return { user, task, error: null };
}

const CompleteSchema = z.object({
  taskId: z.string().min(1),
  chosenAction: z.enum(ACTION_TYPES).optional(),
  note: z.string().max(2000).optional(),
});

export async function completeTaskAction(formData: FormData): Promise<ActionResult> {
  const parsed = CompleteSchema.safeParse({
    taskId: formData.get('taskId'),
    chosenAction: formData.get('chosenAction') || undefined,
    note: formData.get('note') || undefined,
  });
  if (!parsed.success) return { ok: false, error: 'Invalid request.' };
  const { user, task, error } = await loadForUser(parsed.data.taskId);
  if (!task) return { ok: false, error: error ?? 'Task not found.' };
  const r = await completeTask(
    { taskId: task.id, source: 'MANUAL', chosenAction: parsed.data.chosenAction ?? null, note: parsed.data.note ?? null },
    { actor: userActor(user) },
  );
  revalidatePath('/tasks');
  if (!r.ok) return { ok: false, error: describeFailure(r.reason, r.detail) };
  return { ok: true, message: r.advance.outcome === 'completed' ? 'Done. Sequence finished for this person.' : 'Done.' };
}

const SkipSchema = z.object({ taskId: z.string().min(1), reason: z.string().trim().min(1, 'A reason is required.').max(500) });

export async function skipTaskAction(formData: FormData): Promise<ActionResult> {
  const parsed = SkipSchema.safeParse({ taskId: formData.get('taskId'), reason: formData.get('reason') });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  const { user, task, error } = await loadForUser(parsed.data.taskId);
  if (!task) return { ok: false, error: error ?? 'Task not found.' };
  const r = await skipTask({ taskId: task.id, reason: parsed.data.reason }, { actor: userActor(user) });
  revalidatePath('/tasks');
  if (!r.ok) return { ok: false, error: describeFailure(r.reason, r.detail) };
  return { ok: true, message: 'Skipped.' };
}

const SnoozeSchema = z.object({ taskId: z.string().min(1), toDate: z.string().trim() });

export async function snoozeTaskAction(formData: FormData): Promise<ActionResult> {
  const parsed = SnoozeSchema.safeParse({ taskId: formData.get('taskId'), toDate: formData.get('toDate') ?? 'next' });
  if (!parsed.success) return { ok: false, error: 'Invalid request.' };
  const { user, task, error } = await loadForUser(parsed.data.taskId);
  if (!task) return { ok: false, error: error ?? 'Task not found.' };
  const settings = await getSettings();
  const today = todayIn(user.timezone);
  const nextDay = nextWorkingDaySnooze(today, settings.rules.workingDays);
  let toDate = parsed.data.toDate === 'next' ? nextDay : parsed.data.toDate;
  if (!isLocalDate(toDate)) return { ok: false, error: 'Pick a valid date.' };
  if (!canSnoozeFreely(toActor(user)) && toDate !== nextDay) {
    // Junior FOs: next working day only.
    toDate = nextDay;
  }
  const r = await snoozeTask({ taskId: task.id, toDate }, { actor: userActor(user) });
  revalidatePath('/tasks');
  if (!r.ok) return { ok: false, error: describeFailure(r.reason, r.detail) };
  return { ok: true, message: `Snoozed to ${toDate}.` };
}

function describeFailure(reason: string, detail?: string): string {
  switch (reason) {
    case 'not_found':
      return 'Task not found.';
    case 'already_resolved':
      return 'This task was already completed or skipped (possibly by an observed email or call).';
    case 'evidence_used':
      return 'That evidence already completed another task.';
    default:
      return detail ?? 'Could not update the task.';
  }
}
