import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { StepsSchema, type SequenceStep } from '../sequences/steps';

/**
 * Sequences are versioned. Editing creates a new version and makes it active.
 * Enrollments keep using the version they were on for steps already generated;
 * the next step they generate comes from the active version (see resolveNextStep).
 */
export async function createSequence(input: { name: string; description?: string | null; steps: unknown }, actor: AuditActor) {
  const steps = StepsSchema.parse(input.steps);
  return prisma.$transaction(async (tx) => {
    const sequence = await tx.sequence.create({ data: { name: input.name.trim(), description: input.description ?? null } });
    const version = await tx.sequenceVersion.create({
      data: { sequenceId: sequence.id, version: 1, steps, createdById: actor.type === 'USER' ? actor.id : null, changeNote: 'Created' },
    });
    const updated = await tx.sequence.update({ where: { id: sequence.id }, data: { activeVersionId: version.id } });
    await logAudit({ entityType: 'sequence', entityId: sequence.id, action: 'created', actor, details: { version: 1 } }, tx);
    return { sequence: updated, version };
  });
}

export async function createSequenceVersion(sequenceId: string, stepsInput: unknown, actor: AuditActor, changeNote?: string | null) {
  const steps = StepsSchema.parse(stepsInput);
  return prisma.$transaction(async (tx) => {
    const latest = await tx.sequenceVersion.findFirst({ where: { sequenceId }, orderBy: { version: 'desc' } });
    const versionNo = (latest?.version ?? 0) + 1;
    const version = await tx.sequenceVersion.create({
      data: { sequenceId, version: versionNo, steps, changeNote: changeNote ?? null, createdById: actor.type === 'USER' ? actor.id : null },
    });
    await tx.sequence.update({ where: { id: sequenceId }, data: { activeVersionId: version.id } });
    await logAudit({ entityType: 'sequence', entityId: sequenceId, action: 'version_created', actor, details: { version: versionNo, changeNote: changeNote ?? null } }, tx);
    return version;
  });
}

export async function updateSequenceMeta(
  sequenceId: string,
  patch: { name?: string; description?: string | null; archived?: boolean },
  actor: AuditActor,
) {
  const updated = await prisma.sequence.update({
    where: { id: sequenceId },
    data: { ...(patch.name ? { name: patch.name.trim() } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}) },
  });
  await logAudit({ entityType: 'sequence', entityId: sequenceId, action: 'updated', actor, details: patch });
  return updated;
}

/**
 * Which step an enrollment generates next, given the version it is on and the active version.
 * Steps are matched by stable id; if the current step id no longer exists in the active
 * version, fall back to position.
 */
export function resolveNextStep(params: { currentStep: number; currentSteps: SequenceStep[]; activeSteps: SequenceStep[] }): {
  nextIndex: number;
  steps: SequenceStep[];
} {
  const { currentStep, currentSteps, activeSteps } = params;
  if (currentStep < 0) return { nextIndex: 0, steps: activeSteps };
  const currentId = currentSteps[currentStep]?.id;
  const idx = currentId ? activeSteps.findIndex((s) => s.id === currentId) : -1;
  const nextIndex = idx >= 0 ? idx + 1 : currentStep + 1;
  return { nextIndex, steps: activeSteps };
}

/** Preview of the step after the current one, for the brief. Null when the sequence ends. */
export function previewNextStep(params: { currentStep: number; currentSteps: SequenceStep[]; activeSteps: SequenceStep[] }): SequenceStep | null {
  const { nextIndex, steps } = resolveNextStep(params);
  return steps[nextIndex] ?? null;
}
