'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { userActor } from '../audit';
import { isLocalDate, todayIn } from '../dates';
import { NEXT_ACTION_CHANNELS } from '../next-actions';
import { finishMoveIfSettled, preflightMove, processMoveItem, queueMove, retryFailedItems, undoMoveItem, type MoveCounts, type MoveNextStep, type MoveSelection, type PreflightItem } from '../sandbox/move';
import type { ActionResult } from './users';

function refresh(moveId?: string) {
  revalidatePath('/sandbox');
  revalidatePath('/people');
  if (moveId) revalidatePath(`/sandbox/moves/${moveId}`);
}

/** What Move to CRM would do with these contacts, in the dialog's groups (4.5). */
export async function preflightMoveAction(ids: string[]): Promise<{ ok: true; items: PreflightItem[]; counts: MoveCounts; limit: number; today: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const r = await preflightMove(ids, toActor(user));
  return r.refused ? { ok: false, error: r.refused } : { ok: true, items: r.items, counts: r.counts, limit: r.limit, today: todayIn(user.timezone) };
}

/**
 * Queue the move; the first items start at once so a single contact moves while the dialog closes.
 * The step is for contacts without one of their own (B034); it may be left out when none needs it.
 */
export async function queueMoveAction(selection: MoveSelection[], nextStep: MoveNextStep | null): Promise<ActionResult> {
  const user = await requireUser();
  let step: MoveNextStep | null = null;
  if (nextStep && String(nextStep.label ?? '').trim()) {
    if (!NEXT_ACTION_CHANNELS.includes(nextStep.action)) return { ok: false, error: 'Choose how the next step is done.' };
    if (!isLocalDate(nextStep.dueDate) || nextStep.dueDate < todayIn(user.timezone)) return { ok: false, error: 'Pick today or a later day for the next step.' };
    step = { label: String(nextStep.label).trim().slice(0, 200), action: nextStep.action, dueDate: nextStep.dueDate };
  }
  const r = await queueMove(selection, toActor(user), userActor(user), step, { requireStep: true });
  if (!r.ok) return r;
  if (r.queued <= 3) {
    const items = await prisma.sandboxMoveItem.findMany({ where: { moveId: r.moveId, state: 'QUEUED' }, select: { id: true } });
    for (const i of items) await processMoveItem(i.id);
    await finishMoveIfSettled(r.moveId);
  }
  refresh(r.moveId);
  return { ok: true, message: `${r.queued} queued to move.${r.left.length ? ` Left out: ${r.left.map((l) => `${l.name} (${l.reason})`).join(', ')}.` : ''}`, redirectTo: `/sandbox/moves/${r.moveId}` };
}

/** Retry: open to whoever may undo (B188), only where retrying can help (B036, B105). */
export async function retryMoveAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const moveId = String(fd.get('moveId') ?? '');
  const r = await retryFailedItems(moveId, toActor(user));
  refresh(moveId);
  if (!r.queued) return { ok: false, error: r.refused[0] ?? 'Nothing here can be retried: what failed needs a fix first.' };
  return { ok: true, message: `${r.queued} queued again.` };
}

/**
 * Undo one item, or every item given (Undo all, B187). `restore` names the enrollments the confirm's
 * "Put back in <campaign>" boxes asked for (B101). The reply says what happened, partial or not (B113).
 */
export async function undoMoveAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const itemIds = fd.getAll('itemId').map(String).filter(Boolean);
  const restore = fd.getAll('restore').map(String).filter(Boolean);
  const kept: string[] = [];
  const messages: string[] = [];
  let undone = 0;
  let partial = 0;
  let moveId: string | undefined;
  for (const id of itemIds) {
    const item = await prisma.sandboxMoveItem.findUnique({ where: { id }, select: { moveId: true } });
    if (!item) continue;
    moveId = item.moveId;
    const r = await undoMoveItem(id, toActor(user), userActor(user), new Date(), { restoreEnrollmentIds: restore });
    if (!r.ok) { kept.push(r.error); continue; }
    messages.push(r.message);
    if (r.partial) partial++; else undone++;
  }
  refresh(moveId);
  if (!undone && !partial) return { ok: false, error: kept[0] ?? 'Nothing was undone.' };
  if (itemIds.length === 1) return { ok: true, message: messages[0] };
  return { ok: true, message: `Undone ${undone}.${partial ? ` Undo incomplete for ${partial}: undo them again to finish.` : ''}${kept.length ? ` ${kept.length} kept: ${[...new Set(kept)].slice(0, 2).join(' ')}` : ''}` };
}
