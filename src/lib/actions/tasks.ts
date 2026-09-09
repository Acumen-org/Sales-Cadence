'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '../db';
import { requireUser, toActor, type SessionUser } from '../auth/current-user';
import { canActOnTask, canManageEnrollment, canSnoozeFreely } from '../auth/rbac';
import { userActor } from '../audit';
import { isLocalDate, todayIn } from '../dates';
import { exitEnrollment, finishEnrollment, reassignEnrollment } from '../engine/enrollment';
import { applyExitConsequence, completeCall, moveToStep, skipWithReason } from '../engine/outcomes';
import { completeTask, nextWorkingDaySnooze, skipTask, snoozeTask } from '../engine/tasks';
import { ACTION_TYPES } from '../sequences/steps';
import { getSettings } from '../settings';
import type { ActionResult } from './users';
import { cleanRichText } from '../rich-text';

export async function saveTaskDraftAction(input: { taskId: string; subject: string; html: string; revision: number }): Promise<{ ok: true; revision: number } | { ok: false; error: string }> {
  const parsed = z.object({ taskId: z.string().min(1), subject: z.string().max(2000), html: z.string().max(100000), revision: z.number().int().min(0) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Draft is too large or invalid.' };
  const { task, error } = await loadForUser(input.taskId);
  if (!task) return { ok: false, error: error ?? 'Task not found.' };
  const saved = await prisma.task.updateMany({ where: { id: task.id, state: 'PENDING', draftRevision: input.revision }, data: { draftSubject: input.subject, draftHtml: cleanRichText(input.html), draftRevision: { increment: 1 } } });
  if (!saved.count) return { ok: false, error: 'This draft changed in another window, or the task was completed. Copy your work before reloading.' };
  return { ok: true, revision: input.revision + 1 };
}

async function loadForUser(taskId: string, user?: SessionUser) {
  const u = user ?? (await requireUser());
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { enrollment: { select: { id: true, podId: true, personId: true } } } });
  if (!task) return { user: u, task: null, error: 'Task not found.' };
  if (!canActOnTask(toActor(u), { foUserId: task.foUserId, podId: task.enrollment.podId })) {
    return { user: u, task: null, error: 'You cannot act on this task.' };
  }
  return { user: u, task, error: null };
}

function revalidate() {
  revalidatePath('/tasks');
  revalidatePath('/home');
  revalidatePath('/people');
}

const CompleteSchema = z.object({
  taskId: z.string().min(1),
  chosenAction: z.enum(ACTION_TYPES).optional(),
  disposition: z.string().optional(),
  note: z.string().max(4000).optional(),
});

/** Done. Calls need a disposition (Outreach: a call is not complete without one). */
export async function completeTaskAction(formData: FormData): Promise<ActionResult> {
  const parsed = CompleteSchema.safeParse({
    taskId: formData.get('taskId'),
    chosenAction: formData.get('chosenAction') || undefined,
    disposition: formData.get('disposition') || undefined,
    note: formData.get('note') || undefined,
  });
  if (!parsed.success) return { ok: false, error: 'Invalid request.' };
  const { user, task, error } = await loadForUser(parsed.data.taskId);
  if (!task) return { ok: false, error: error ?? 'Task not found.' };
  const chosen = parsed.data.chosenAction ?? task.action;
  const ctx = { actor: userActor(user) };

  if (chosen === 'CALL') {
    if (!parsed.data.disposition) return { ok: false, error: 'Pick a call outcome first.' };
    const r = await completeCall({ taskId: task.id, disposition: parsed.data.disposition, note: parsed.data.note, chosenAction: 'CALL' }, ctx);
    revalidate();
    if (!r.ok) return { ok: false, error: describeFailure(r.reason, r.detail) };
    return { ok: true, message: r.replied ? 'Call logged. The person answered, so the sequence is finished as replied.' : r.advance.outcome === 'completed' ? 'Call logged. Sequence finished for this person.' : 'Call logged.' };
  }
  const r = await completeTask({ taskId: task.id, source: 'MANUAL', chosenAction: chosen, note: parsed.data.note ?? null }, ctx);
  revalidate();
  if (!r.ok) return { ok: false, error: describeFailure(r.reason, r.detail) };
  return { ok: true, message: r.advance.outcome === 'completed' ? 'Done. Sequence finished for this person.' : 'Done.' };
}

const SkipSchema = z.object({ taskId: z.string().min(1), reasonKey: z.string().trim().min(1), note: z.string().max(2000).optional() });

