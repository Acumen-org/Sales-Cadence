'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '../db';
import { requireUser } from '../auth/current-user';
import { assertAllowed, canEditSequences } from '../auth/rbac';
import { userActor } from '../audit';
import { createSequence, saveSequenceSteps, updateSequenceMeta } from '../engine/sequence-plan';
import { StepsSchema } from '../sequences/steps';
import type { ActionResult } from './users';

function parseStepsField(raw: unknown): { ok: true; steps: unknown } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'No steps provided.' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Steps are not valid JSON.' };
  }
  const parsed = StepsSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, steps: parsed.data };
}

const CreateSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(1000).optional() });

export async function createSequenceAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  assertAllowed(canEditSequences(admin));
  const meta = CreateSchema.safeParse({ name: formData.get('name'), description: formData.get('description') || undefined });
  if (!meta.success) return { ok: false, error: 'Name is required.' };
  const steps = parseStepsField(formData.get('steps'));
  if (!steps.ok) return steps;
  if (await prisma.sequence.findUnique({ where: { name: meta.data.name } })) return { ok: false, error: 'A sequence with that name already exists.' };
  const { sequence } = await createSequence({ name: meta.data.name, description: meta.data.description ?? null, steps: steps.steps }, userActor(admin));
  revalidatePath('/sequences');
  return { ok: true, message: 'Sequence created.', redirectTo: `/sequences/${sequence.id}` };
}

export async function saveSequenceAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  assertAllowed(canEditSequences(admin));
  const sequenceId = String(formData.get('sequenceId') ?? '');
  const steps = parseStepsField(formData.get('steps'));
  if (!steps.ok) return steps;
  const sequence = await prisma.sequence.findUnique({ where: { id: sequenceId } });
  if (!sequence) return { ok: false, error: 'Sequence not found.' };
  const name = String(formData.get('name') ?? sequence.name).trim();
  if (!name || name.length > 120) return { ok: false, error: 'Enter a sequence name of up to 120 characters.' };
  const clash = await prisma.sequence.findUnique({ where: { name } });
  if (clash && clash.id !== sequenceId) return { ok: false, error: 'Another sequence has that name.' };
  try {
    if (JSON.stringify(sequence.steps) !== JSON.stringify(steps.steps)) await saveSequenceSteps(sequenceId, steps.steps, userActor(admin));
    await updateSequenceMeta(sequenceId, { name, archived: formData.get('archived') === 'on' }, userActor(admin));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save sequence.' };
  }
  revalidatePath('/sequences');
  revalidatePath(`/sequences/${sequenceId}`);
  return { ok: true, message: 'Sequence saved.' };
}

const MetaSchema = z.object({
  sequenceId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  archived: z.string().optional().transform((v) => v === 'on' || v === 'true'),
});

export async function updateSequenceMetaAction(formData: FormData): Promise<ActionResult> {
  const admin = await requireUser();
  assertAllowed(canEditSequences(admin));
  const parsed = MetaSchema.safeParse({ sequenceId: formData.get('sequenceId'), name: formData.get('name'), description: formData.get('description') || undefined, archived: formData.get('archived') || undefined });
  if (!parsed.success) return { ok: false, error: 'Name is required.' };
  const clash = await prisma.sequence.findUnique({ where: { name: parsed.data.name } });
  if (clash && clash.id !== parsed.data.sequenceId) return { ok: false, error: 'Another sequence has that name.' };
  await updateSequenceMeta(parsed.data.sequenceId, { name: parsed.data.name, description: parsed.data.description ?? null, archived: parsed.data.archived }, userActor(admin));
  revalidatePath('/sequences');
  revalidatePath(`/sequences/${parsed.data.sequenceId}`);
  return { ok: true, message: 'Saved.' };
}
