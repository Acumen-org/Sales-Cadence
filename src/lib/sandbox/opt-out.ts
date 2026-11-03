import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { exitEnrollment, OCCUPYING_STATUSES, setPersonFlags } from '../engine/enrollment';
import { addSuppressions, contactKeys, findSuppressed, type SuppressionKey } from './suppression';
import { normalizeLinkedin } from './normalize';

/**
 * The one opt-out path (plan section 13, decision 23). The call form's "Asked not to be contacted",
 * the contact page's Opt out, an entry on the suppression list and erasure all come here, so every
 * one of them sets the pushed contact's status to opted_out with statusChangedAt in the same write,
 * and Bellwether's status sync reads it.
 */

export type OptOutSource = 'call_form' | 'contact_page' | 'suppression_list' | 'skip_reason' | 'erase';
export type SubjectRef = { personId?: string | null; sandboxContactId?: string | null };

/** Opt a sandbox contact out. A contact already moved to the CRM opts its person out instead. */
export async function optOutSandboxContact(contactId: string, opts: { source: OptOutSource; actor: AuditActor; reason?: string | null; now?: Date; createdById?: string | null }): Promise<{ changed: boolean }> {
  const now = opts.now ?? new Date();
  const contact = await prisma.sandboxContact.findUnique({ where: { id: contactId } });
  if (!contact) return { changed: false };
  if (contact.status === 'MOVED' && contact.twentyPersonId) return optOutPerson(contact.twentyPersonId, opts);
  const keys = contactKeys(contact);
  const changed = await prisma.$transaction(async (tx) => {
    await addSuppressions(keys, { reason: 'opted_out', sandboxContactId: contact.id, createdById: opts.createdById ?? null }, tx);
    if (contact.status === 'OPTED_OUT' || contact.status === 'REMOVED') return false;
    await tx.sandboxContact.update({ where: { id: contact.id }, data: { status: 'OPTED_OUT', optedOutAt: now, optOutReason: opts.reason ?? opts.source, statusChangedAt: now } });
    await tx.nextAction.updateMany({ where: { sandboxContactId: contact.id, personId: null, state: 'OPEN' }, data: { state: 'CANCELLED', closedAt: now } });
    await logAudit({ entityType: 'sandbox_contact', entityId: contact.id, action: 'opted_out', actor: opts.actor, details: { source: opts.source, reason: opts.reason ?? null } }, tx);
    return true;
  });
  const active = await prisma.enrollment.findMany({ where: { sandboxContactId: contact.id, status: { in: OCCUPYING_STATUSES } }, select: { id: true } });
  for (const e of active) await exitEnrollment(e.id, { reason: 'opted_out', actor: opts.actor, now });
  return { changed };
}

/**
 * Opt a CRM person out: Cadence's own flag (Twenty's dnd is the team's to set), the suppression
 * list, their running sequence, and what Bellwether reads for them: the tombstone of a contact
 * that was moved from the sandbox, or a push refused because they were already in the CRM.
 */
export async function optOutPerson(personId: string, opts: { source: OptOutSource; actor: AuditActor; reason?: string | null; now?: Date; createdById?: string | null; endSequences?: boolean }): Promise<{ changed: boolean }> {
  const now = opts.now ?? new Date();
  const person = await prisma.personCache.findUnique({ where: { id: personId } });
  if (!person) return { changed: false };
  const changed = !person.optedOut;
  if (changed) await setPersonFlags(personId, { optedOut: true }, opts.actor);
  const keys = contactKeys({ email: person.email, additionalEmails: person.additionalEmails, phone: person.phoneE164, phoneType: 'direct', additionalPhones: person.additionalPhoneE164 ? [{ number: person.additionalPhoneE164, type: 'direct' }] : [], linkedinUrl: person.linkedinUrl });
  await prisma.$transaction(async (tx) => {
    await addSuppressions(keys, { reason: 'opted_out', personId, createdById: opts.createdById ?? null }, tx);
    await tx.sandboxContact.updateMany({ where: { twentyPersonId: personId, optedOutAt: null }, data: { optedOutAt: now, optOutReason: opts.reason ?? opts.source, statusChangedAt: now } });
    await tx.bellwetherRefusal.updateMany({ where: { crmPersonId: personId, status: { not: 'opted_out' } }, data: { status: 'opted_out', statusChangedAt: now } });
  });
  if (opts.endSequences !== false) {
    const active = await prisma.enrollment.findMany({ where: { personId, status: { in: OCCUPYING_STATUSES } }, select: { id: true } });
    for (const e of active) await exitEnrollment(e.id, { reason: 'opted_out', actor: opts.actor, now });
  }
  return { changed };
}

