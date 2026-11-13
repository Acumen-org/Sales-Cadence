'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser, toActor, type SessionUser } from '../auth/current-user';
import { isAdmin, isBizOps, isPodLeader } from '../auth/rbac';
import { userActor } from '../audit';
import { formatLocalDate, isLocalDate, todayIn } from '../dates';
import { assignFollowUp, completeFollowUp, dismissFollowUp, moveFollowUp } from '../linkedin/follow-ups';
import type { ActionResult } from './users';
import { COLD_CONTACT_BASE } from '@/lib/subject';

function revalidate() {
  revalidatePath('/tasks');
  revalidatePath('/home');
  revalidatePath(COLD_CONTACT_BASE, 'layout');
}

/** Whoever it is assigned to, a leader of one of their pods, or an admin. Biz Ops only reads. */
async function mayWork(user: SessionUser, foUserId: string | null): Promise<boolean> {
  const actor = toActor(user);
  if (isBizOps(actor)) return false;
  if (isAdmin(actor) || (foUserId && foUserId === user.id)) return true;
  if (!foUserId || !isPodLeader(actor) || !user.podIds.length) return false;
  return (await prisma.userPod.count({ where: { userId: foUserId, podId: { in: user.podIds } } })) > 0;
}

async function load(id: string) {
  return prisma.linkedInFollowUp.findUnique({ where: { id }, select: { id: true, foUserId: true, state: true, personId: true, sandboxContact: { select: { podId: true } } } });
}

/** Done by hand: the teammate did it and the Console has not shown it yet (a phone, or not yet read). */
export async function completeFollowUpAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await load(String(formData.get('id') ?? ''));
  if (!f) return { ok: false, error: 'This task is gone.' };
  if (!(await mayWork(user, f.foUserId))) return { ok: false, error: 'Only the person it is for, their pod leader or an admin can close it.' };
  const r = await completeFollowUp(f.id, userActor(user));
  if (!r.ok) return r;
  revalidate();
  return { ok: true, message: 'Done.' };
}

/** Not needed after all: closed without being done, with the reason given. */
export async function dismissFollowUpAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await load(String(formData.get('id') ?? ''));
  if (!f) return { ok: false, error: 'This task is gone.' };
  if (!(await mayWork(user, f.foUserId))) return { ok: false, error: 'Only the person it is for, their pod leader or an admin can close it.' };
  const r = await dismissFollowUp(f.id, String(formData.get('reason') ?? ''), userActor(user));
  if (!r.ok) return r;
  revalidate();
  return { ok: true, message: 'Closed as not needed.' };
}

export async function moveFollowUpAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const f = await load(String(formData.get('id') ?? ''));
  if (!f) return { ok: false, error: 'This task is gone.' };
  if (!(await mayWork(user, f.foUserId))) return { ok: false, error: 'Only the person it is for, their pod leader or an admin can move it.' };
  const dueDate = String(formData.get('dueDate') ?? '');
  if (!isLocalDate(dueDate)) return { ok: false, error: 'Pick a day.' };
  const r = await moveFollowUp(f.id, dueDate, userActor(user), todayIn(user.timezone));
  if (!r.ok) return r;
  revalidate();
  return { ok: true, message: `Moved to ${formatLocalDate(dueDate, 'long')}.` };
}

/**
 * Give someone who answered on LinkedIn an owner (Needs an owner). Anyone in the contact's pod may take it
 * for themselves; a pod leader gives it to someone in their pods; an admin to anyone. Biz Ops only reads.
 */
export async function assignFollowUpAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const actor = toActor(user);
  if (isBizOps(actor)) return { ok: false, error: 'Biz Ops has read-only access.' };
  const f = await load(String(formData.get('id') ?? ''));
  if (!f || f.state !== 'OPEN') return { ok: false, error: 'This task is already closed.' };
  const toUserId = String(formData.get('foUserId') ?? '') || user.id;
  const podId = f.sandboxContact?.podId ?? null;
  if (!isAdmin(actor)) {
    if (podId && !user.podIds.includes(podId)) return { ok: false, error: 'This contact is in another pod.' };
    if (toUserId !== user.id) {
      if (!isPodLeader(actor)) return { ok: false, error: 'You can take it yourself; a pod leader gives it to someone else.' };
      if (!(await prisma.userPod.count({ where: { userId: toUserId, podId: { in: user.podIds } } }))) return { ok: false, error: 'You can only give it to someone in your pods.' };
    }
  }
  const r = await assignFollowUp(f.id, toUserId, userActor(user));
  if (!r.ok) return r;
  revalidate();
  const who = toUserId === user.id ? 'you' : (await prisma.user.findUnique({ where: { id: toUserId }, select: { name: true } }))?.name ?? 'them';
  return { ok: true, message: `Given to ${who}.` };
}
