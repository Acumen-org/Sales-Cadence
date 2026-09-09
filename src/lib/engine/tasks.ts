import { Prisma, type CompletionSource, type Task, type TaskState } from '@prisma/client';
import { prisma, type Tx } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { addDays, isLocalDate, localDateToInstant, todayIn, toLocalDate, type LocalDate } from '../dates';
import { channelOf, parseSteps, type ActionType } from '../sequences/steps';
import { effectiveDailyCap, getSettings } from '../settings';
import { findDateWithCapacity, loadFromRows, type DayLoad } from './caps';
import { followingWorkingDay, nextWorkingDay, plannedDateForStep, shiftAfterStep, shouldGenerateNow } from './clock';
import { loadSyncTask, loadSyncTasks, syncTaskCompleted, syncTaskResolved, syncTaskRescheduled, syncTasksCreated } from './sync-out';
import { resolveNextStep } from './sequence-plan';
import { WORKSPACE_TIMEZONE } from '../workspace';

/** Who is acting, what time it is (tests), and whether to skip Twenty writes. */
export type EngineContext = {
  actor: AuditActor;
  now?: Date;
  skipSync?: boolean;
  /** Generate the next step now regardless of clock mode (used by "move to step"). */
  forceGenerate?: boolean;
  /** Outcome handlers apply reply/exit before a last step can complete the enrollment. */
  deferAdvance?: boolean;
};

export const RESOLVED_STATES: TaskState[] = ['DONE', 'SKIPPED', 'CANCELLED'];

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Actions already scheduled per day for an FO, from `from` for `days` days. */
export async function foLoad(tx: Tx | typeof prisma, foUserId: string, from: LocalDate, days = 180): Promise<DayLoad> {
  const to = addDays(from, days);
  const rows = await tx.task.findMany({
    where: {
      foUserId,
      state: { in: ['PENDING', 'DONE'] },
      OR: [{ dueDate: { gte: from, lte: to } }, { snoozedTo: { gte: from, lte: to } }],
    },
    select: { dueDate: true, snoozedTo: true },
  });
  return loadFromRows(rows);
}

function latestResolutionDate(tasks: Task[], timezone: string): LocalDate {
  let latest = 0;
  for (const t of tasks) {
    const at = (t.completedAt ?? t.updatedAt).getTime();
    if (at > latest) latest = at;
  }
  return toLocalDate(new Date(latest), timezone);
}

export type AdvanceResult =
  | { outcome: 'generated'; stepIndex: number; taskIds: string[]; dueDate: LocalDate }
  | { outcome: 'completed' }
  | { outcome: 'waiting' | 'inactive' | 'no_version' | 'raced'; reason?: string };

/**
 * Move an enrollment forward: when its current step is finished (or, in hold mode, when the
 * next step is due) generate the next step's tasks; when the last step finishes, complete it.
 * Safe to call repeatedly: the unique (enrollment, step, action) index makes double
 * generation impossible, and a lost race is reported as `raced`.
 */
