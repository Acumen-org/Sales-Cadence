import { prisma } from '../db';
import { suppressionReason } from '../sandbox/opt-out';
import { formsHeldBy } from './form-holder';
import { callTimeWords, FORM_FIRST } from './words';

/**
 * Whether Cadence's Call button may open the dialpad for this contact now, as the button is drawn: a
 * call of yours still waiting for its form, "Also in CRM", an opt-out or the suppression list.
 * Calling hours are not checked (owner, 10 Nov 2026: where a contact is cannot be known). The click asks the full check again on the server (contactability, N008), since a
 * page left open goes stale. The dialpad itself is outside Cadence's reach (decision 14).
 */

export type CallGate = { blocked: string | null; warning: string | null };

/** The rep's oldest call waiting for its form (their own, or one handed to them: N010), named the way the waiting notice names it, with its day and zone (N096). */
export async function pendingFormBlock(userId: string, timezone: string, now = new Date()): Promise<string | null> {
  const pending = await prisma.callLog.findFirst({ where: formsHeldBy(userId), orderBy: { formDueAt: 'asc' }, include: { person: { select: { firstName: true, lastName: true } }, sandboxContact: { select: { firstName: true, lastName: true } } } });
  if (!pending) return null;
  const who = pending.person ?? pending.sandboxContact;
  // A removed contact's name was cleared: it reads as one (B008).
  const name = who ? `${who.firstName} ${who.lastName}`.trim() || 'a removed contact' : (pending.direction === 'INBOUND' ? pending.fromNumber : pending.toNumber) ?? 'an unknown number';
  return `${FORM_FIRST} ${pending.direction === 'INBOUND' ? 'call from' : 'call with'} ${name} (${callTimeWords(pending.startedAt ?? pending.createdAt, timezone, now)}) first.`;
}

export async function callGate(user: { id: string; timezone: string }, contact: { state?: string | null; companyState?: string | null; phone?: string | null; country?: string | null; status?: string; optedOut?: boolean; dnd?: boolean; email?: string | null; additionalEmails?: string[]; phoneType?: string | null; additionalPhones?: unknown; linkedinUrl?: string | null; bellwetherContactId?: string | null; individualCrd?: string | null; crmMatchPersonId?: string | null; crmAutoPersonId?: string | null }): Promise<CallGate> {
  const pending = await pendingFormBlock(user.id, user.timezone);
  if (pending) return { blocked: pending, warning: null };
  // B053: outreach to a contact who is also in the CRM has stopped; Move to CRM is the way on.
  if (contact.crmMatchPersonId || contact.crmAutoPersonId) return { blocked: 'This person is in the CRM now, so their outreach has stopped. Move to CRM to work them there.', warning: null };
  // Every phone of every type is checked against the list (B001); the click checks again (N008).
  const suppressed = await suppressionReason({ ...contact, phoneType: contact.phoneType ?? 'unknown' });
  if (suppressed) return { blocked: suppressed, warning: null };
  return { blocked: null, warning: null };
}
