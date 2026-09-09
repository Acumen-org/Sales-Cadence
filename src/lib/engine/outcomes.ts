import { prisma } from '../db';
import { logAudit } from '../audit';
import { getSettings, type RulesSettings } from '../settings';
import { exitEnrollment, finishEnrollment, markReplied, setPersonFlags } from './enrollment';
import { advanceEnrollment, cancelOpenTasks, completeTask, skipTask, syncCancelled, type EngineContext, type ResolveResult } from './tasks';
import { parseSteps } from '../sequences/steps';

/**
 * Outreach-style outcomes layered on the primitive task operations:
 *  - completing a call requires a disposition; an "answered" disposition is a reply
 *  - skip reasons can end the enrollment (bounced, not interested, opted out, bad data)
 *    and flag bad contact data on the person
 *  - move a person ahead to a later step, finish (replied / no reply)
 */

export function dispositionFor(rules: RulesSettings, key: string | null | undefined) {
  return key ? rules.callDispositions.find((d) => d.key === key) ?? null : null;
}

export function skipReasonFor(rules: RulesSettings, key: string | null | undefined) {
  return key ? rules.skipReasons.find((r) => r.key === key) ?? null : null;
}

export type CallOutcomeInput = { taskId: string; disposition: string; note?: string | null; chosenAction?: 'CALL' | 'EMAIL' | 'LINKEDIN_CONNECT' | 'LINKEDIN_MESSAGE' | null };

/** Complete a call task with a disposition. Answered dispositions finish the sequence as replied. */
export async function completeCall(input: CallOutcomeInput, ctx: EngineContext): Promise<ResolveResult & { replied?: boolean }> {
  const settings = await getSettings();
  const disposition = dispositionFor(settings.rules, input.disposition);
  if (!disposition) return { ok: false, reason: 'invalid', detail: 'Pick a call outcome.' };
  const task = await prisma.task.findUnique({ where: { id: input.taskId }, include: { enrollment: { select: { personId: true } } } });
  if (!task) return { ok: false, reason: 'not_found' };

  const shouldReply = disposition.answered && settings.rules.answeredCallIsReply;
  const r = await completeTask({ taskId: input.taskId, source: 'MANUAL', disposition: disposition.key, note: input.note ?? null, chosenAction: input.chosenAction ?? 'CALL' }, { ...ctx, deferAdvance: shouldReply });
  if (!r.ok) return r;
  if (disposition.badPhone) await setPersonFlags(task.enrollment.personId, { badPhone: true }, ctx.actor);
  let replied = false;
  if (shouldReply) {
    const res = await markReplied(r.task.enrollmentId, { at: ctx.now ?? new Date(), evidenceId: `task:${task.id}:answered`, actor: ctx.actor, skipSync: ctx.skipSync });
    replied = res.changed;
  }
  return { ...r, replied };
}

export type SkipOutcomeInput = { taskId: string; reasonKey: string; note?: string | null };

/** Skip with a configured reason; some reasons end the enrollment and flag the person. */
export async function skipWithReason(input: SkipOutcomeInput, ctx: EngineContext): Promise<ResolveResult & { exited?: string | null }> {
  const settings = await getSettings();
  const reason = skipReasonFor(settings.rules, input.reasonKey);
  const label = reason?.label ?? input.reasonKey;
  const shouldExit = Boolean(reason && reason.exit !== 'none' && (reason.exit !== 'bounced' || settings.rules.exitOnBounce));
  const r = await skipTask({ taskId: input.taskId, reason: label, note: input.note ?? null }, { ...ctx, deferAdvance: shouldExit });
  if (!r.ok) return r;
  const task = await prisma.task.findUnique({ where: { id: input.taskId }, include: { enrollment: { select: { id: true, personId: true, status: true } } } });
  if (!task || !reason) return r;

  if (reason.badEmail || reason.badPhone) {
    await setPersonFlags(task.enrollment.personId, { badEmail: reason.badEmail || undefined, badPhone: reason.badPhone || undefined }, ctx.actor);
  }
  let exited: string | null = null;
  if (reason.exit !== 'none' && (reason.exit !== 'bounced' || settings.rules.exitOnBounce)) {
    if (reason.exit === 'opted_out') await setPersonFlags(task.enrollment.personId, { optedOut: true }, ctx.actor);
    if (task.enrollment.status === 'ACTIVE' || task.enrollment.status === 'PAUSED') {
      await exitEnrollment(task.enrollment.id, { reason: reason.exit, actor: ctx.actor, now: ctx.now, skipSync: ctx.skipSync });
      exited = reason.exit;
    }
  }
  return { ...r, exited };
}

/**
 * Outreach "Move to step": jump ahead to `targetIndex` (in the active version). Pending tasks of
 * the current step are cancelled, the target step is generated now.
 */
export async function moveToStep(enrollmentId: string, targetIndex: number, ctx: EngineContext): Promise<{ ok: true; generated: string[] } | { ok: false; error: string }> {
  const e = await prisma.enrollment.findUnique({ where: { id: enrollmentId }, include: { sequence: true } });
  if (!e) return { ok: false, error: 'Enrollment not found.' };
  if (e.status !== 'ACTIVE' && e.status !== 'PAUSED') return { ok: false, error: 'Only active or paused enrollments can be moved.' };
  const steps = parseSteps(e.sequence.steps);
  if (targetIndex < 0 || targetIndex >= steps.length) return { ok: false, error: 'That step does not exist.' };
  if (targetIndex <= e.currentStep) return { ok: false, error: 'You can only move forward to a later step.' };

  const cancelled = await prisma.$transaction(async (tx) => {
    const c = await cancelOpenTasks(tx, enrollmentId, `moved_to_step:${targetIndex + 1}`, ctx.actor);
    // Park the enrollment just before the target so advanceEnrollment generates exactly that step.
    await tx.enrollment.update({ where: { id: enrollmentId }, data: { currentStep: targetIndex - 1, currentStepId: steps[targetIndex - 1]?.id ?? null, status: 'ACTIVE', pausedAt: null, pauseReason: null } });
    await logAudit({ entityType: 'enrollment', entityId: enrollmentId, action: 'moved_to_step', actor: ctx.actor, details: { from: e.currentStep, to: targetIndex, cancelledTasks: c.length } }, tx);
    return c;
  });
  await syncCancelled(cancelled.map((t) => t.id), ctx);
  // The parked step index has no tasks, so advance treats it as "previous step done" only via the
  // first-step rule; force generation by temporarily using hold semantics: generate now.
  const result = await advanceEnrollment(enrollmentId, { ...ctx, forceGenerate: true });
  return { ok: true, generated: result.outcome === 'generated' ? result.taskIds : [] };
}

export { finishEnrollment };
