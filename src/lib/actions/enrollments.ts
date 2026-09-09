'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canManageEnrollment } from '../auth/rbac';
import { userActor } from '../audit';
import { exitEnrollment, pauseEnrollment, reassignEnrollment, resumeEnrollment } from '../engine/enrollment';
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