export async function advanceEnrollment(enrollmentId: string, ctx: EngineContext): Promise<AdvanceResult> {
  const settings = await getSettings();
  const rules = settings.rules;
  const now = ctx.now ?? new Date();

  let result: AdvanceResult;
  try {
    result = await prisma.$transaction(async (tx) => {
      const identity = await tx.enrollment.findUnique({ where: { id: enrollmentId }, select: { sequenceId: true, campaignId: true } });
      if (!identity) return { outcome: 'inactive' as const };
      if (identity.campaignId) await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`campaign:${identity.campaignId}`}))`;
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${identity.sequenceId}))`;
      const e = await tx.enrollment.findUnique({
        where: { id: enrollmentId },
        include: { fo: true, campaign: true, sequence: true, tasks: true },
      });
      if (!e || e.status !== 'ACTIVE') return { outcome: 'inactive' as const };
      if (e.campaign && e.campaign.status !== 'ACTIVE') return { outcome: 'inactive' as const, reason: 'Campaign is not running' };
      const today = todayIn(WORKSPACE_TIMEZONE, now);
      const steps = parseSteps(e.sequence.steps);
      const currentTasks = e.tasks.filter((t) => t.stepIndex === e.currentStep);
      const stepDone = e.currentStep >= 0 && currentTasks.length > 0 && currentTasks.every((t) => t.state !== 'PENDING');

      let shiftDays = e.shiftDays;
      if (stepDone && rules.clockMode === 'shift') {
        shiftDays = shiftAfterStep(shiftDays, currentTasks[0].plannedDate, latestResolutionDate(currentTasks, WORKSPACE_TIMEZONE), 'shift');
      }

      const { nextIndex } = resolveNextStep({ currentStep: e.currentStep, currentStepId: e.currentStepId, steps });
      if (nextIndex >= steps.length) {
        if (!stepDone || e.tasks.some(t => t.state === 'PENDING')) return { outcome: 'waiting' as const, reason: 'Required actions are still in progress' };
        await tx.enrollment.update({ where: { id: e.id }, data: { status: 'COMPLETED', completedAt: now, shiftDays } });
        await logAudit({ entityType: 'enrollment', entityId: e.id, action: 'completed', actor: ctx.actor, details: { steps: steps.length } }, tx);
        return { outcome: 'completed' as const };
      }

      const step = steps[nextIndex];
      let planned = plannedDateForStep(e.startDate, step.day, shiftDays, rules.workingDays);
      if (ctx.forceGenerate) {
        // Moved ahead by hand: the step is due now, never retroactively overdue.
        if (planned < today) planned = nextWorkingDay(today, rules.workingDays);
      } else if (!shouldGenerateNow({ previousStepDone: stepDone, plannedDate: planned, today, mode: rules.clockMode, isFirstStep: e.currentStep < 0 })) {
        return { outcome: 'waiting' as const, reason: `next step planned for ${planned}` };
      }

      // Caps only apply to dates that are still ahead of us; overdue plans stay overdue and visible.
      let dueDate = planned;
      if (planned >= today) {
        const load = await foLoad(tx, e.foUserId, planned);
        dueDate = findDateWithCapacity(planned, step.actions.length, effectiveDailyCap(e.fo, rules), load, rules.workingDays);
      }
      const startDate = e.currentStep < 0 ? dueDate : e.startDate;
      const dueAt = localDateToInstant(dueDate, WORKSPACE_TIMEZONE, 9);

      const taskIds: string[] = [];
      for (let i = 0; i < step.actions.length; i++) {
        const a = step.actions[i];
        const t = await tx.task.create({
          data: {
            enrollmentId: e.id,
            foUserId: e.foUserId,
            stepIndex: nextIndex,
            stepId: step.id,
            stepDay: step.day,
            actionIndex: i,
            actionId: a.id,
            actionSnapshot: a,
            action: a.type,
            label: a.label,
            dueDate,
            dueAt,
            plannedDate: planned,
          },
        });
        taskIds.push(t.id);
      }
      await tx.enrollment.update({
        where: { id: e.id },
        data: { currentStep: nextIndex, currentStepId: step.id, shiftDays, startDate },
      });
      await logAudit(
        {
          entityType: 'enrollment',
          entityId: e.id,
          action: 'step_generated',
          actor: ctx.actor,
          details: { stepIndex: nextIndex, stepId: step.id, day: step.day, plannedDate: planned, dueDate, shiftDays, taskIds },
        },
        tx,
      );
      return { outcome: 'generated' as const, stepIndex: nextIndex, taskIds, dueDate };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { outcome: 'raced' };
    throw err;
  }

  if (result.outcome === 'generated' && !ctx.skipSync) {
    await syncTasksCreated(await loadSyncTasks(result.taskIds));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Task resolution
// ---------------------------------------------------------------------------

export type CompleteTaskInput = {
  taskId: string;
  source: CompletionSource;
  /** External evidence (note:<id>, message:<id>). Each piece of evidence completes at most one task. */
  evidenceId?: string | null;
  /** For either/or actions: which one was performed. Defaults to the primary action. */
  chosenAction?: ActionType | null;
  /** When the touch actually happened (observed completions). Defaults to now. */
  occurredAt?: Date | null;
  /** Free-text note from the FO (call notes, context). Stored on the task and sent to Twenty. */
  note?: string | null;
  /** Call outcome key (settings.rules.callDispositions). */
  disposition?: string | null;
};

export type ResolveResult =
  | { ok: true; task: Task; advance: AdvanceResult }
  | { ok: false; reason: 'not_found' | 'already_resolved' | 'evidence_used' | 'invalid' | 'paused'; detail?: string };

/**
 * A paused campaign has stopped, which has to mean its open touches stop too. They are held
 * rather than cancelled - the schedule is intact and resuming releases it - so nothing here may
 * resolve one. Evidence is checked before this, so observed activity is not consumed either and
 * the reconcile can still complete the touch once the campaign is resumed.
 */
const HELD = { ok: false as const, reason: 'paused' as const, detail: 'This campaign is paused. Resume it to work this touch.' };

export async function completeTask(input: CompleteTaskInput, ctx: EngineContext): Promise<ResolveResult> {
  const now = ctx.now ?? new Date();
  const tx_result = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: input.taskId }, include: { enrollment: true } });
    if (!task) return { ok: false as const, reason: 'not_found' as const };
    if (task.state !== 'PENDING') return { ok: false as const, reason: 'already_resolved' as const };
    if (input.evidenceId) {
      const used = await tx.task.findFirst({ where: { evidenceId: input.evidenceId }, select: { id: true } });
      if (used) return { ok: false as const, reason: 'evidence_used' as const, detail: used.id };
    }
    if (task.enrollment.status === 'PAUSED') return HELD;
    const chosen = input.chosenAction ?? task.action;
    if (chosen !== task.action) {
      return { ok: false as const, reason: 'invalid' as const, detail: `action ${chosen} is not part of this task` };
    }
    const completedAt = input.occurredAt ?? now;
    const claimed = await tx.task.updateMany({
      where: { id: task.id, state: 'PENDING' },
      data: {
        state: 'DONE',
        completedAt,
        completedById: ctx.actor.type === 'USER' ? ctx.actor.id ?? null : null,
        completionSource: input.source,
        evidenceId: input.evidenceId ?? null,
        chosenAction: chosen,
        snoozedTo: null,
        disposition: input.disposition ?? null,
        note: input.note?.trim() || null,
      },
    });
    if (claimed.count === 0) return { ok: false as const, reason: 'already_resolved' as const };
    const updated = await tx.task.findUniqueOrThrow({ where: { id: task.id } });
    if (input.source === 'MANUAL') {
      await tx.touch.upsert({
        where: { externalId: `task:${task.id}` },
        create: {
          personId: task.enrollment.personId,
          channel: channelOf(chosen),
          direction: 'OUTBOUND',
          occurredAt: completedAt,
          summary: `${task.label} (marked done manually)`,
          externalId: `task:${task.id}`,
          actorUserId: task.foUserId,
          actorLabel: ctx.actor.label ?? null,
        },
        update: {},
      });
    }
    await logAudit(
      {
        entityType: 'task',
        entityId: task.id,
        action: 'completed',
        actor: ctx.actor,
        details: { source: input.source, chosenAction: chosen, evidenceId: input.evidenceId ?? null, note: input.note ?? null, enrollmentId: task.enrollmentId },
      },
      tx,
    );
    return { ok: true as const, task: updated };
  });
  if (!tx_result.ok) return tx_result;

  const advance: AdvanceResult = ctx.deferAdvance ? { outcome: 'waiting', reason: 'applying outcome' } : await advanceEnrollment(tx_result.task.enrollmentId, ctx);
  if (!ctx.skipSync) {
    const full = await loadSyncTask(tx_result.task.id);
    if (full) await syncTaskCompleted(full);
  }
  return { ok: true, task: tx_result.task, advance };
}

