import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { optOutContact, optOutPerson } from '../outreach/transitions';
import { apiError, MAX_BATCH, type ApiError } from './bellwether-api';
import { isRoleEmail, normalizeCrd, normalizeEmail, toE164 } from './normalize';
import { recordRefusal } from './status';
import { addSuppressions, type SuppressionKey } from './suppression';

/**
 * POST /v1/contacts/suppress (contract v1.1, cold outreach PLAN 7.3, B003): a Do not contact set in
 * Bellwether reaches Cadence. Each contact comes as its Bellwether id and keys (emails, phones, the
 * individual CRD); Cadence opts out the cold contacts, moved contacts and CRM people that match, the
 * CRM's own Do not contact included (D6), and answers for each id, in request order:
 *   opted_out          something was opted out now;
 *   already_opted_out  everything that matched was opted out already;
 *   not_found          Cadence has nobody it covers.
 * Its keys go on the suppression list either way, so a later push of the person is refused. Phones
 * come without a type, so each is kept for the people it matched only (phone_subject): a firm's line
 * never blocks a colleague (N011). It only adds to v1: a v1 caller never sends it.
 */

export type SuppressItem = { bellwetherContactId: string; emails: string[]; phones: string[]; individualCrd: string | null };
export type SuppressRequest = { contacts: SuppressItem[]; reason: string | null; note: string | null; actor: { email: string; name: string | null } };
export type SuppressResult = { bellwetherContactId: string; result: 'opted_out' | 'already_opted_out' | 'not_found'; cadenceContactId: string | null; crmPersonId: string | null };

const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && Boolean(x.trim()) && x.length <= 254).slice(0, max) : []);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function validateSuppress(body: unknown): SuppressRequest | ApiError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const fields: { path: string; problem: string }[] = [];
  const actor = (b.actor && typeof b.actor === 'object' ? b.actor : null) as Record<string, unknown> | null;
  const email = typeof actor?.email === 'string' ? actor.email.trim().toLowerCase() : '';
  if (!actor) fields.push({ path: 'actor', problem: 'actor is required.' });
  else if (email.length < 3 || email.length > 254) fields.push({ path: 'actor.email', problem: 'actor.email is required (3 to 254 characters).' });
  if (!Array.isArray(b.contacts) || !b.contacts.length) fields.push({ path: 'contacts', problem: 'contacts must be a list of 1 to 500 contacts.' });
  const contacts: SuppressItem[] = [];
  if (Array.isArray(b.contacts)) {
    b.contacts.forEach((raw, i) => {
      const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const id = typeof c.bellwetherContactId === 'string' ? c.bellwetherContactId : '';
      if (!id || id.length > 200) { fields.push({ path: `contacts[${i}].bellwetherContactId`, problem: 'Each contact needs its bellwetherContactId (1 to 200 characters).' }); return; }
      contacts.push({ bellwetherContactId: id, emails: strings(c.emails, 20), phones: strings(c.phones, 20), individualCrd: typeof c.individualCrd === 'string' || typeof c.individualCrd === 'number' ? String(c.individualCrd) : null });
    });
  }
  if (fields.length) return apiError(422, 'invalid_request', fields.map((f) => f.problem).join(' '), { fields });
  if (contacts.length > MAX_BATCH) return apiError(413, 'payload_too_large', `More than ${MAX_BATCH} contacts in one request.`);
  return { contacts, reason: text(b.reason, 200), note: text(b.note, 2000), actor: { email, name: text(actor!.name, 200) } };
}