/** Skip with a configured reason; some reasons end the enrollment (bounce, not interested, opted out). */
export async function skipTaskAction(formData: FormData): Promise<ActionResult> {
  const parsed = SkipSchema.safeParse({ taskId: formData.get('taskId'), reasonKey: formData.get('reasonKey') ?? formData.get('reason'), note: formData.get('note') || undefined });
  if (!parsed.success) return { ok: false, error: 'Pick a skip reason.' };
  const { user, task, error } = await loadForUser(parsed.data.taskId);
  if (!task) return { ok: false, error: error ?? 'Task not found.' };
  const settings = await getSettings();
  const known = settings.rules.skipReasons.some((r) => r.key === parsed.data.reasonKey);
  const r = known
    ? await skipWithReason({ taskId: task.id, reasonKey: parsed.data.reasonKey, note: parsed.data.note }, { actor: userActor(user) })
    : await skipTask({ taskId: task.id, reason: parsed.data.reasonKey, note: parsed.data.note }, { actor: userActor(user) });
  revalidate();
  if (!r.ok) return { ok: false, error: describeFailure(r.reason, r.detail) };
  const exited = (r as { exited?: string | null }).exited ?? null;
  return { ok: true, message: exited ? `Skipped and removed from the sequence (${exited.replace(/_/g, ' ')}).` : 'Skipped.' };
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
  if (!canSnoozeFreely(toActor(user)) && toDate !== nextDay) toDate = nextDay;
  const r = await snoozeTask({ taskId: task.id, toDate }, { actor: userActor(user) });
  revalidate();
  if (!r.ok) return { ok: false, error: describeFailure(r.reason, r.detail) };
  return { ok: true, message: `Snoozed to ${toDate}.` };
}

// ---------------------------------------------------------------------------
// Ending a sequence early, and moving someone to a different step (enrollment-level)
// ---------------------------------------------------------------------------

/**
 * The enrollment behind a task, for the two kinds of change that are made from it.
 *
 * Recording what happened - they replied, they said no, they asked us to stop - is the job of
 * whoever worked the task, so the owner of the task may do it. Re-planning the sequence is not:
 * jumping to another step cancels touches somebody planned, so it needs `canManageEnrollment`.
 * Pass `manage` for that, and the check is here rather than in the component, because a hidden
 * control is not a permission.
 */
async function loadEnrollmentForTask(taskId: string, opts: { manage?: boolean } = {}) {
  const user = await requireUser();
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { enrollment: true } });
  if (!task) return { user, enrollment: null, error: 'Task not found.' };
  const actor = toActor(user);
  const managed = canManageEnrollment(actor, task.enrollment);
  const allowed = opts.manage ? managed : managed || task.foUserId === user.id;
  if (!allowed) return { user, enrollment: null, error: 'You cannot change this enrollment.' };
  return { user, enrollment: task.enrollment, error: null };
}

export async function finishFromTaskAction(formData: FormData): Promise<ActionResult> {
  const kind = String(formData.get('kind') ?? '');
  if (kind !== 'replied' && kind !== 'no_reply') return { ok: false, error: 'Invalid request.' };
  const { user, enrollment, error } = await loadEnrollmentForTask(String(formData.get('taskId') ?? ''));
  if (!enrollment) return { ok: false, error: error ?? 'Not found.' };
  await finishEnrollment(enrollment.id, kind, { actor: userActor(user) });
  revalidate();
  return { ok: true, message: kind === 'replied' ? 'Sequence ended: they replied.' : 'Sequence ended with no reply.' };
}

export async function removeFromSequenceAction(formData: FormData): Promise<ActionResult> {
  const { user, enrollment, error } = await loadEnrollmentForTask(String(formData.get('taskId') ?? ''));
  if (!enrollment) return { ok: false, error: error ?? 'Not found.' };
  const reason = String(formData.get('reason') ?? 'removed').trim() || 'removed';
  await exitEnrollment(enrollment.id, { reason, actor: userActor(user) });
  // "Asked not to be contacted" has to hold for every future campaign, not just this one.
  await applyExitConsequence(enrollment.personId, reason, userActor(user));
  revalidate();
  return { ok: true, message: reason === 'opted_out' ? 'Sequence ended and this person is opted out of all outreach.' : 'Sequence ended. No more tasks for this person.' };
}

