import { Prisma, type ActionType } from '@prisma/client';
import { ACTION_LABELS } from '../sequences/steps';
import { readExtraPhones, toE164 } from '../sandbox/normalize';

/**
 * scrub(): one routine for Remove and Erase (cold outreach PLAN 8.5, B054). Clearing the contact's
 * own row was never enough: its numbers sat on calls and call intents, its words in form notes,
 * email subjects, next-step labels, email touches and audit details. What stays is what reports
 * count by: ids, dates, outcomes, directions and talk time.
 */

/** Detail keys an audit row may hold personal data under; dropped from the contact's audit rows. */
const PERSONAL_KEYS = new Set(['label', 'name', 'email', 'phone', 'number', 'note', 'notes', 'body', 'subject', 'firstName', 'lastName', 'reason', 'title', 'text', 'value', 'toNumber', 'fromNumber', 'linkedinUrl', 'company', 'companyName']);

export function scrubDetails(details: unknown): Prisma.InputJsonValue | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) if (!PERSONAL_KEYS.has(k)) out[k] = v;
  return out as Prisma.InputJsonValue;
}

export type ScrubTarget = { id: string; phone?: string | null; additionalPhones?: unknown };

/** Clear everything Cadence holds about the contact outside its own row, inside the caller's transaction. Returns the Twilio recordings left to delete there. */
export async function scrub(tx: Prisma.TransactionClient, c: ScrubTarget): Promise<{ recordings: string[] }> {
  const numbers = [...new Set([c.phone, ...readExtraPhones(c.additionalPhones).map((p) => p.number)].map((n) => toE164(n)).filter((n): n is string => Boolean(n)))];

  // Calls with the contact: their side of each call loses its number, and no candidate list keeps their name.
  await tx.callLog.updateMany({ where: { sandboxContactId: c.id, direction: 'OUTBOUND' }, data: { toNumber: null } });
  await tx.callLog.updateMany({ where: { sandboxContactId: c.id, direction: 'INBOUND' }, data: { fromNumber: null } });
  // Calls nobody was matched to yet, on one of the contact's numbers.
  if (numbers.length) {
    await tx.callLog.updateMany({ where: { personId: null, sandboxContactId: null, direction: 'OUTBOUND', toNumber: { in: numbers } }, data: { toNumber: null } });
    await tx.callLog.updateMany({ where: { personId: null, sandboxContactId: null, direction: 'INBOUND', fromNumber: { in: numbers } }, data: { fromNumber: null } });
  }
  const ambiguous = await tx.$queryRaw<{ id: string; candidates: unknown }[]>`SELECT id, candidates FROM "CallLog" WHERE candidates IS NOT NULL AND candidates::text LIKE ${`%${c.id}%`}`;
  for (const call of ambiguous) {
    const kept = Array.isArray(call.candidates) ? (call.candidates as { id?: string }[]).filter((x) => x?.id !== c.id) : [];
    await tx.callLog.update({ where: { id: call.id }, data: { candidates: kept.length ? (kept as Prisma.InputJsonValue) : Prisma.DbNull } });
  }
  await tx.$executeRaw`UPDATE "CallLog" SET candidates = NULL WHERE "sandboxContactId" = ${c.id} AND candidates IS NOT NULL`;

  // Presses of Call for the contact, and unclaimed ones to its numbers.
  await tx.callIntent.updateMany({ where: { sandboxContactId: c.id }, data: { toNumber: '' } });
  if (numbers.length) await tx.callIntent.updateMany({ where: { toNumber: { in: numbers }, personId: null, sandboxContactId: null }, data: { toNumber: '' } });

  // What reps wrote and what mail said.
  await tx.callForm.updateMany({ where: { call: { sandboxContactId: c.id } }, data: { notes: null } });
  await tx.sandboxEmail.updateMany({ where: { sandboxContactId: c.id }, data: { subject: null } });
  await tx.sandboxNote.deleteMany({ where: { sandboxContactId: c.id } });
  for (const action of Object.keys(ACTION_LABELS) as ActionType[]) {
    await tx.nextAction.updateMany({ where: { sandboxContactId: c.id, personId: null, action }, data: { label: ACTION_LABELS[action] } });
  }
  // Email touches carry the subject; a reply stays a reply and an auto-reply stays one, so counts do not move.
  await tx.touch.updateMany({ where: { sandboxContactId: c.id, personId: null, channel: 'EMAIL', direction: 'OUTBOUND' }, data: { summary: 'Email sent' } });
  await tx.touch.updateMany({ where: { sandboxContactId: c.id, personId: null, channel: 'EMAIL', direction: 'INBOUND', summary: { startsWith: 'Auto-reply' } }, data: { summary: 'Auto-reply:' } });
  await tx.touch.updateMany({ where: { sandboxContactId: c.id, personId: null, channel: 'EMAIL', direction: 'INBOUND', NOT: { summary: { startsWith: 'Auto-reply' } } }, data: { summary: 'Reply' } });
  await tx.ticket.updateMany({ where: { sandboxContactId: c.id, personId: null }, data: { note: null } });
  await tx.notification.updateMany({ where: { sandboxContactId: c.id, personId: null }, data: { payload: {} } });

  const audits = await tx.auditLog.findMany({ where: { entityType: 'sandbox_contact', entityId: c.id, details: { not: Prisma.DbNull } }, select: { id: true, details: true } });
  for (const a of audits) {
    const clean = scrubDetails(a.details);
    if (JSON.stringify(clean) !== JSON.stringify(a.details)) await tx.auditLog.update({ where: { id: a.id }, data: { details: clean ?? Prisma.DbNull } });
  }
  const recordings = await tx.callLog.findMany({ where: { sandboxContactId: c.id, recordingSid: { not: null } }, select: { recordingSid: true } });
  return { recordings: recordings.map((r) => r.recordingSid!) };
}
