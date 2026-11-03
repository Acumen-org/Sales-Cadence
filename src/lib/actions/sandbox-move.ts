'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canUndoMove } from '../auth/rbac';
import { userActor } from '../audit';
import { isLocalDate, todayIn } from '../dates';
import { NEXT_ACTION_CHANNELS } from '../next-actions';
import { finishMoveIfSettled, preflightMove, processMoveItem, queueMove, retryFailedItems, undoMoveItem, type MoveNextStep, type MoveSelection, type PreflightItem } from '../sandbox/move';
import type { ActionResult } from './users';

function refresh(moveId?: string) {
  revalidatePath('/sandbox');
  revalidatePath('/people');
  if (moveId) revalidatePath(`/sandbox/moves/${moveId}`);
}

/** What Move to CRM would do with these contacts: ready, needs, already in Twenty, which firm. */
export async function preflightMoveAction(ids: string[]): Promise<{ ok: true; items: PreflightItem[]; limit: number; today: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const r = await preflightMove(ids, toActor(user));
  return r.refused ? { ok: false, error: r.refused } : { ok: true, items: r.items, limit: r.limit, today: todayIn(user.timezone) };
}

/** Queue the move; the first items start at once so a single contact moves while the dialog closes. */
export async function queueMoveAction(selection: MoveSelection[], nextStep: MoveNextStep): Promise<ActionResult> {
  const user = await requireUser();
  const label = String(nextStep?.label ?? '').trim();
  if (!label) return { ok: false, error: 'Say what the next step is.' };
  if (!NEXT_ACTION_CHANNELS.includes(nextStep.action)) return { ok: false, error: 'Choose how the next step is done.' };
  if (!isLocalDate(nextStep.dueDate) || nextStep.dueDate < todayIn(user.timezone)) return { ok: false, error: 'Pick today or a later day for the next step.' };
  const r = await queueMove(selection, toActor(user), userActor(user), { label, action: nextStep.action, dueDate: nextStep.dueDate });
  if (!r.ok) return r;
  if (r.queued <= 3) {
    const items = await prisma.sandboxMoveItem.findMany({ where: { moveId: r.moveId, state: 'QUEUED' }, select: { id: true } });
    for (const i of items) await processMoveItem(i.id);
    await finishMoveIfSettled(r.moveId);
  }
  refresh(r.moveId);
  return { ok: true, message: `${r.queued} queued to move.${r.left.length ? ` Left out: ${r.left.map((l) => `${l.name} (${l.reason})`).join(', ')}.` : ''}`, redirectTo: `/sandbox/moves/${r.moveId}` };
}

export async function retryMoveAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const moveId = String(fd.get('moveId') ?? '');
  const move = await prisma.sandboxMove.findUnique({ where: { id: moveId } });
  if (!move) return { ok: false, error: 'Move not found.' };
  if (move.createdById !== user.id && user.role !== 'ADMIN') return { ok: false, error: 'Only the person who started this move, and admins, can retry it.' };
  const n = await retryFailedItems(moveId);
  refresh(moveId);
  return { ok: true, message: n ? `${n} queued again.` : 'Nothing failed.' };
}

export async function undoMoveAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const itemIds = fd.getAll('itemId').map(String).filter(Boolean);
  const results: string[] = [];
  let undone = 0;
  let moveId: string | undefined;
  for (const id of itemIds) {
    const item = await prisma.sandboxMoveItem.findUnique({ where: { id }, select: { moveId: true, sandboxContactId: true } });
    if (!item) continue;
    moveId = item.moveId;
    const contact = await prisma.sandboxContact.findUnique({ where: { id: item.sandboxContactId }, select: { movedById: true, podId: true } });
    if (contact && !canUndoMove(toActor(user), contact)) { results.push('Not yours to undo'); continue; }
    const r = await undoMoveItem(id, toActor(user), userActor(user));
    if (r.ok) undone++; else results.push(r.error);
  }
  refresh(moveId);
  if (!undone) return { ok: false, error: results[0] ?? 'Nothing was undone.' };
  return { ok: true, message: `Undone ${undone}.${results.length ? ` ${results.length} kept: ${[...new Set(results)].join(' ')}` : ''}` };
}