export async function moveToStepAction(formData: FormData): Promise<ActionResult> {
  const target = Number.parseInt(String(formData.get('stepIndex') ?? ''), 10);
  if (!Number.isInteger(target)) return { ok: false, error: 'Pick a step.' };
  const { user, enrollment, error } = await loadEnrollmentForTask(String(formData.get('taskId') ?? ''), { manage: true });
  if (!enrollment) return { ok: false, error: error ?? 'Not found.' };
  const r = await moveToStep(enrollment.id, target, { actor: userActor(user) });
  revalidate();
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, message: `Moved to step ${target + 1}.` };
}

// ---------------------------------------------------------------------------
// Bulk actions on the task list
// ---------------------------------------------------------------------------

const BulkSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(1000),
  op: z.enum(['complete', 'skip', 'snooze', 'reassign']),
  reasonKey: z.string().optional(),
  toDate: z.string().optional(),
  foUserId: z.string().optional(),
  disposition: z.string().optional(),
});

export async function bulkTasksAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = BulkSchema.safeParse({
    taskIds: String(formData.get('taskIds') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    op: formData.get('op'),
    reasonKey: formData.get('reasonKey') || undefined,
    toDate: formData.get('toDate') || undefined,
    foUserId: formData.get('foUserId') || undefined,
    disposition: formData.get('disposition') || undefined,
  });
  if (!parsed.success) return { ok: false, error: 'Select at least one task.' };
  const d = parsed.data;
  const settings = await getSettings();
  const ctx = { actor: userActor(user) };
  let done = 0;
  const problems: string[] = [];
  const touchedEnrollments = new Set<string>();

  for (const taskId of d.taskIds) {
    const { task, error } = await loadForUser(taskId, user);
    if (!task) {
      problems.push(error ?? taskId);
      continue;
    }
    try {
      if (d.op === 'complete') {
        if (task.action === 'CALL') {
          if (!d.disposition) {
            problems.push(`${task.label}: calls need an outcome`);
            continue;
          }
          const r = await completeCall({ taskId, disposition: d.disposition, chosenAction: 'CALL' }, ctx);
          if (r.ok) done += 1;
          else problems.push(`${task.label}: ${r.reason}`);
        } else {
          const r = await completeTask({ taskId, source: 'MANUAL' }, ctx);
          if (r.ok) done += 1;
          else problems.push(`${task.label}: ${r.reason}`);
        }
      } else if (d.op === 'skip') {
        if (!d.reasonKey) return { ok: false, error: 'Pick a skip reason.' };
        const r = await skipWithReason({ taskId, reasonKey: d.reasonKey }, ctx);
        if (r.ok) done += 1;
        else problems.push(`${task.label}: ${r.reason}`);
      } else if (d.op === 'snooze') {
        const today = todayIn(user.timezone);
        const nextDay = nextWorkingDaySnooze(today, settings.rules.workingDays);
        let toDate = d.toDate && isLocalDate(d.toDate) ? d.toDate : nextDay;
        if (!canSnoozeFreely(toActor(user))) toDate = nextDay;
        const r = await snoozeTask({ taskId, toDate }, ctx);
        if (r.ok) done += 1;
        else problems.push(`${task.label}: ${r.reason}`);
      } else if (d.op === 'reassign') {
        if (!d.foUserId) return { ok: false, error: 'Pick an FO.' };
        if (touchedEnrollments.has(task.enrollment.id)) {
          done += 1;
          continue;
        }
        const e = await prisma.enrollment.findUniqueOrThrow({ where: { id: task.enrollment.id } });
        if (!canManageEnrollment(toActor(user), e)) {
          problems.push(`${task.label}: cannot reassign`);
          continue;
        }
        await reassignEnrollment(e.id, d.foUserId, ctx);
        touchedEnrollments.add(e.id);
        done += 1;
      }
    } catch (err) {
      problems.push(`${task.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  revalidate();
  const verb = { complete: 'completed', skip: 'skipped', snooze: 'snoozed', reassign: 'reassigned' }[d.op];
  if (!done) return { ok: false, error: problems.slice(0, 3).join('; ') || 'Nothing changed.' };
  return { ok: true, message: `${done} ${verb}${problems.length ? `; ${problems.length} skipped: ${problems.slice(0, 3).join('; ')}` : '.'}` };
}

function describeFailure(reason: string, detail?: string): string {
  switch (reason) {
    case 'not_found':
      return 'Task not found.';
    case 'already_resolved':
      return 'This task was already completed or skipped (possibly by an observed email or call).';
    case 'evidence_used':
      return 'That evidence already completed another task.';
    case 'paused':
      return detail ?? 'This campaign is paused. Resume it to work this touch.';
    default:
      return detail ?? 'Could not update the task.';
  }
}
