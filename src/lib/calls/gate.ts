import { prisma } from '../db';
import { suppressionReason } from '../sandbox/opt-out';
import { formsHeldBy } from './form-holder';
import { callTimeWords, FORM_FIRST } from './words';
import { attemptLimitBlock, callAttemptsToday, callingHoursBlock, callPlace, recordingNotice } from './hours';
import { importStatus } from './import';
import { twilioStatus } from './twilio';

/**
 * Whether Cadence's Call button may open the dialpad for this contact now, as the button is drawn: a
 * call of yours still waiting for its form, "Also in CRM", an opt-out or the suppression list.
 * Then the hour (8am to 9pm in the contact's zone), today's calls (at most 2), and the recording
 * notice where everyone must agree (owner, 13 Nov 2026; M02, M03). The click asks the full check again on the server (contactability, N008), since a
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

/** How long the import may go without a run before Cadence stops trusting it to open forms (M06). */
const IMPORT_STALE_MS = 10 * 60_000;
export const UNREAD_CALL = 'Cadence cannot read calls back from Twilio right now, so it cannot ask for the form of your last call. Log that call by hand (Log a call) first, then call again.';

/**
 * M06: "a form before your next call" holds while the import is down too. Twilio is set up, but its
 * import has failed twice running or not run for 10 minutes, and this rep pressed Call in the last two
 * hours with no call read back for it: that call is logged by hand first.
 */
export async function unreadCallBlock(userId: string, now = new Date()): Promise<string | null> {
  let configured = false;
  try { configured = twilioStatus().configured; } catch { configured = true; }
  if (!configured) return null;
  const s = await importStatus();
  const stale = s.failedInARow >= 2 || !s.lastRunAt || now.getTime() - Date.parse(s.lastRunAt) > IMPORT_STALE_MS;
  if (!stale) return null;
  const pressed = await prisma.callIntent.count({ where: { userId, callId: null, createdAt: { gte: new Date(now.getTime() - 2 * 3600_000) } } });
  return pressed ? UNREAD_CALL : null;
}

export async function callGate(user: { id: string; timezone: string }, contact: { id?: string; personId?: string | null; companyCountry?: string | null; state?: string | null; companyState?: string | null; phone?: string | null; country?: string | null; status?: string; optedOut?: boolean; dnd?: boolean; email?: string | null; additionalEmails?: string[]; phoneType?: string | null; additionalPhones?: unknown; linkedinUrl?: string | null; bellwetherContactId?: string | null; individualCrd?: string | null; crmMatchPersonId?: string | null; crmAutoPersonId?: string | null }, now = new Date()): Promise<CallGate> {
  const pending = await pendingFormBlock(user.id, user.timezone, now);
  if (pending) return { blocked: pending, warning: null };
  const unread = await unreadCallBlock(user.id, now);
  if (unread) return { blocked: unread, warning: null };
  // B053: outreach to a contact who is also in the CRM has stopped; Move to CRM is the way on.
  if (contact.crmMatchPersonId || contact.crmAutoPersonId) return { blocked: 'This person is in the CRM now, so their outreach has stopped. Move to CRM to work them there.', warning: null };
  // Every phone of every type is checked against the list (B001); the click checks again (N008).
  const suppressed = await suppressionReason({ ...contact, phoneType: contact.phoneType ?? 'unknown' });
  if (suppressed) return { blocked: suppressed, warning: null };
  const place = callPlace({ state: contact.state, country: contact.country }, { state: contact.companyState, country: contact.companyCountry });
  const hours = callingHoursBlock(place, now);
  if (hours) return { blocked: hours, warning: null };
  const subject = contact.personId ? { personId: contact.personId } : contact.id ? { sandboxContactId: contact.id } : null;
  const limit = subject ? attemptLimitBlock(await callAttemptsToday(subject, place, now), place) : null;
  if (limit) return { blocked: limit, warning: null };
  return { blocked: null, warning: recordingNotice(place) };
}
