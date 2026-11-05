import { Prisma, type SandboxContact } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { getSettings } from '../settings';
import { exitEnrollment, OCCUPYING_STATUSES } from '../engine/enrollment';
import { crmMatch, internalOrBlocked, sandboxMatch } from './dedupe';
import { isRoleEmail, normalizeCrd, normalizeDomain, normalizeEmail, normalizeLinkedin, parsePhone, PHONE_TYPES, sandboxSortName } from './normalize';
import { findSuppressed, addSuppressions, contactKeys } from './suppression';
import { optOutSandboxContact } from './opt-out';
import { suppressionKeysOf } from './dedupe';

/**
 * Sandbox contacts: added by hand, edited in place (sandbox data belongs to Cadence), claimed,
 * assigned, removed and erased. Every write is audited on entity `sandbox_contact`.
 */

export type ContactInput = {
  firstName: string;
  lastName: string;
  jobTitle?: string | null;
  email?: string | null;
  phone?: string | null;
  phoneType?: string | null;
  linkedinUrl?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  companyName?: string | null;
  companyWebsite?: string | null;
  companyCrd?: string | null;
  individualCrd?: string | null;
  productInterest?: string[];
};

export type ContactResult = { ok: true; id: string } | { ok: false; error: string };

const clean = (v: string | null | undefined) => (v ?? '').trim() || null;

/** The columns an input sets, normalised, or the first problem in plain words. */
export function contactData(input: Partial<ContactInput>): { ok: true; data: Prisma.SandboxContactUpdateInput & Record<string, unknown> } | { ok: false; error: string } {
  const data: Record<string, unknown> = {};
  if (input.firstName !== undefined) { if (!input.firstName.trim()) return { ok: false, error: 'Enter a first name.' }; data.firstName = input.firstName.trim().slice(0, 100); }
  if (input.lastName !== undefined) { if (!input.lastName.trim()) return { ok: false, error: 'Enter a last name.' }; data.lastName = input.lastName.trim().slice(0, 100); }
  if (input.jobTitle !== undefined) data.jobTitle = clean(input.jobTitle)?.slice(0, 200) ?? null;
  const country = (clean(input.country) ?? 'US').toUpperCase().slice(0, 2);
  if (input.country !== undefined) data.country = country;
  if (input.email !== undefined) {
    const e = clean(input.email);
    if (e && !normalizeEmail(e)) return { ok: false, error: 'That email address is not valid.' };
    data.email = e ? normalizeEmail(e) : null;
    data.emailVerification = e ? 'unknown' : null;
    data.emailIsRole = isRoleEmail(data.email as string | null);
    data.badEmail = false;
  }
  if (input.phone !== undefined) {
    const p = clean(input.phone);
    const parsed = p ? parsePhone(p, country) : null;
    if (p && !parsed) return { ok: false, error: 'That phone number could not be read. Include the area code.' };
    data.phone = parsed?.e164 ?? null;
    data.phoneExtension = parsed?.extension ?? null;
    data.badPhone = false;
  }
  if (input.phoneType !== undefined) data.phoneType = (PHONE_TYPES as readonly string[]).includes(String(input.phoneType)) ? input.phoneType : 'unknown';
  if (input.linkedinUrl !== undefined) {
    const l = clean(input.linkedinUrl);
    if (l && !normalizeLinkedin(l)) return { ok: false, error: 'Enter a LinkedIn profile address (linkedin.com/in/...).' };
    data.linkedinUrl = l ? normalizeLinkedin(l) : null;
  }
  if (input.city !== undefined) data.city = clean(input.city)?.slice(0, 100) ?? null;
  if (input.state !== undefined) data.state = clean(input.state)?.slice(0, 100) ?? null;
  if (input.companyName !== undefined) data.companyName = clean(input.companyName)?.slice(0, 200) ?? null;
  if (input.companyWebsite !== undefined) { const w = clean(input.companyWebsite); data.companyWebsite = w; data.companyDomain = normalizeDomain(w); }
  if (input.companyCrd !== undefined) data.companyCrd = normalizeCrd(input.companyCrd);
  if (input.individualCrd !== undefined) data.individualCrd = normalizeCrd(input.individualCrd);
  if (input.productInterest !== undefined) data.productInterest = [...new Set(input.productInterest.map((p) => p.trim().toUpperCase()).filter(Boolean))];
  if (data.firstName !== undefined || data.lastName !== undefined) data.sortName = null; // recomputed by the caller
  return { ok: true, data: data as Prisma.SandboxContactUpdateInput & Record<string, unknown> };
}

