import { prisma } from '../db';
import { formatInstant } from '../dates';
import { getSettings } from '../settings';
import { suppressionReason } from '../sandbox/opt-out';
import { callingHours } from './hours';

/**
 * Whether Cadence's Call button may open the dialpad for this contact now, checked where the button
 * is drawn: a call of yours still waiting for its form, an opt-out or the suppression list, and
 * calling hours. The dialpad itself is outside Cadence's reach (decision 14).
 */

export type CallGate = { blocked: string | null; warning: string | null };

/** The rep's oldest call waiting for its form, named the way the pending bar names it. */
export async function pendingFormBlock(userId: string, timezone: string): Promise<string | null> {
  const pending = await prisma.callLog.findFirst({ where: { userId, formDueAt: { not: null }, formDoneAt: null }, orderBy: { formDueAt: 'asc' }, include: { person: { select: { firstName: true, lastName: true } }, sandboxContact: { select: { firstName: true, lastName: true } } } });
  if (!pending) return null;
  const who = pending.person ?? pending.sandboxContact;
  const name = who ? `${who.firstName} ${who.lastName}`.trim() : pending.toNumber ?? 'an unknown number';
  return `Fill in the form for your call with ${name} at ${formatInstant(pending.startedAt ?? pending.createdAt, timezone).split(', ').pop()} first.`;
}

export async function callGate(user: { id: string; timezone: string }, contact: { state?: string | null; companyState?: string | null; phone?: string | null; country?: string | null; status?: string; optedOut?: boolean; dnd?: boolean; email?: string | null; additionalEmails?: string[]; phoneType?: string | null; additionalPhones?: unknown; linkedinUrl?: string | null; bellwetherContactId?: string | null }, now = new Date()): Promise<CallGate> {
  const pending = await pendingFormBlock(user.id, user.timezone);
  if (pending) return { blocked: pending, warning: null };
  const suppressed = await suppressionReason({ ...contact, phoneType: contact.phoneType ?? 'direct' });
  if (suppressed) return { blocked: suppressed, warning: null };
  const hours = callingHours(contact, (await getSettings()).calling, now);
  return hours.allowed ? { blocked: null, warning: hours.warning } : { blocked: hours.warning, warning: null };
}
