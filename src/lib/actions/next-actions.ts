'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser, toActor, type SessionUser } from '../auth/current-user';
import { isAdmin, isBizOps, isJuniorFo, isPodLeader, whyNotWorkTask } from '../auth/rbac';
import { userActor } from '../audit';
import { formatLocalDate, todayIn } from '../dates';
import { completeNextAction, moveNextAction, setNextActions, stopNextAction, validateNextAction } from '../next-actions';
import { personSearchWhere } from '../search-terms';
import { cachedPersonName } from '../person-cache';
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
 * Create a task for one person, or for everyone selected in People. A junior FO's tasks are their
 * own; anyone who leads assigns them - by default to each person's own FO.
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
    if (!(await mayWork(user, fo.id))) return { ok: false, error: 'You can only assign tasks to FOs in your pods.' };
  }
  // Writes stay inside what the user works: a person's open task belongs to its FO, and a junior
  // FO's tasks are for their own people.
  const refused: { personId: string; reason: string }[] = [];
  const open = await prisma.nextAction.findMany({ where: { personId: { in: personIds }, state: 'OPEN' }, select: { personId: true, foUserId: true, fo: { select: { name: true } } } });
  for (const o of open) if (!(await mayWork(user, o.foUserId))) refused.push({ personId: o.personId, reason: `already has a task with ${o.fo.name}` });
  if (isJuniorFo(actor)) {
    const podOwners = (await prisma.pod.findMany({ where: { id: { in: user.podIds } }, select: { podOwnerValue: true } })).map((p) => p.podOwnerValue);
    const mine = new Set((await prisma.personCache.findMany({
      where: { id: { in: personIds }, OR: [{ enrollments: { some: { foUserId: user.id } } }, ...(user.twentyMemberId ? [{ ownerMemberId: user.twentyMemberId }] : []), ...(podOwners.length ? [{ podOwner: { in: podOwners } }] : [])] },
      select: { id: true },
    })).map((p) => p.id));
    for (const id of personIds) if (!mine.has(id) && !refused.some((x) => x.personId === id)) refused.push({ personId: id, reason: 'not in your pod' });
  }
  const allowed = personIds.filter((id) => !refused.some((x) => x.personId === id));
  if (!allowed.length) {
    const name = await prisma.personCache.findUnique({ where: { id: refused[0].personId }, select: { firstName: true, lastName: true, email: true } });
    return { ok: false, error: `${name ? cachedPersonName(name) : 'This person'} ${refused[0].reason}.` };
  }
  const r = await setNextActions(allowed, input, userActor(user), user.id);
  revalidate(personIds);
  if (!r.set.length) return { ok: false, error: r.skipped[0]?.reason ?? 'Nothing was set.' };
  const who = r.set.length === 1 ? 'Task created' : `Task created for ${r.set.length} people`;
  const left = r.skipped.length + refused.length;
  return { ok: true, message: left ? `${who}. ${left} left out (${[...new Set([...r.skipped.map((x) => x.reason.toLowerCase()), ...refused.map((x) => x.reason)])].join('; ')}).` : `${who}.`, data: { ids: r.set } };
}

async function loadOwn(id: string) {
  const user = await requireUser();
  const na = await prisma.nextAction.findUnique({ where: { id }, select: { id: true, foUserId: true, personId: true, state: true } });
  if (!na) return { user, na: null, error: 'Task not found.' };
  if (!(await mayWork(user, na.foUserId))) return { user, na: null, error: whyNotWorkTask(toActor(user), (await prisma.user.findUnique({ where: { id: na.foUserId }, select: { name: true } }))?.name ?? 'someone else') };
  return { user, na, error: null };
}

export async function completeNextActionAction(formData: FormData): Promise<ActionResult> {
  const { user, na, error } = await loadOwn(String(formData.get('id') ?? ''));
  if (!na) return { ok: false, error: error! };
  const r = await completeNextAction(na.id, userActor(user), new Date(), String(formData.get('dueDate') ?? '') || null);
  revalidate([na.personId]);
  if (!r.ok) return r;
  return { ok: true, message: r.next ? `Done. Next one on ${formatLocalDate(r.next, 'long')}.` : 'Done.' };
}

export async function moveNextActionAction(formData: FormData): Promise<ActionResult> {
  const { user, na, error } = await loadOwn(String(formData.get('id') ?? ''));
  if (!na) return { ok: false, error: error! };
  const to = String(formData.get('dueDate') ?? '');
  const r = await moveNextAction(na.id, to, userActor(user), todayIn(user.timezone));
  revalidate([na.personId]);
  if (!r.ok) return r;
  return { ok: true, message: `Moved to ${formatLocalDate(to, 'long')}.` };
}

export async function stopNextActionAction(formData: FormData): Promise<ActionResult> {
  const { user, na, error } = await loadOwn(String(formData.get('id') ?? ''));
  if (!na) return { ok: false, error: error! };
  const r = await stopNextAction(na.id, userActor(user));
  revalidate([na.personId]);
  if (!r.ok) return r;
  return { ok: true, message: 'Task stopped.' };
}

export type TaskPersonOption = { id: string; name: string; sub: string | null; dnd: boolean; openTask: { label: string; dueDate: string } | null };

/** People to create a task for, found by name, email or company. Everyone reads everyone. */
export async function findPeopleForTaskAction(query: string): Promise<TaskPersonOption[]> {
  await requireUser();
  const q = String(query ?? '').trim().slice(0, 200);
  const where = personSearchWhere(q);
  if (q.length < 2 || !where) return [];
  const people = await prisma.personCache.findMany({
    where: { AND: [{ deletedAt: null }, where] },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: 8,
    select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true, companyName: true, dnd: true, nextActions: { where: { state: 'OPEN' }, select: { label: true, dueDate: true }, take: 1 } },
  });
  return people.map((p) => ({ id: p.id, name: cachedPersonName(p), sub: [p.jobTitle, p.companyName].filter(Boolean).join(' · ') || p.email, dnd: p.dnd, openTask: p.nextActions[0] ?? null }));
}
