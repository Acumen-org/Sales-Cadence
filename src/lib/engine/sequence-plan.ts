import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { StepsSchema, type SequenceStep } from '../sequences/steps';
import { cleanRichText } from '../rich-text';

function validatedSteps(input: unknown) {
  return StepsSchema.parse(input).map((s) => ({
    ...s,
    actions: s.actions.map((a) => ({ ...a, ...(a.bodyHtml === undefined ? {} : { bodyHtml: cleanRichText(a.bodyHtml) }) })),
  }));
}

export async function createSequence(input: { name: string; description?: string | null; steps: unknown }, actor: AuditActor) {
  const steps = validatedSteps(input.steps);
  const sequence = await prisma.sequence.create({ data: { name: input.name.trim(), description: input.description ?? null, steps } });
  await logAudit({ entityType: 'sequence', entityId: sequence.id, action: 'created', actor, details: { steps: steps.length } });
  return { sequence };
}

export class StepInUseError extends Error {
  constructor(readonly stepId: string, readonly openTasks: number) {
    super(`${openTasks} open ${openTasks === 1 ? 'action is' : 'actions are'} on this step. Work or cancel them before changing or moving it.`);
    this.name = 'StepInUseError';
  }
}

/**
 * Save the plan in place. There is one plan per sequence and every campaign using it picks up
 * the change at the next step it generates.
 *
 * The one thing an edit may not do is move or rewrite a step that people are standing on: an FO
 * holding a task for that step would find the instructions changed under them, or the sequence
 * would skip or repeat a touch. Those steps are refused; everything else saves.
 */
export async function saveSequenceSteps(sequenceId: string, stepsInput: unknown, actor: AuditActor) {
  const steps = validatedSteps(stepsInput);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${sequenceId}))`;
    const sequence = await tx.sequence.findUniqueOrThrow({ where: { id: sequenceId } });
    const current = StepsSchema.safeParse(sequence.steps);
    const before = current.success ? current.data : [];
    const inUse = await tx.task.groupBy({ by: ['stepId'], where: { state: 'PENDING', enrollment: { sequenceId } }, _count: { _all: true } });
    for (const { stepId, _count } of inUse) {
      const beforeIndex = before.findIndex((s) => s.id === stepId);
      const afterIndex = steps.findIndex((s) => s.id === stepId);
      if (beforeIndex !== afterIndex || JSON.stringify(before[beforeIndex]) !== JSON.stringify(steps[afterIndex])) {
        throw new StepInUseError(stepId, _count._all);
      }
    }
    const updated = await tx.sequence.update({ where: { id: sequenceId }, data: { steps } });
    await logAudit({ entityType: 'sequence', entityId: sequenceId, action: 'plan_updated', actor, details: { steps: steps.length } }, tx);
    return updated;
  });
}

export async function updateSequenceMeta(
  sequenceId: string,
  patch: { name?: string; description?: string | null; archived?: boolean },
  actor: AuditActor,
) {
  const updated = await prisma.sequence.update({
    where: { id: sequenceId },
    data: {
      ...(patch.name ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    },
  });
  await logAudit({ entityType: 'sequence', entityId: sequenceId, action: 'updated', actor, details: patch });
  return updated;
}

/**
 * Which step an enrollment generates next.
 *
 * The step it last generated is found by its id, so inserting or removing a step elsewhere in
 * the plan moves nobody. Only if that id has gone (the step was deleted while the enrollment
 * stood past it) does this fall back to the stored index.
 */
export function resolveNextStep(params: { currentStep: number; currentStepId: string | null; steps: SequenceStep[] }): { nextIndex: number } {
  const { currentStep, currentStepId, steps } = params;
  if (currentStep < 0) return { nextIndex: 0 };
  const idx = currentStepId ? steps.findIndex((s) => s.id === currentStepId) : -1;
  return { nextIndex: idx >= 0 ? idx + 1 : currentStep + 1 };
}

/** Preview of the step after the current one, for the brief. Null when the sequence ends. */
export function previewNextStep(params: { currentStep: number; currentStepId: string | null; steps: SequenceStep[] }): SequenceStep | null {
  return params.steps[resolveNextStep(params).nextIndex] ?? null;
}