const dedupeInputOf = (c: Pick<SandboxContact, 'bellwetherContactId' | 'firstName' | 'lastName' | 'email' | 'additionalEmails' | 'phone' | 'phoneType' | 'additionalPhones' | 'linkedinUrl' | 'individualCrd' | 'companyName' | 'companyDomain' | 'companyCrd' | 'companyPhone'>) => ({
  bellwetherContactId: c.bellwetherContactId, firstName: c.firstName, lastName: c.lastName, email: c.email, additionalEmails: c.additionalEmails,
  phone: c.phone, phoneType: c.phoneType ?? 'unknown', additionalPhones: Array.isArray(c.additionalPhones) ? (c.additionalPhones as { number: string; type: string }[]) : [],
  linkedinUrl: c.linkedinUrl, individualCrd: c.individualCrd, companyName: c.companyName, companyDomain: c.companyDomain, companyCrd: c.companyCrd, companyPhone: c.companyPhone,
});

/** Why this contact cannot be in the sandbox, or null: suppressed, ours, blocked, in the CRM, or here already. */
async function refusalFor(row: Parameters<typeof dedupeInputOf>[0], excludeId?: string): Promise<string | null> {
  const input = dedupeInputOf(row);
  if (await findSuppressed(suppressionKeysOf(input))) return 'This person is on the suppression list and cannot be contacted.';
  const blocked = await internalOrBlocked(input, (await getSettings()).rules);
  if (blocked?.kind === 'internal_contact') return 'This is one of our own addresses or firms.';
  if (blocked?.kind === 'blocked_account') return blocked.detail;
  const crm = await crmMatch(input);
  if (crm) return `${crm.person.firstName} ${crm.person.lastName} is already in the CRM (same ${crm.matchedOn === 'linkedin_url' ? 'LinkedIn' : crm.matchedOn}).`.replace(/\s+/g, ' ');
  const dup = await sandboxMatch(input, prisma, excludeId);
  if (dup) {
    const owner = dup.contact.ownerId ? await prisma.user.findUnique({ where: { id: dup.contact.ownerId }, select: { name: true } }) : null;
    return `${dup.contact.firstName} ${dup.contact.lastName} is already in the sandbox${owner ? `, owned by ${owner.name}` : ', unclaimed'}.`;
  }
  return null;
}

/** A contact added by hand. Its owner is whoever added it, in their pod when they have one. */
export async function createContact(input: ContactInput, by: { id: string; podIds: string[]; ownsContacts: boolean }, actor: AuditActor, podId?: string | null): Promise<ContactResult> {
  const parsed = contactData(input);
  if (!parsed.ok) return parsed;
  const d = parsed.data as Record<string, unknown>;
  const row = {
    bellwetherContactId: null, firstName: String(d.firstName), lastName: String(d.lastName), email: (d.email as string) ?? null, additionalEmails: [],
    phone: (d.phone as string) ?? null, phoneType: (d.phoneType as string) ?? (d.phone ? 'direct' : null), additionalPhones: [], linkedinUrl: (d.linkedinUrl as string) ?? null,
    individualCrd: (d.individualCrd as string) ?? null, companyName: (d.companyName as string) ?? null, companyDomain: (d.companyDomain as string) ?? null,
    companyCrd: (d.companyCrd as string) ?? null, companyPhone: null,
  };
  const refused = await refusalFor(row);
  if (refused) return { ok: false, error: refused };
  const pod = podId && by.podIds.includes(podId) ? podId : by.podIds.length === 1 ? by.podIds[0] : null;
  const created = await prisma.sandboxContact.create({
    data: {
      ...(d as Prisma.SandboxContactUncheckedCreateInput), ...row, source: 'MANUAL', sortName: sandboxSortName(row.firstName, row.lastName),
      country: (d.country as string) ?? 'US', ownerId: by.ownsContacts ? by.id : null, podId: by.ownsContacts ? pod : null, claimedAt: by.ownsContacts ? new Date() : null, createdById: by.id,
    },
  });
  await logAudit({ entityType: 'sandbox_contact', entityId: created.id, action: 'created', actor, details: { source: 'MANUAL' } });
  return { ok: true, id: created.id };
}