export async function suppressContacts(req: SuppressRequest, now = new Date()): Promise<{ results: SuppressResult[] }> {
  const actor: AuditActor = { type: 'WEBHOOK', label: `bellwether:${req.actor.email}` };
  const why = req.note ?? 'Do not contact in Bellwether';
  const results: SuppressResult[] = [];
  for (const item of req.contacts) {
    const emails = [...new Set(item.emails.map((e) => normalizeEmail(e)).filter((e): e is string => Boolean(e) && !isRoleEmail(e)))];
    const phones = [...new Set(item.phones.map((p) => toE164(p)).filter((p): p is string => Boolean(p)))];
    const crd = normalizeCrd(item.individualCrd);
    const id = item.bellwetherContactId;

    // Who Cadence has for this person: the contact(s) the id answers for, and live ones with their own email or CRD.
    const contacts = await prisma.sandboxContact.findMany({
      where: { OR: [{ bellwetherContactId: id }, { bellwetherAliases: { has: id } }, ...(emails.length || crd ? [{ status: { in: ['ACTIVE', 'MOVED'] as ('ACTIVE' | 'MOVED')[] }, OR: [...(emails.length ? [{ email: { in: emails } }, { additionalEmails: { hasSome: emails } }] : []), ...(crd ? [{ individualCrd: crd }] : [])] }] : [])] },
      select: { id: true, status: true, optedOutAt: true, twentyPersonId: true, bellwetherContactId: true, bellwetherAliases: true, statusChangedAt: true },
    });
    const refusal = await prisma.bellwetherRefusal.findUnique({ where: { bellwetherContactId: id } });
    const people = await prisma.personCache.findMany({ where: { deletedAt: null, OR: [...(emails.length ? [{ emailNorm: { in: emails } }, { additionalEmailsNorm: { hasSome: emails } }] : []), ...(refusal?.crmPersonId ? [{ id: refusal.crmPersonId }] : [])] }, select: { id: true, optedOut: true } });

    // The keys go on the list whatever matched; a phone only for the people it belongs to.
    const subjects = [...contacts.map((c) => (c.status === 'MOVED' && c.twentyPersonId ? c.twentyPersonId : c.id)), ...people.map((p) => p.id)];
    const keys: SuppressionKey[] = [{ kind: 'bellwether_id', value: id }, ...emails.map((value) => ({ kind: 'email' as const, value })), ...(crd ? [{ kind: 'individual_crd' as const, value: crd }] : []), ...phones.flatMap((value) => subjects.map((subjectId) => ({ kind: 'phone_subject' as const, value, subjectId })))];
    await addSuppressions(keys, { reason: 'do_not_contact', source: 'bellwether' });

    let changed = false;
    for (const c of contacts) {
      const r = await optOutContact(c.id, { source: 'bellwether', actor, reason: why, now });
      if (r.ok && r.changed) changed = true;
    }
    for (const p of people) {
      const r = await optOutPerson(p.id, { source: 'bellwether', actor, reason: why, now });
      if (r.ok && r.changed) changed = true;
    }
    const answering = contacts.filter((c) => c.bellwetherContactId === id || c.bellwetherAliases.includes(id)).sort((a, b) => b.statusChangedAt.getTime() - a.statusChangedAt.getTime())[0] ?? contacts[0] ?? null;
    const personId = people[0]?.id ?? answering?.twentyPersonId ?? null;
    const found = contacts.length > 0 || people.length > 0 || Boolean(refusal);
    // An id no cold contact answers for still reads opted_out from now on (contract 14.12).
    if (found && !contacts.some((c) => c.bellwetherContactId === id || c.bellwetherAliases.includes(id))) await recordRefusal(id, 'opted_out', personId, now, 'bellwether_id');
    results.push({ bellwetherContactId: id, result: !found ? 'not_found' : changed || (refusal && refusal.status !== 'opted_out') ? 'opted_out' : 'already_opted_out', cadenceContactId: answering?.id ?? null, crmPersonId: personId });
  }
  await logAudit({ entityType: 'bellwether', entityId: 'suppress', action: 'suppress_received', actor, details: { contacts: req.contacts.length, optedOut: results.filter((r) => r.result === 'opted_out').length, notFound: results.filter((r) => r.result === 'not_found').length, reason: req.reason } });
  return { results };
}