/** Opt out whichever subject a row is about. */
export async function optOutSubject(subject: SubjectRef, opts: Parameters<typeof optOutPerson>[1]): Promise<{ changed: boolean }> {
  if (subject.sandboxContactId && !subject.personId) return optOutSandboxContact(subject.sandboxContactId, opts);
  if (subject.personId) return optOutPerson(subject.personId, opts);
  return { changed: false };
}

/**
 * An admin adds an email, phone or LinkedIn URL to the suppression list (Settings > Sandbox). The
 * entry is kept as a hash, and every sandbox contact and CRM person it matches is opted out.
 */
export async function suppressValue(key: SuppressionKey, opts: { actor: AuditActor; createdById?: string | null }): Promise<{ added: boolean; optedOut: number }> {
  const added = (await addSuppressions([key], { reason: 'do_not_contact', createdById: opts.createdById ?? null })) > 0;
  const contacts = await matchingSandboxContacts(key);
  let optedOut = 0;
  for (const c of contacts) if ((await optOutSandboxContact(c.id, { source: 'suppression_list', actor: opts.actor, createdById: opts.createdById })).changed) optedOut += 1;
  const people = await matchingPeople(key);
  for (const p of people) if ((await optOutPerson(p.id, { source: 'suppression_list', actor: opts.actor, createdById: opts.createdById })).changed) optedOut += 1;
  await logAudit({ entityType: 'settings', entityId: 'suppression', action: 'suppression_added', actor: opts.actor, details: { kind: key.kind, optedOut } });
  return { added, optedOut };
}

async function matchingSandboxContacts(key: SuppressionKey): Promise<{ id: string }[]> {
  const live = { status: { in: ['ACTIVE', 'MOVED'] as ('ACTIVE' | 'MOVED')[] } };
  if (key.kind === 'email') return prisma.sandboxContact.findMany({ where: { ...live, OR: [{ email: key.value }, { additionalEmails: { has: key.value } }] }, select: { id: true } });
  if (key.kind === 'linkedin') return prisma.sandboxContact.findMany({ where: { ...live, linkedinUrl: key.value }, select: { id: true } });
  if (key.kind === 'bellwether_id') return prisma.sandboxContact.findMany({ where: { ...live, OR: [{ bellwetherContactId: key.value }, { bellwetherAliases: { has: key.value } }] }, select: { id: true } });
  const direct = await prisma.sandboxContact.findMany({ where: { ...live, phone: key.value }, select: { id: true, additionalPhones: true } });
  const extra = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "SandboxContact" WHERE status IN ('ACTIVE','MOVED') AND "additionalPhones"::text LIKE ${`%${key.value}%`}`;
  const ids = new Set([...direct.map((c) => c.id), ...extra.map((c) => c.id)]);
  return [...ids].map((id) => ({ id }));
}

async function matchingPeople(key: SuppressionKey): Promise<{ id: string }[]> {
  const live = { deletedAt: null };
  if (key.kind === 'email') return prisma.personCache.findMany({ where: { ...live, OR: [{ email: key.value }, { additionalEmails: { has: key.value } }] }, select: { id: true } });
  if (key.kind === 'phone') return prisma.personCache.findMany({ where: { ...live, OR: [{ phoneE164: key.value }, { additionalPhoneE164: key.value }] }, select: { id: true } });
  if (key.kind === 'linkedin') {
    const people = await prisma.personCache.findMany({ where: { ...live, linkedinUrl: { contains: key.value.replace('linkedin.com/in/', ''), mode: 'insensitive' } }, select: { id: true, linkedinUrl: true } });
    return people.filter((p) => normalizeLinkedin(p.linkedinUrl) === key.value);
  }
  return [];
}

/** Whether a contact may be called or written to: not opted out and not on the list. */
export async function suppressionReason(c: Parameters<typeof contactKeys>[0] & { status?: string; optedOut?: boolean; dnd?: boolean }): Promise<string | null> {
  if (c.status === 'OPTED_OUT' || c.optedOut) return 'This contact asked not to be contacted.';
  if (c.dnd) return 'This contact is marked do not contact in Twenty.';
  const hit = await findSuppressed(contactKeys(c));
  return hit ? `This contact's ${hit.kind === 'bellwether_id' ? 'Bellwether record' : hit.kind} is on the suppression list.` : null;
}