export async function updateContact(id: string, input: Partial<ContactInput>, actor: AuditActor): Promise<ContactResult> {
  const contact = await prisma.sandboxContact.findUnique({ where: { id } });
  if (!contact || contact.status !== 'ACTIVE') return { ok: false, error: 'This contact is no longer in the sandbox.' };
  const parsed = contactData(input);
  if (!parsed.ok) return parsed;
  const next = { ...contact, ...(parsed.data as Partial<SandboxContact>) };
  if (input.email !== undefined || input.phone !== undefined || input.linkedinUrl !== undefined || input.companyWebsite !== undefined || input.companyName !== undefined) {
    const refused = await refusalFor(next, id);
    if (refused) return { ok: false, error: refused };
  }
  const data = { ...parsed.data, ...(parsed.data.sortName === null ? { sortName: sandboxSortName(next.firstName, next.lastName) } : {}) };
  await prisma.sandboxContact.update({ where: { id }, data });
  await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'edited', actor, details: { fields: Object.keys(parsed.data) } });
  return { ok: true, id };
}

/** The first claim wins: a contact that has an owner by the time this runs is refused. */
export async function claimContact(id: string, user: { id: string; podIds: string[] }, actor: AuditActor): Promise<ContactResult> {
  const pod = user.podIds.length === 1 ? user.podIds[0] : null;
  const r = await prisma.sandboxContact.updateMany({ where: { id, ownerId: null, status: 'ACTIVE' }, data: { ownerId: user.id, podId: pod, claimedAt: new Date() } });
  if (!r.count) {
    const c = await prisma.sandboxContact.findUnique({ where: { id }, include: { owner: { select: { name: true } } } });
    return { ok: false, error: c?.owner ? `${c.owner.name} claimed this contact first.` : 'This contact is no longer in the sandbox.' };
  }
  await prisma.sandboxContact.updateMany({ where: { id, firstClaimedAt: null }, data: { firstClaimedAt: new Date() } });
  await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'claimed', actor });
  return { ok: true, id };
}

/** Give a contact to someone (or let go of it). The pod follows the new owner when they have one. */
export async function assignContact(id: string, toUserId: string | null, actor: AuditActor, podId?: string | null): Promise<ContactResult> {
  const contact = await prisma.sandboxContact.findUnique({ where: { id } });
  if (!contact || contact.status !== 'ACTIVE') return { ok: false, error: 'This contact is no longer in the sandbox.' };
  let pod: string | null = null;
  if (toUserId) {
    const to = await prisma.user.findUnique({ where: { id: toUserId }, include: { pods: true } });
    if (!to || !to.active) return { ok: false, error: 'That person is not an active Cadence user.' };
    const theirs = to.pods.map((p) => p.podId);
    pod = podId && theirs.includes(podId) ? podId : contact.podId && theirs.includes(contact.podId) ? contact.podId : theirs.length === 1 ? theirs[0] : null;
  }
  await prisma.sandboxContact.update({ where: { id }, data: { ownerId: toUserId, podId: pod, claimedAt: toUserId ? new Date() : null } });
  // Open sandbox work follows the contact to its new owner.
  if (toUserId) {
    await prisma.sandboxContact.updateMany({ where: { id, firstClaimedAt: null }, data: { firstClaimedAt: new Date() } });
    await prisma.nextAction.updateMany({ where: { sandboxContactId: id, personId: null, state: 'OPEN' }, data: { foUserId: toUserId } });
  }
  await logAudit({ entityType: 'sandbox_contact', entityId: id, action: toUserId ? 'assigned' : 'released', actor, details: { from: contact.ownerId, to: toUserId, podId: pod } });
  return { ok: true, id };
}

export async function setContactPod(id: string, podId: string | null, actor: AuditActor): Promise<ContactResult> {
  await prisma.sandboxContact.update({ where: { id }, data: { podId } });
  await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'pod_set', actor, details: { podId } });
  return { ok: true, id };
}

export async function addNote(id: string, body: string, author: { id: string; name: string }, actor: AuditActor): Promise<ContactResult> {
  const text = body.trim();
  if (!text) return { ok: false, error: 'Write the note first.' };
  await prisma.sandboxNote.create({ data: { sandboxContactId: id, body: text.slice(0, 5000), authorId: author.id, authorName: author.name } });
  await prisma.sandboxContact.update({ where: { id }, data: { lastActivityAt: new Date() } });
  await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'note_added', actor });
  return { ok: true, id };
}

