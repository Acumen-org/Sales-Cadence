'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canEnroll, canManageEnrollment } from '../auth/rbac';
import { userActor } from '../audit';
import { isLocalDate, todayIn } from '../dates';
import { enrollPeople, exitEnrollment, pauseEnrollment, reassignEnrollment, resumeEnrollment } from '../engine/enrollment';
import type { ActionResult } from './users';

function revalidateAll(campaignId?: string | null) {
  revalidatePath('/tasks');
  revalidatePath('/people');
  revalidatePath('/campaigns');
  revalidatePath('/reports');
  if (campaignId) revalidatePath(`/campaigns/${campaignId}`);
}

async function loadEnrollmentForUser(enrollmentId: string) {
  const user = await requireUser();
  const e = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
  if (!e) return { user, e: null, error: 'Enrollment not found.' };
  if (!canManageEnrollment(toActor(user), e)) return { user, e: null, error: 'You cannot manage this enrollment.' };
  return { user, e, error: null };
}

const EnrollOneSchema = z.object({
  personId: z.string().min(1),
  sequenceId: z.string().min(1),
  podId: z.string().min(1),
  foUserId: z.string().optional().transform((v) => (v ? v : null)),
  startDate: z.string().optional(),
});

/** Row action on People: enrol one person now (or on a chosen start date). */
export async function enrollOneAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = EnrollOneSchema.safeParse({
    personId: formData.get('personId'),
    sequenceId: formData.get('sequenceId'),
    podId: formData.get('podId'),
    foUserId: formData.get('foUserId') || undefined,
    startDate: formData.get('startDate') || undefined,
  });
  if (!parsed.success) return { ok: false, error: 'Pick a sequence and a pod.' };
  const d = parsed.data;
  if (!canEnroll(toActor(user), d.podId)) return { ok: false, error: 'You cannot enrol people in this pod.' };
  const startDate = d.startDate && isLocalDate(d.startDate) ? d.startDate : todayIn(user.timezone);
  const r = await enrollPeople({
    personIds: [d.personId],
    sequenceId: d.sequenceId,
    podId: d.podId,
    startDate,
    assignment: d.foUserId ? { mode: 'FIXED', foUserId: d.foUserId } : { mode: 'OWNER' },
    actor: userActor(user),
  });
  revalidateAll();
  if (r.enrolled.length) return { ok: true, message: `Enrolled. First step due ${r.enrolled[0].startDate}.` };
  const c = r.conflicts[0];
  return { ok: false, error: c ? `${c.reason.replace(/_/g, ' ')}${c.detail ? `: ${c.detail}` : ''}` : 'Could not enrol.' };
}

export async function exitEnrollmentAction(formData: FormData): Promise<ActionResult> {
  const { user, e, error } = await loadEnrollmentForUser(String(formData.get('enrollmentId') ?? ''));
  if (!e) return { ok: false, error: error ?? 'Not found.' };
  const reason = String(formData.get('reason') ?? 'manual').trim() || 'manual';
  await exitEnrollment(e.id, { reason, actor: userActor(user) });
  revalidateAll(e.campaignId);
  return { ok: true, message: 'Exited.' };
}

export async function pauseEnrollmentAction(formData: FormData): Promise<ActionResult> {
  const { user, e, error } = await loadEnrollmentForUser(String(formData.get('enrollmentId') ?? ''));
  if (!e) return { ok: false, error: error ?? 'Not found.' };
  await pauseEnrollment(e.id, { reason: String(formData.get('reason') ?? 'manual').trim() || 'manual', actor: userActor(user) });
  revalidateAll(e.campaignId);
  return { ok: true, message: 'Paused.' };
}

export async function resumeEnrollmentAction(formData: FormData): Promise<ActionResult> {
  const { user, e, error } = await loadEnrollmentForUser(String(formData.get('enrollmentId') ?? ''));
  if (!e) return { ok: false, error: error ?? 'Not found.' };
  await resumeEnrollment(e.id, { actor: userActor(user) });
  revalidateAll(e.campaignId);
  return { ok: true, message: 'Resumed.' };
}

export async function reassignEnrollmentAction(formData: FormData): Promise<ActionResult> {
  const { user, e, error } = await loadEnrollmentForUser(String(formData.get('enrollmentId') ?? ''));
  if (!e) return { ok: false, error: error ?? 'Not found.' };
  const foUserId = String(formData.get('foUserId') ?? '');
  if (!foUserId) return { ok: false, error: 'Pick an FO.' };
  try {
    await reassignEnrollment(e.id, foUserId, { actor: userActor(user) });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidateAll(e.campaignId);
  return { ok: true, message: 'Reassigned.' };
}
