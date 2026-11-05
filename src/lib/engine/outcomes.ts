import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { getSettings, type RulesSettings } from '../settings';
import { exitEnrollment, finishEnrollment, markReplied, setPersonFlags } from './enrollment';
import { optOutPerson, optOutSandboxContact, type RowSubject as SubjectRef } from '../sandbox/opt-out';
import { advanceEnrollment, cancelOpenTasks, completeTask, skipTask, syncCancelled, type EngineContext, type ResolveResult } from './tasks';
import { parseSteps } from '../sequences/steps';
import { ANSWERED_CALL_PREFIX } from '../reply-credit';
import { callOutcomes, OPT_OUT_OUTCOME } from '../call-outcomes';

/**
 * Outreach-style outcomes layered on the primitive task operations:
 *  - completing a call requires a disposition; an "answered" disposition is a reply
 *  - skip reasons can end the enrollment (bounced, not interested, opted out, bad data)
 *    and flag bad contact data on the person
 *  - move a person ahead to a later step, finish (replied / no reply)
 */

// The one outcome list lives in call-outcomes.ts (N055), apart from the engine, so the sync and the
// reports can read it too.
export { callOutcomes, EXTRA_CALL_OUTCOMES, OPT_OUT_OUTCOME } from '../call-outcomes';

export function dispositionFor(rules: RulesSettings, key: string | null | undefined) {
  return key ? callOutcomes(rules).find((d) => d.key === key) ?? null : null;
}

export function skipReasonFor(rules: RulesSettings, key: string | null | undefined) {
  return key ? rules.skipReasons.find((r) => r.key === key) ?? null : null;
}

export type CallOutcomeInput = {
  taskId: string;
  disposition: string;
  note?: string | null;
  chosenAction?: 'CALL' | 'EMAIL' | 'LINKEDIN_CONNECT' | 'LINKEDIN_MESSAGE' | null;
  /** The call's own touch (B043): the step takes it, so one answered call is one touch and one reply. */
  callTouchId?: string | null;
  /** False when the caller opts the person out itself (the post-call form, as a form opt-out). */
  optOut?: boolean;
};

/**
 * Complete a call task with a disposition. Answered dispositions finish the sequence as replied,
 * except "Asked not to be contacted": that opts the person out and ends the sequence as Opted out,
 * never Replied, and its touch is not an answered call (B091).
 */
export async function completeCall(input: CallOutcomeInput, ctx: EngineContext): Promise<ResolveResult & { replied?: boolean }> {
  const settings = await getSettings();
  const disposition = dispositionFor(settings.rules, input.disposition);
  if (!disposition) return { ok: false, reason: 'invalid', detail: 'Pick a call outcome.' };
  const task = await prisma.task.findUnique({ where: { id: input.taskId }, include: { enrollment: { select: { personId: true, sandboxContactId: true } } } });
  if (!task) return { ok: false, reason: 'not_found' };

  const stop = disposition.key === OPT_OUT_OUTCOME;
  const shouldReply = !stop && disposition.answered && settings.rules.answeredCallIsReply;
  const r = await completeTask({ taskId: input.taskId, source: 'MANUAL', disposition: disposition.key, note: input.note ?? null, chosenAction: input.chosenAction ?? 'CALL', touchId: input.callTouchId ?? null }, { ...ctx, deferAdvance: shouldReply || stop });
  if (!r.ok) return r;
  if (disposition.badPhone) await setSubjectFlags(task.enrollment, { badPhone: true }, ctx.actor);
  if (stop) {
    if (input.optOut !== false) await applyExitConsequence(task.enrollment, 'opted_out', ctx.actor);
    await exitEnrollment(r.task.enrollmentId, { reason: 'opted_out', actor: ctx.actor, now: ctx.now, skipSync: ctx.skipSync });
    return { ...r, replied: false };
  }
  let replied = false;
  if (shouldReply) {
    // The call's touch says the person answered, so every Replies figure counts it as one.
    const evidence = input.callTouchId ? { id: input.callTouchId } : { externalId: `task:${task.id}` };
    await prisma.touch.updateMany({ where: evidence, data: { summary: `${ANSWERED_CALL_PREFIX} ${disposition.label}` } });
    const res = await markReplied(r.task.enrollmentId, { at: ctx.now ?? new Date(), evidenceId: `task:${task.id}:answered`, actor: ctx.actor, skipSync: ctx.skipSync });
    replied = res.changed;
  }
  return { ...r, replied };
}