/** Personal data a tombstone drops: what is left is ids, status and dates. */
export const PII_CLEARED: Prisma.SandboxContactUpdateInput = {
  firstName: '', lastName: '', sortName: null, jobTitle: null, email: null, emailVerification: null, additionalEmails: [], phone: null, phoneType: null,
  phoneExtension: null, additionalPhones: [], linkedinUrl: null, city: null, state: null, individualCrd: null, designations: [], tags: [],
  companyName: null, companyDomain: null, companyWebsite: null, companyCrd: null, companyCity: null, companyState: null, companyPhone: null,
  companyAumUsd: null, companyEmployees: null, bellwetherUrl: null, sourceNote: null, pushedByEmail: null, optOutReason: null,
};

async function endSandboxWork(id: string, reason: string, actor: AuditActor, now: Date) {
  const active = await prisma.enrollment.findMany({ where: { sandboxContactId: id, personId: null, status: { in: OCCUPYING_STATUSES } }, select: { id: true } });
  for (const e of active) await exitEnrollment(e.id, { reason, actor, now });
  await prisma.nextAction.updateMany({ where: { sandboxContactId: id, personId: null, state: 'OPEN' }, data: { state: 'CANCELLED', closedAt: now } });
}

/** Removed by a user: out of the sandbox, personal data cleared; Bellwether reads `removed` and may push again. */
export async function removeContact(id: string, actor: AuditActor, now = new Date()): Promise<ContactResult> {
  const contact = await prisma.sandboxContact.findUnique({ where: { id } });
  if (!contact || contact.status !== 'ACTIVE') return { ok: false, error: 'This contact is no longer in the sandbox.' };
  await endSandboxWork(id, 'removed', actor, now);
  await prisma.sandboxContact.update({ where: { id }, data: { ...PII_CLEARED, status: 'REMOVED', statusChangedAt: now, piiClearedAt: now, removedById: actor.type === 'USER' ? actor.id ?? null : null } });
  await prisma.sandboxNote.deleteMany({ where: { sandboxContactId: id } });
  await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'removed', actor });
  return { ok: true, id };
}

/**
 * Erase (an admin, for a GDPR or California request): opted out first, so the suppression hashes
 * refuse the person forever and Bellwether reads `opted_out`; then every piece of personal data in
 * Cadence goes. Recordings live in Twilio, where Cadence's key cannot delete; their ids are returned
 * for an admin to delete there.
 */
export async function eraseContact(id: string, actor: AuditActor & { id?: string | null }, now = new Date()): Promise<{ ok: true; recordings: string[] } | { ok: false; error: string }> {
  const contact = await prisma.sandboxContact.findUnique({ where: { id } });
  if (!contact) return { ok: false, error: 'Contact not found.' };
  if (contact.status === 'MOVED') return { ok: false, error: 'This contact is in the CRM now. Erase the person in Twenty.' };
  await addSuppressions(contactKeys(contact, { allPhones: true }), { reason: 'erased', source: 'erase', sandboxContactId: id, createdById: actor.id ?? null });
  if (contact.status === 'ACTIVE') await optOutSandboxContact(id, { source: 'erase', actor, now, createdById: actor.id ?? null });
  await endSandboxWork(id, 'opted_out', actor, now);
  const calls = await prisma.callLog.findMany({ where: { sandboxContactId: id }, select: { id: true, recordingSid: true, sandboxContactId: true, toNumber: true, fromNumber: true, direction: true } });
  for (const call of calls) {
    await prisma.callLog.update({ where: { id: call.id }, data: call.direction === 'OUTBOUND' ? { toNumber: null } : { fromNumber: null } });
  }
  await prisma.sandboxNote.deleteMany({ where: { sandboxContactId: id } });
  await prisma.sandboxEmail.deleteMany({ where: { sandboxContactId: id } });
  await prisma.callForm.updateMany({ where: { call: { sandboxContactId: id } }, data: { notes: null } });
  await prisma.sandboxContact.update({ where: { id }, data: { ...PII_CLEARED, status: contact.status === 'REMOVED' ? 'REMOVED' : 'OPTED_OUT', piiClearedAt: now, statusChangedAt: now } });
  await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'erased', actor, details: { recordings: calls.filter((c) => c.recordingSid).length } });
  return { ok: true, recordings: calls.map((c) => c.recordingSid).filter((s): s is string => Boolean(s)) };
}