export async function skipTask(input: { taskId: string; reason: string; note?: string | null }, ctx: EngineContext): Promise<ResolveResult> {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'invalid', detail: 'A skip reason is required.' };
  const res = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: input.taskId }, include: { enrollment: { select: { status: true } } } });
    if (!task) return { ok: false as const, reason: 'not_found' as const };
    if (task.state !== 'PENDING') return { ok: false as const, reason: 'already_resolved' as const };
    if (task.enrollment.status === 'PAUSED') return HELD;
    const claimed = await tx.task.updateMany({
      where: { id: task.id, state: 'PENDING' },
      data: { state: 'SKIPPED', skipReason: reason, note: input.note?.trim() || null, completedById: ctx.actor.type === 'USER' ? ctx.actor.id ?? null : null, snoozedTo: null },
    });
    if (claimed.count === 0) return { ok: false as const, reason: 'already_resolved' as const };
    const updated = await tx.task.findUniqueOrThrow({ where: { id: task.id } });
    await logAudit({ entityType: 'task', entityId: task.id, action: 'skipped', actor: ctx.actor, details: { reason, enrollmentId: task.enrollmentId } }, tx);
    return { ok: true as const, task: updated };
  });
  if (!res.ok) return res;
  const advance: AdvanceResult = ctx.deferAdvance ? { outcome: 'waiting', reason: 'applying outcome' } : await advanceEnrollment(res.task.enrollmentId, ctx);
  if (!ctx.skipSync) {
    const full = await loadSyncTask(res.task.id);
    if (full) await syncTaskResolved(full);
  }
  return { ok: true, task: res.task, advance };
}

