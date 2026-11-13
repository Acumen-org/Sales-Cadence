import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { optOutContact, optOutPerson as optOutCrmPerson, optOutRow, type OptOutOptions, type OptOutSource } from '../outreach/transitions';
import type { GuardActor } from '../outreach/guard';
import { addSuppressions, contactKeys, findSuppressed, type SuppressionKey } from './suppression';
import { isRoleEmail, normalizeLinkedin } from './normalize';

/**
 * The one opt-out path (plan section 13, decision 23), now the state machine's (cold outreach PLAN
 * 8.5, src/lib/outreach/transitions.ts). The call form's "Asked not to be contacted", the contact
 * page's Opt out, an entry on the suppression list, Bellwether's Do not contact and erasure all come
 * here, so every one of them sets the contact's status to opted_out with statusChangedAt in the same
 * write, and Bellwether's status sync reads it.
 */

export type { OptOutSource };
/** A row's subject as the call form knows it. */
export type RowSubject = { personId?: string | null; sandboxContactId?: string | null };
type Opts = { source: OptOutSource; actor: AuditActor; reason?: string | null; now?: Date; createdById?: string | null; endSequences?: boolean; guard?: GuardActor | null };

const asOptions = (o: Opts): OptOutOptions => ({ source: o.source, actor: o.actor, reason: o.reason ?? null, now: o.now, createdById: o.createdById ?? null, endSequences: o.endSequences, guard: o.guard ?? null });

/** Opt a cold contact out. A contact already moved to the CRM opts its person out instead. */
export async function optOutSandboxContact(contactId: string, opts: Opts): Promise<{ changed: boolean }> {
  const r = await optOutContact(contactId, asOptions(opts));
  return { changed: r.ok && r.changed };
}

/**
 * Opt a CRM person out: Cadence's flag, their own keys on the suppression list, their open next
 * actions and running sequences, what Bellwether reads for them, and the CRM's own Do not contact
 * and Next Action (D6).
 */
export async function optOutPerson(personId: string, opts: Opts): Promise<{ changed: boolean }> {
  const r = await optOutCrmPerson(personId, asOptions(opts));
  return { changed: r.ok && r.changed };
}

/** Opt out whichever subject a row is about. `refused` says why it could not be done (M01), never swallowed. */
export async function optOutSubject(subject: RowSubject, opts: Opts): Promise<{ changed: boolean; refused?: string }> {
  const r = await optOutRow(subject, asOptions(opts));
  return r.ok ? { changed: r.changed } : { changed: false, refused: r.reason };
}

/**
 * An admin adds an email, phone, LinkedIn URL or individual CRD to the suppression list (Settings >
 * Sandbox). The entry is kept as a hash, and every cold contact and CRM person it matches is opted out.
 */
export async function suppressValue(key: SuppressionKey, opts: { actor: AuditActor; createdById?: string | null }): Promise<{ added: boolean; optedOut: number }> {
  const added = (await addSuppressions([key], { reason: 'do_not_contact', source: 'suppression_list', createdById: opts.createdById ?? null })) > 0;
  const contacts = await matchingSandboxContacts(key);
  let optedOut = 0;
  for (const c of contacts) if ((await optOutSandboxContact(c.id, { source: 'suppression_list', actor: opts.actor, createdById: opts.createdById })).changed) optedOut += 1;
  const people = await matchingPeople(key);
  for (const p of people) if ((await optOutPerson(p.id, { source: 'suppression_list', actor: opts.actor, createdById: opts.createdById })).changed) optedOut += 1;
  await logAudit({ entityType: 'settings', entityId: 'suppression', action: 'suppression_added', actor: opts.actor, details: { kind: key.kind, optedOut } });
  return { added, optedOut };
}

export async function matchingSandboxContacts(key: SuppressionKey): Promise<{ id: string }[]> {
  const live = { status: { in: ['ACTIVE', 'MOVED'] as ('ACTIVE' | 'MOVED')[] } };
  if (key.kind === 'email') return prisma.sandboxContact.findMany({ where: { ...live, OR: [{ email: key.value }, { additionalEmails: { has: key.value } }] }, select: { id: true } });
  if (key.kind === 'linkedin') return prisma.sandboxContact.findMany({ where: { ...live, linkedinUrl: key.value }, select: { id: true } });
  if (key.kind === 'individual_crd') return prisma.sandboxContact.findMany({ where: { ...live, individualCrd: key.value }, select: { id: true } });
  if (key.kind === 'bellwether_id') return prisma.sandboxContact.findMany({ where: { ...live, OR: [{ bellwetherContactId: key.value }, { bellwetherAliases: { has: key.value } }] }, select: { id: true } });
  if (key.kind === 'phone_subject') return key.subjectId ? prisma.sandboxContact.findMany({ where: { ...live, id: key.subjectId }, select: { id: true } }) : [];
  const direct = await prisma.sandboxContact.findMany({ where: { ...live, phone: key.value }, select: { id: true, additionalPhones: true } });
  const extra = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "SandboxContact" WHERE status IN ('ACTIVE','MOVED') AND "additionalPhones"::text LIKE ${`%${key.value}%`}`;
  const ids = new Set([...direct.map((c) => c.id), ...extra.map((c) => c.id)]);
  return [...ids].map((id) => ({ id }));
}

/** CRM people a suppression key identifies. A shared inbox is not a person (backfills.ts). */
export async function matchingPeople(key: SuppressionKey): Promise<{ id: string }[]> {
  const live = { deletedAt: null };
  // Twenty keeps an address as typed: compare the normalised copies, so capitals never hide a person (B011).
  if (key.kind === 'email') return isRoleEmail(key.value) ? [] : prisma.personCache.findMany({ where: { ...live, OR: [{ emailNorm: key.value }, { additionalEmailsNorm: { has: key.value } }] }, select: { id: true } });
  if (key.kind === 'phone') return prisma.personCache.findMany({ where: { ...live, OR: [{ phoneE164: key.value }, { additionalPhoneE164: key.value }] }, select: { id: true } });
  if (key.kind === 'linkedin') {
    const people = await prisma.personCache.findMany({ where: { ...live, linkedinUrl: { contains: key.value.replace('linkedin.com/in/', ''), mode: 'insensitive' } }, select: { id: true, linkedinUrl: true } });
    return people.filter((p) => normalizeLinkedin(p.linkedinUrl) === key.value);
  }
  return [];
}

/**
 * Whether a contact may be called or written to, as drawn on a page: not opted out, not Do not
 * contact, and none of its keys on the list, every phone of any type included (B001). The Call
 * button asks the full check again at the click (src/lib/outreach/contactability.ts, N008).
 */
export async function suppressionReason(c: Parameters<typeof contactKeys>[0] & { status?: string; optedOut?: boolean; dnd?: boolean; individualCrd?: string | null }): Promise<string | null> {
  if (c.status === 'OPTED_OUT' || c.optedOut) return 'This contact asked not to be contacted.';
  if (c.dnd) return 'This contact is marked Do not contact in the CRM.';
  const keys = contactKeys(c, { allPhones: true });
  if (c.individualCrd) keys.push({ kind: 'individual_crd', value: c.individualCrd });
  const hit = await findSuppressed(keys);
  return hit ? `This contact's ${hit.kind === 'bellwether_id' ? 'Bellwether record' : hit.kind === 'individual_crd' ? 'CRD' : hit.kind} is on the suppression list.` : null;
}
