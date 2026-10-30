'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canCheckMeetingNumbers, canCreateMeeting } from '../auth/rbac';
import { logAudit, userActor } from '../audit';
import { renumberProspects } from '../meetings/numbering';
import { pushMeetingToCrm } from '../meetings/crm';
import { afterResponse } from '../engine/sync-out';
import { parseMeetingDay } from '../meetings/day';
import type { ActionResult } from './users';

/**
 * "Think this is wrong?" on a meeting number (owner, 30 October 2026). Whoever adds a meeting can
 * say the number shown for a prospect looks wrong, with what it should be or what they know; Biz
 * Ops sees it under Meetings > Number checks, looks at every meeting with that prospect, sets the
 * number on one if it is wrong (the meetings after it count on from there, and Twenty hears about
 * each one that moved), and closes it with what they found.
 */

const NOT_ALLOWED = 'Only Biz Ops and admins check meeting numbers.';

const Raise = z.object({
  personId: z.string().trim().min(1).max(200),
  meetingId: z.string().trim().min(1).max(200).nullable().optional(),
  day: z.string().trim().max(20),
  shownNumber: z.number().int().min(1).max(10_000),
  expectedNumber: z.number().int().min(1, 'A meeting number starts at 1.').max(10_000).nullable().optional(),
  note: z.string().trim().max(500, 'Keep it under 500 characters.').optional().default(''),
});

export async function raiseNumberCheckAction(input: z.input<typeof Raise>): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const user = await requireUser();
  if (!canCreateMeeting(user)) return { ok: false, error: 'Biz Ops has read-only access to meetings.' };
  const parsed = Raise.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the details and try again.' };
  const d = parsed.data;
  if (!d.expectedNumber && !d.note) return { ok: false, error: 'Say what the number should be, or what you know about it.' };
  const day = parseMeetingDay(d.day);
  if (!day) return { ok: false, error: 'Pick the meeting date first.' };
  const [person, meeting] = await Promise.all([
    prisma.personCache.findFirst({ where: { id: d.personId, deletedAt: null }, select: { id: true } }),
    d.meetingId ? prisma.meeting.findUnique({ where: { id: d.meetingId }, select: { id: true } }) : Promise.resolve(null),
  ]);
  if (!person) return { ok: false, error: 'That prospect is no longer in Twenty.' };
  const ticket = await prisma.meetingNumberTicket.create({ data: { personId: d.personId, meetingId: meeting?.id ?? null, meetingDay: day, shownNumber: d.shownNumber, expectedNumber: d.expectedNumber ?? null, note: d.note || null, raisedById: user.id } });
  await logAudit({ entityType: 'numberCheck', entityId: ticket.id, action: 'raised', actor: userActor(user), details: { personId: d.personId, shown: d.shownNumber, expected: d.expectedNumber ?? null } });
  revalidatePath('/meetings/checks');
  return { ok: true, id: ticket.id };
}

/** Biz Ops sets which meeting with a prospect this is, or clears a number set before. */
export async function setMeetingNumberAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canCheckMeetingNumbers(toActor(user))) return { ok: false, error: NOT_ALLOWED };
  const attendeeId = String(formData.get('attendeeId') ?? '');
  const raw = String(formData.get('number') ?? '').trim();
  const number = raw === '' ? null : Number(raw);
  if (number !== null && (!Number.isInteger(number) || number < 1 || number > 10_000)) return { ok: false, error: 'Enter a whole number from 1, or leave it empty to count it again.' };
  const row = await prisma.meetingAttendee.findFirst({ where: { id: attendeeId, prospect: true }, select: { id: true, personId: true, meetingId: true, numberSetTo: true } });
  if (!row?.personId) return { ok: false, error: 'That meeting no longer has this prospect on it.' };
  await prisma.meetingAttendee.update({ where: { id: row.id }, data: { numberSetTo: number } });
  const changed = await renumberProspects([row.personId]);
  await logAudit({ entityType: 'meeting', entityId: row.meetingId, action: number === null ? 'number_cleared' : 'number_set', actor: userActor(user), details: { personId: row.personId, from: row.numberSetTo, to: number } });
  await afterResponse(async () => { for (const id of changed) await pushMeetingToCrm(id); });
  revalidatePath('/meetings/checks', 'layout');
  revalidatePath('/meetings');
  return { ok: true, message: number === null ? 'Counted again from the meetings before it.' : changed.length ? `Set. ${changed.length} ${changed.length === 1 ? 'meeting' : 'meetings'} renumbered.` : 'Set. No number changed.' };
}

/** Close a check with what was found; the person who raised it sees the answer under Number checks. */
export async function closeNumberCheckAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canCheckMeetingNumbers(toActor(user))) return { ok: false, error: NOT_ALLOWED };
  const id = String(formData.get('ticketId') ?? '');
  const resolution = String(formData.get('resolution') ?? '').trim().slice(0, 1000);
  const { count } = await prisma.meetingNumberTicket.updateMany({ where: { id, open: true }, data: { open: false, resolvedById: user.id, resolvedAt: new Date(), resolution: resolution || null } });
  if (!count) return { ok: false, error: 'This check is already closed.' };
  await logAudit({ entityType: 'numberCheck', entityId: id, action: 'closed', actor: userActor(user), details: { resolution: resolution || null } });
  revalidatePath('/meetings/checks', 'layout');
  return { ok: true, message: 'Closed.', redirectTo: '/meetings/checks' };
}

/** Open a closed check again, when the number turns out to be wrong after all. */
export async function reopenNumberCheckAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canCheckMeetingNumbers(toActor(user))) return { ok: false, error: NOT_ALLOWED };
  const id = String(formData.get('ticketId') ?? '');
  const { count } = await prisma.meetingNumberTicket.updateMany({ where: { id, open: false }, data: { open: true, resolvedById: null, resolvedAt: null } });
  if (!count) return { ok: false, error: 'This check is already open.' };
  await logAudit({ entityType: 'numberCheck', entityId: id, action: 'reopened', actor: userActor(user) });
  revalidatePath('/meetings/checks', 'layout');
  return { ok: true, message: 'Open again.' };
}
