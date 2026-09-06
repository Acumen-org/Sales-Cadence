'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canEnroll, canManageEnrollment } from '../auth/rbac';
import { userActor } from '../audit';
import { finishEnrollment, optOutPerson, setPersonFlags } from '../engine/enrollment';
import { moveToStep } from '../engine/outcomes';
import type { ActionResult } from './users';

function revalidate(personId: string) {
  revalidatePath(`/people/${personId}`);
  revalidatePath('/people');
  revalidatePath('/tasks');
  revalidatePath('/home');
}

/** Opt a person out (or back in) of outreach. Cadence-local: Twenty's dnd is never written. */
export async function setOptOutAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const personId = String(formData.get('personId') ?? '');
  const optedOut = formData.get('optedOut') === 'true';
  if (!personId) return { ok: false, error: 'Missing person.' };
  if (!canEnroll(toActor(user))) return { ok: false, error: 'Only Senior FOs and Admins can change contact preferences.' };
  const r = await optOutPerson(personId, { actor: userActor(user), optedOut });
  revalidate(personId);
  return { ok: true, message: optedOut ? `Opted out${r.exited.length ? ' and removed from the sequence' : ''}. Set dnd in Twenty as well if this should apply everywhere.` : 'Opt-out cleared.' };
}

export async function clearBadDataAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const personId = String(formData.get('personId') ?? '');
  if (!personId) return { ok: false, error: 'Missing person.' };
  if (!canEnroll(toActor(user))) return { ok: false, error: 'Only Senior FOs and Admins can clear flags.' };
  await setPersonFlags(personId, { badEmail: false, badPhone: false }, userActor(user));
  revalidate(personId);
  return { ok: true, message: 'Bad-data flags cleared.' };
}

export async function finishEnrollmentAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const enrollmentId = String(formData.get('enrollmentId') ?? '');
  const kind = String(formData.get('kind') ?? '');
  if (kind !== 'replied' && kind !== 'no_reply') return { ok: false, error: 'Invalid request.' };
  const e = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
  if (!e) return { ok: false, error: 'Enrollment not found.' };
  if (!canManageEnrollment(toActor(user), e) && e.foUserId !== user.id) return { ok: false, error: 'You cannot change this enrollment.' };
  await finishEnrollment(enrollmentId, kind, { actor: userActor(user) });
  revalidate(e.personId);
  revalidatePath('/campaigns');
  return { ok: true, message: kind === 'replied' ? 'Finished as replied.' : 'Finished (no reply).' };
}

export async function moveEnrollmentToStepAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const enrollmentId = String(formData.get('enrollmentId') ?? '');
  const target = Number.parseInt(String(formData.get('stepIndex') ?? ''), 10);
  const e = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
  if (!e) return { ok: false, error: 'Enrollment not found.' };
  if (!canManageEnrollment(toActor(user), e)) return { ok: false, error: 'You cannot change this enrollment.' };
  if (!Number.isInteger(target)) return { ok: false, error: 'Pick a step.' };
  const r = await moveToStep(enrollmentId, target, { actor: userActor(user) });
  revalidate(e.personId);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, message: `Moved to step ${target + 1}.` };
}