/**
 * Flags on whoever a task is about. A person keeps Cadence's own flags (Twenty is never written);
 * a sandbox contact keeps them on its row. Opting out goes through the one opt-out path, so a
 * contact pushed from Bellwether reads as opted out there too.
 */
export async function setSubjectFlags(subject: SubjectRef, flags: { optedOut?: boolean; badEmail?: boolean; badPhone?: boolean }, actor: AuditActor): Promise<void> {
  const { optedOut, ...rest } = flags;
  if (subject.personId) {
    if (optedOut) await optOutPerson(subject.personId, { source: 'skip_reason', actor, endSequences: false });
    await setPersonFlags(subject.personId, rest, actor);
    return;
  }
  if (!subject.sandboxContactId) return;
  if (optedOut) await optOutSandboxContact(subject.sandboxContactId, { source: 'skip_reason', actor });
  const data: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(rest)) if (typeof v === 'boolean') data[k] = v;
  if (!Object.keys(data).length) return;
  await prisma.sandboxContact.update({ where: { id: subject.sandboxContactId }, data });
  await logAudit({ entityType: 'sandbox_contact', entityId: subject.sandboxContactId, action: 'flags_updated', actor, details: data });
}

/**
 * The person-level consequence of ending a sequence.
 *
 * The reason belongs on the enrollment, but "asked not to be contacted" has to outlive it: without
 * the flag on the person, the next campaign's conflict preview sees nothing wrong and re-enrols
 * somebody who told us to stop. The skip path already does this; ending a sequence from the task
 * or the person has to do the same.
 */
export async function applyExitConsequence(subject: string | SubjectRef, reason: string, actor: AuditActor): Promise<void> {
  if (reason === 'opted_out') await setSubjectFlags(typeof subject === 'string' ? { personId: subject } : subject, { optedOut: true }, actor);
}

export type SkipOutcomeInput = { taskId: string; reasonKey: string; note?: string | null };

type SkipReason = NonNullable<ReturnType<typeof skipReasonFor>>;
/** Whether a reason ends the enrollment: "Email bounced" only while "exit on bounce" is on. */
const endsEnrollment = (reason: SkipReason, rules: RulesSettings) => reason.exit !== 'none' && (reason.exit !== 'bounced' || rules.exitOnBounce);

/** What a reason does beyond the skipped step: flags on the subject, and the end of the enrollment when it ends it. */
async function applySkipReason(enrollment: { id: string; personId: string | null; sandboxContactId: string | null; status: string }, reason: SkipReason, rules: RulesSettings, ctx: EngineContext): Promise<string | null> {
  if (reason.badEmail || reason.badPhone) {
    await setSubjectFlags(enrollment, { badEmail: reason.badEmail || undefined, badPhone: reason.badPhone || undefined }, ctx.actor);
  }
  if (!endsEnrollment(reason, rules)) return null;
  if (reason.exit === 'opted_out') await setSubjectFlags(enrollment, { optedOut: true }, ctx.actor);
  if (enrollment.status !== 'ACTIVE' && enrollment.status !== 'PAUSED') return null;
  await exitEnrollment(enrollment.id, { reason: reason.exit, actor: ctx.actor, now: ctx.now, skipSync: ctx.skipSync });
  return reason.exit;
}

