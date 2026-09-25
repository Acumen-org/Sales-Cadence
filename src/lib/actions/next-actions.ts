'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser, toActor, type SessionUser } from '../auth/current-user';
import { isAdmin, isBizOps, isJuniorFo, isPodLeader } from '../auth/rbac';
import { userActor } from '../audit';
import { todayIn } from '../dates';
import { completeNextAction, moveNextAction, setNextActions, stopNextAction, validateNextAction } from '../next-actions';
import type { ActionResult } from './users';

function revalidate(personIds: string[] = []) {
  revalidatePath('/tasks');
  revalidatePath('/people');
  revalidatePath('/home');
  for (const id of personIds.slice(0, 20)) revalidatePath(`/people/${id}`);
}

/** Whoever it is assigned to, a leader of one of their pods, or an admin. Biz Ops only reads. */
async function mayWork(user: SessionUser, foUserId: string): Promise<boolean> {
  const actor = toActor(user);
  if (isBizOps(actor)) return false;
  if (foUserId === user.id || isAdmin(actor)) return true;
  if (!isPodLeader(actor) || !user.podIds.length) return false;
  return (await prisma.userPod.count({ where: { userId: foUserId, podId: { in: user.podIds } } })) > 0;
}

/**
 * Give one person, or everyone selected in People, a next action. A junior FO's next actions are
 * their own; anyone who leads assigns them - by default to each person's own FO.
 */
export async function saveNextActionAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const actor = toActor(user);
  if (isBizOps(actor)) return { ok: false, error: 'Biz Ops has read-only access.' };
  let personIds: string[] = [];
  try { personIds = (JSON.parse(String(formData.get('personIds') ?? '[]')) as unknown[]).map(String).filter(Boolean); } catch { /* checked below */ }
  if (!personIds.length) return { ok: false, error: 'Choose at least one person.' };
  if (personIds.length > 500) return { ok: false, error: 'Choose at most 500 people at a time.' };
  const parsed = validateNextAction({ label: formData.get('label'), action: formData.get('action'), dueDate: formData.get('dueDate'), repeat: formData.get('repeat'), foUserId: formData.get('foUserId') || null }, todayIn(user.timezone));
  if (!parsed.ok) return parsed;
  const input = { ...parsed.value, foUserId: isJuniorFo(actor) ? user.id : parsed.value.foUserId };
  if (input.foUserId && input.foUserId !== user.id) {
    const fo = await prisma.user.findFirst({ where: { id: input.foUserId, active: true }, select: { id: true } });
    if (!fo) return { ok: false, error: 'That FO is not active.' };
    if (!(await mayWork(user, fo.id))) return { ok: false, error: 'You can only assign next actions to FOs in your pods.' };
  }
  const r = await setNextActions(personIds, input, userActor(user), user.id);
  revalidate(personIds);
  if (!r.set.length) return { ok: false, error: r.skipped[0]?.reason ?? 'Nothing was set.' };
  const who = r.set.length === 1 ? 'Next action set' : `Next action set for ${r.set.length} people`;
  return { ok: true, message: r.skipped.length ? `${who}. ${r.skipped.length} left out (do not contact or no longer in the CRM).` : `${who}.` };
}

async function loadOwn(id: string) {
  const user = await requireUser();
  const na = await prisma.nextAction.findUnique({ where: { id }, select: { id: true, foUserId: true, personId: true, state: true } });
  if (!na) return { user, na: null, error: 'Next action not found.' };
  if (!(await mayWork(user, na.foUserId))) return { user, na: null, error: 'You cannot change this next action.' };
  return { user, na, error: null };
}

export async function completeNextActionAction(formData: FormData): Promise<ActionResult> {
  const { user, na, error } = await loadOwn(String(formData.get('id') ?? ''));
  if (!na) return { ok: false, error: error! };
  const r = await completeNextAction(na.id, userActor(user));
  revalidate([na.personId]);
  if (!r.ok) return r;
  return { ok: true, message: r.next ? `Done. Next one on ${r.next}.` : 'Done.' };
}

export async function moveNextActionAction(formData: FormData): Promise<ActionResult> {
  const { user, na, error } = await loadOwn(String(formData.get('id') ?? ''));
  if (!na) return { ok: false, error: error! };
  const to = String(formData.get('dueDate') ?? '');
  const r = await moveNextAction(na.id, to, userActor(user), todayIn(user.timezone));
  revalidate([na.personId]);
  if (!r.ok) return r;
  return { ok: true, message: `Moved to ${to}.` };
}

export async function stopNextActionAction(formData: FormData): Promise<ActionResult> {
  const { user, na, error } = await loadOwn(String(formData.get('id') ?? ''));
  if (!na) return { ok: false, error: error! };
  const r = await stopNextAction(na.id, userActor(user));
  revalidate([na.personId]);
  if (!r.ok) return r;
  return { ok: true, message: 'Next action stopped.' };
}
