'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '../auth/current-user';
import { isAdmin } from '../auth/rbac';
import { userActor } from '../audit';
import { coldRef, personRef, type SubjectRef } from '../subject';
import { closeTicket, liftFormOptOut, raiseOptOutTicket } from '../tickets';
import type { ActionResult } from './users';

/**
 * Tickets and lifting a form opt-out (D4). Raising a ticket is open to anyone signed in; closing one is
 * Biz Ops' and admins'; lifting an opt-out directly is any admin's, at any time, with no reason.
 */

function refOf(fd: FormData): SubjectRef | null {
  const person = String(fd.get('personId') ?? '');
  const cold = String(fd.get('sandboxContactId') ?? '');
  return person ? personRef(person) : cold ? coldRef(cold) : null;
}

function refresh() {
  revalidatePath('/tickets', 'layout');
  revalidatePath('/', 'layout');
}

/** "Think this is wrong?" on an opt-out from the post-call form. */
export async function raiseOptOutTicketAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const ref = refOf(fd);
  if (!ref) return { ok: false, error: 'Choose who the opt-out is about.' };
  const r = await raiseOptOutTicket(ref, String(fd.get('reason') ?? fd.get('note') ?? ''), user, userActor(user));
  if (r.ok) refresh();
  return r.ok ? { ok: true, message: r.message } : r;
}

/** An admin undoes a form opt-out at once: no reason needed, and it is audited. */
export async function liftOptOutAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!isAdmin(user)) return { ok: false, error: 'Only an admin can undo an opt-out here. Anyone can ask Biz Ops with "Think this is wrong?".' };
  const ref = refOf(fd);
  if (!ref) return { ok: false, error: 'Choose whose opt-out to undo.' };
  const r = await liftFormOptOut(ref, user, userActor(user));
  if (r.ok) refresh();
  return r;
}

/** Biz Ops close a ticket with what they found; on an opt-out ticket they may lift it. */
export async function closeTicketAction(fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const r = await closeTicket(String(fd.get('ticketId') ?? ''), { note: String(fd.get('resolution') ?? ''), lift: fd.get('lift') === '1' }, user, userActor(user));
  if (r.ok) refresh();
  return r.ok ? { ...r, redirectTo: '/tickets' } : r;
}