/** Skip with a configured reason; some reasons end the enrollment and flag the person. */
export async function skipWithReason(input: SkipOutcomeInput, ctx: EngineContext): Promise<ResolveResult & { exited?: string | null }> {
  const settings = await getSettings();
  const reason = skipReasonFor(settings.rules, input.reasonKey);
  const label = reason?.label ?? input.reasonKey;
  const shouldExit = Boolean(reason && endsEnrollment(reason, settings.rules));
  const r = await skipTask({ taskId: input.taskId, reason: label, note: input.note ?? null }, { ...ctx, deferAdvance: shouldExit });
  if (!r.ok) return r;
  const task = await prisma.task.findUnique({ where: { id: input.taskId }, include: { enrollment: { select: { id: true, personId: true, sandboxContactId: true, status: true } } } });
  if (!task || !reason) return r;
  const exited = await applySkipReason(task.enrollment, reason, settings.rules, ctx);
  return { ...r, exited };
}

/**
 * A bounce Cadence saw in a mailbox, or one a rep confirmed by hand, follows the same rule as the
 * "Email bounced" skip (N060): every email step still open is skipped with that reason, the address
 * is flagged, and the running campaign ends when "exit on bounce" is on. With no campaign running,
 * the address is flagged all the same.
 */
export async function bounceDetected(subject: { personId?: string | null; sandboxContactId?: string | null }, ctx: EngineContext): Promise<{ skipped: number; exited: string | null }> {
  const settings = await getSettings();
  const reason: SkipReason = skipReasonFor(settings.rules, 'bounced') ?? { key: 'bounced', label: 'Email bounced', exit: 'bounced', badEmail: true, badPhone: false };
  const who = subject.personId ? { personId: subject.personId } : subject.sandboxContactId ? { sandboxContactId: subject.sandboxContactId, personId: null } : null;
  if (!who) return { skipped: 0, exited: null };
  const ends = endsEnrollment(reason, settings.rules);
  const running = await prisma.enrollment.findMany({ where: { ...who, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true, personId: true, sandboxContactId: true, status: true } });
  let skipped = 0;
  for (const e of running) {
    const open = await prisma.task.findMany({ where: { enrollmentId: e.id, state: 'PENDING', action: 'EMAIL' }, orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }], select: { id: true } });
    for (const t of open) if ((await skipTask({ taskId: t.id, reason: reason.label }, { ...ctx, deferAdvance: ends })).ok) skipped++;
  }
  if (!running.length) {
    if (reason.badEmail) await setSubjectFlags(who, { badEmail: true }, ctx.actor);
    return { skipped, exited: null };
  }
  let exited: string | null = null;
  for (const e of running) exited = (await applySkipReason(e, reason, settings.rules, ctx)) ?? exited;
  return { skipped, exited };
}

/**
 * Outreach "Move to step": jump ahead to `targetIndex` (in the plan). Pending tasks of
 * the current step are cancelled, the target step is generated now.
 */
export async function moveToStep(enrollmentId: string, targetIndex: number, ctx: EngineContext): Promise<{ ok: true; generated: string[] } | { ok: false; error: string }> {
  // A paused campaign generates nothing, so a move would cancel the open touches and replace them
  // with nothing at all - and report success while doing it.
  const current = await prisma.enrollment.findUnique({ where: { id: enrollmentId }, select: { status: true } });
  if (current?.status === 'PAUSED') return { ok: false as const, error: 'This campaign is paused. Resume it before moving anyone to another step.' };
  const e = await prisma.enrollment.findUnique({ where: { id: enrollmentId }, include: { sequence: true } });
  if (!e) return { ok: false, error: 'Enrollment not found.' };
  if (e.scheduleDates.length) return { ok: false, error: 'This person follows the published campaign calendar. Steps cannot be skipped ahead independently.' };
  if (e.status !== 'ACTIVE') return { ok: false, error: 'Only a live enrollment can be moved to another step.' };
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
  if (result.outcome !== 'generated') {
    // The open tasks are gone and nothing replaced them - usually the campaign was paused in the
    // same moment. Say so rather than report a move that did not happen.
    return { ok: false, error: 'The open touches were closed but the new step could not be started (the campaign may have just been paused). Resume the campaign to continue.' };
  }
  return { ok: true, generated: result.taskIds };
}

export { finishEnrollment };