/** The only snooze target a Junior FO may pick: the next working day after today. */
export function nextWorkingDaySnooze(today: LocalDate, workingDays: number[]): LocalDate {
  return followingWorkingDay(today, workingDays);
}

export async function snoozeTask(input: { taskId: string; toDate: LocalDate }, ctx: EngineContext): Promise<ResolveResult> {
  const settings = await getSettings();
  if (!isLocalDate(input.toDate)) return { ok: false, reason: 'invalid', detail: 'Invalid date.' };
  const res = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: input.taskId }, include: { fo: true, enrollment: { select: { status: true } } } });
    if (!task) return { ok: false as const, reason: 'not_found' as const };
    if (task.state !== 'PENDING') return { ok: false as const, reason: 'already_resolved' as const };
    if (task.enrollment.status === 'PAUSED') return HELD;
    const today = todayIn(task.fo.timezone, ctx.now ?? new Date());
    if (input.toDate <= today) return { ok: false as const, reason: 'invalid' as const, detail: 'Snooze to a future date.' };
    const toDate = nextWorkingDay(input.toDate, settings.rules.workingDays);
    const claimed = await tx.task.updateMany({ where: { id: task.id, state: 'PENDING' }, data: { snoozedTo: toDate, dueAt: localDateToInstant(toDate, task.fo.timezone, 9) } });
    if (claimed.count === 0) return { ok: false as const, reason: 'already_resolved' as const };
    const updated = await tx.task.findUniqueOrThrow({ where: { id: task.id } });
    await logAudit({ entityType: 'task', entityId: task.id, action: 'snoozed', actor: ctx.actor, details: { from: task.snoozedTo ?? task.dueDate, to: toDate } }, tx);
    return { ok: true as const, task: updated };
  });
  if (!res.ok) return res;
  if (!ctx.skipSync) {
    const full = await loadSyncTask(res.task.id);
    if (full) await syncTaskRescheduled(full);
  }
  return { ok: true, task: res.task, advance: { outcome: 'waiting', reason: 'snoozed' } };
}

/** Cancel every pending task of an enrollment (reply, meeting, exit). Returns the cancelled tasks. */
export async function cancelOpenTasks(tx: Tx, enrollmentId: string, reason: string, actor: AuditActor): Promise<Task[]> {
  const pending = await tx.task.findMany({ where: { enrollmentId, state: 'PENDING' } });
  if (!pending.length) return [];
  await tx.task.updateMany({ where: { id: { in: pending.map((t) => t.id) } }, data: { state: 'CANCELLED', cancelReason: reason, snoozedTo: null } });
  for (const t of pending) {
    await logAudit({ entityType: 'task', entityId: t.id, action: 'cancelled', actor, details: { reason, enrollmentId } }, tx);
  }
  return pending;
}

/** After a transaction cancelled tasks, tidy their Twenty mirrors. */
export async function syncCancelled(taskIds: string[], ctx: EngineContext) {
  if (ctx.skipSync || !taskIds.length) return;
  for (const t of await loadSyncTasks(taskIds)) await syncTaskResolved(t);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Worker tick: advance every active enrollment. In hold mode this generates steps that became
 * due; in shift mode it is a safety net for enrollments whose completion did not advance them.
 */
export async function runSchedulerTick(ctx: EngineContext): Promise<{ scanned: number; generated: number; completed: number; tasks: number }> {
  const stats = { scanned: 0, generated: 0, completed: 0, tasks: 0 };
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.enrollment.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 200,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!batch.length) break;
    for (const { id } of batch) {
      stats.scanned += 1;
      const r = await advanceEnrollment(id, ctx);
      if (r.outcome === 'generated') {
        stats.generated += 1;
        stats.tasks += r.taskIds.length;
      } else if (r.outcome === 'completed') stats.completed += 1;
    }
    cursor = batch[batch.length - 1].id;
  }
  await prisma.campaign.updateMany({ where: { status: 'ACTIVE', enrollments: { some: {}, none: { status: { in: ['ACTIVE','PAUSED'] } } } }, data: { status: 'COMPLETED' } });
  return stats;
}
