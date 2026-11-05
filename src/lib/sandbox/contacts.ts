import { Prisma, type SandboxContact } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { getSettings } from '../settings';
import { crmDoNotContactTwin, crmMatch, internalOrBlocked, optedOutTwin, sandboxMatch, suppressionKeysOf } from './dedupe';
import { isRoleEmail, normalizeCrd, normalizeDomain, normalizeEmail, normalizeFirmName, normalizeLinkedin, parsePhone, PHONE_TYPES, sandboxSortName } from './normalize';
import { findSuppressed } from './suppression';
import { coldRef } from '../subject';
import { refuse, withSubjectLock, RefusedError, type GuardActor } from '../outreach/guard';
import { eraseContact as eraseTransition, PII_CLEARED, removeContact as removeTransition } from '../outreach/transitions';

export { PII_CLEARED };

/**
 * Cold contacts: added by hand, edited in place (cold outreach data belongs to Cadence), claimed,
 * assigned, removed and erased. Every write goes through the guard (src/lib/outreach/guard.ts) and is
 * audited on entity `sandbox_contact`. `guard` is the signed-in user; null is Cadence itself.
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

type Tx = Prisma.TransactionClient | typeof prisma;

/** Why this contact cannot be in Cold outreach, or null: suppressed, ours, blocked, Do not contact or already in the CRM, or here already. */
async function refusalFor(row: Parameters<typeof dedupeInputOf>[0], excludeId?: string, tx: Tx = prisma): Promise<string | null> {
  const input = dedupeInputOf(row);
  if (await findSuppressed(suppressionKeysOf(input), tx)) return 'This person is on the suppression list and cannot be contacted.';
  // B002: another record of the same person asked not to be contacted.
  if (await optedOutTwin(input, tx, excludeId)) return 'This person asked not to be contacted on another record, so they cannot be added.';
  const blocked = await internalOrBlocked(input, (await getSettings()).rules, tx);
  if (blocked?.kind === 'internal_contact') return 'This is one of our own addresses or firms.';
  if (blocked?.kind === 'blocked_account') return blocked.detail;
  // N003: the same name at the same firm is Do not contact in the CRM.
  const dnc = await crmDoNotContactTwin(input, tx);
  if (dnc) return `${dnc.name} is marked Do not contact in the CRM.`;
  const crm = await crmMatch(input, tx);
  if (crm) return `${crm.person.firstName} ${crm.person.lastName} is already in the CRM (same ${crm.matchedOn === 'linkedin_url' ? 'LinkedIn' : crm.matchedOn}).`.replace(/\s+/g, ' ');
  const dup = await sandboxMatch(input, tx, excludeId);
  if (dup) {
    const owner = dup.contact.ownerId ? await tx.user.findUnique({ where: { id: dup.contact.ownerId }, select: { name: true } }) : null;
    return `${dup.contact.firstName} ${dup.contact.lastName} is already in Cold outreach${owner ? `, owned by ${owner.name}` : ', unclaimed'}.`;
  }
  return null;
}

/** B139: a live contact with the same name at the same firm (by name or domain), which may be the same person. */
export async function sameNameAtFirm(c: { firstName: string; lastName: string; companyName: string | null; companyDomain: string | null }, tx: Tx = prisma, excludeId?: string): Promise<{ id: string; name: string; owner: string | null } | null> {
  const firm = normalizeFirmName(c.companyName);
  if (!firm && !c.companyDomain) return null;
  const rows = await tx.sandboxContact.findMany({
    where: { status: 'ACTIVE', firstName: { equals: c.firstName.trim(), mode: 'insensitive' }, lastName: { equals: c.lastName.trim(), mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, firstName: true, lastName: true, companyName: true, companyDomain: true, owner: { select: { name: true } } }, take: 10,
  });
  const hit = rows.find((r) => (firm && normalizeFirmName(r.companyName) === firm) || (c.companyDomain && r.companyDomain === c.companyDomain));
  return hit ? { id: hit.id, name: `${hit.firstName} ${hit.lastName}`.trim(), owner: hit.owner?.name ?? null } : null;
}

/**
 * A contact added by hand. Its owner is whoever added it, in their pod when they have one. It takes
 * the same lock as a Bellwether push, so a push racing it cannot make a twin (N025). The same name at
 * the same firm is refused with the other contact named, unless `addAnyway` (B139).
 */
export async function createContact(input: ContactInput, by: { id: string; podIds: string[]; ownsContacts: boolean }, actor: AuditActor, podId?: string | null, opts: { addAnyway?: boolean } = {}): Promise<ContactResult & { possibleDuplicate?: string }> {
  const parsed = contactData(input);
  if (!parsed.ok) return parsed;
  const d = parsed.data as Record<string, unknown>;
  const row = {
    bellwetherContactId: null, firstName: String(d.firstName), lastName: String(d.lastName), email: (d.email as string) ?? null, additionalEmails: [],
    phone: (d.phone as string) ?? null, phoneType: (d.phoneType as string) ?? (d.phone ? 'direct' : null), additionalPhones: [], linkedinUrl: (d.linkedinUrl as string) ?? null,
    individualCrd: (d.individualCrd as string) ?? null, companyName: (d.companyName as string) ?? null, companyDomain: (d.companyDomain as string) ?? null,
    companyCrd: (d.companyCrd as string) ?? null, companyPhone: null,
  };
  const pod = podId && by.podIds.includes(podId) ? podId : by.podIds.length === 1 ? by.podIds[0] : null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('bellwether-push'))`;
    const refused = await refusalFor(row, undefined, tx);
    if (refused) return { ok: false as const, error: refused };
    const twin = opts.addAnyway ? null : await sameNameAtFirm(row, tx);
    if (twin) return { ok: false as const, error: `${twin.name} at the same firm is already in Cold outreach${twin.owner ? `, owned by ${twin.owner}` : ', unclaimed'}. Open that contact, or add this one anyway if it is someone else.`, possibleDuplicate: twin.id };
    const created = await tx.sandboxContact.create({
      data: {
        ...(d as Prisma.SandboxContactUncheckedCreateInput), ...row, source: 'MANUAL', sortName: sandboxSortName(row.firstName, row.lastName), emailIsRole: isRoleEmail(row.email),
        country: (d.country as string) ?? 'US', ownerId: by.ownsContacts ? by.id : null, podId: by.ownsContacts ? pod : null, claimedAt: by.ownsContacts ? new Date() : null, firstClaimedAt: by.ownsContacts ? new Date() : null, createdById: by.id, lastActivityAt: new Date(),
      },
    });
    await logAudit({ entityType: 'sandbox_contact', entityId: created.id, action: 'created', actor, details: { source: 'MANUAL' } }, tx);
    return { ok: true as const, id: created.id };
  }, { timeout: 20_000 });
}

/** Edit a contact. Duplicate and Do not contact checks run when an identity field changes (N003). */
export async function updateContact(id: string, input: Partial<ContactInput>, actor: AuditActor, guard: GuardActor | null = null): Promise<ContactResult> {
  const parsed = contactData(input);
  if (!parsed.ok) return parsed;
  const r = await withSubjectLock(coldRef(id), guard, 'edit', async (tx) => {
    const contact = (await tx.sandboxContact.findUnique({ where: { id } }))!;
    const next = { ...contact, ...(parsed.data as Partial<SandboxContact>) };
    if (['email', 'phone', 'linkedinUrl', 'companyWebsite', 'companyName', 'firstName', 'lastName', 'individualCrd'].some((k) => (input as Record<string, unknown>)[k] !== undefined)) {
      const refused = await refusalFor(next, id, tx);
      if (refused) throw new RefusedError(refuse('not_allowed', refused));
    }
    const data = { ...parsed.data, ...(parsed.data.sortName === null ? { sortName: sandboxSortName(next.firstName, next.lastName) } : {}) };
    await tx.sandboxContact.update({ where: { id }, data });
    await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'edited', actor, details: { fields: Object.keys(parsed.data) } }, tx);
  }, { audit: actor });
  return r.ok ? { ok: true, id } : { ok: false, error: r.reason };
}

/** The first claim wins: a contact that has an owner by the time this runs is refused (B193 says who). */
export async function claimContact(id: string, user: { id: string; podIds: string[] } & Partial<Pick<GuardActor, 'role'>>, actor: AuditActor): Promise<ContactResult> {
  const guard: GuardActor | null = user.role ? { id: user.id, role: user.role, podIds: user.podIds } : null;
  const r = await withSubjectLock(coldRef(id), guard, 'claim', async (tx, s) => {
    if (s.kind !== 'cold') return;
    if (!guard && s.ownerId && s.ownerActive) throw new RefusedError(refuse('claimed', `${s.ownerName ?? 'Someone else'} claimed this contact first.`));
    const pod = s.podId && user.podIds.includes(s.podId) ? s.podId : user.podIds.length === 1 ? user.podIds[0] : null;
    await tx.sandboxContact.update({ where: { id }, data: { ownerId: user.id, podId: pod, claimedAt: new Date() } });
    await tx.sandboxContact.updateMany({ where: { id, firstClaimedAt: null }, data: { firstClaimedAt: new Date() } });
    await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'claimed', actor, details: { from: s.ownerId } }, tx);
  }, { audit: actor });
  return r.ok ? { ok: true, id } : { ok: false, error: r.code === 'claimed' ? r.reason.replace('owns this contact.', 'claimed this contact first.') : r.reason };
}

/** Give a contact to someone (or let go of it). The pod follows the new owner when they have one; open cold work follows too. */
export async function assignContact(id: string, toUserId: string | null, actor: AuditActor, podId?: string | null, guard: GuardActor | null = null): Promise<ContactResult> {
  const to = toUserId ? await prisma.user.findUnique({ where: { id: toUserId }, include: { pods: true } }) : null;
  if (toUserId && (!to || !to.active)) return { ok: false, error: 'That person is not an active Cadence user.' };
  const r = await withSubjectLock(coldRef(id), guard, toUserId ? 'assign' : 'release', async (tx, s) => {
    if (s.kind !== 'cold') return;
    let pod: string | null = null;
    if (to) {
      const theirs = to.pods.map((p) => p.podId);
      pod = podId && theirs.includes(podId) ? podId : s.podId && theirs.includes(s.podId) ? s.podId : theirs.length === 1 ? theirs[0] : null;
    }
    await tx.sandboxContact.update({ where: { id }, data: { ownerId: toUserId, podId: pod, claimedAt: toUserId ? new Date() : null } });
    if (toUserId) {
      await tx.sandboxContact.updateMany({ where: { id, firstClaimedAt: null }, data: { firstClaimedAt: new Date() } });
      await tx.nextAction.updateMany({ where: { sandboxContactId: id, personId: null, state: 'OPEN' }, data: { foUserId: toUserId } });
    }
    // The audit names the owner read under the lock, never a stale one (N076).
    await logAudit({ entityType: 'sandbox_contact', entityId: id, action: toUserId ? 'assigned' : 'released', actor, details: { from: s.ownerId, to: toUserId, podId: pod } }, tx);
  }, { audit: actor, toUserId });
  return r.ok ? { ok: true, id } : { ok: false, error: r.reason };
}

export async function setContactPod(id: string, podId: string | null, actor: AuditActor, guard: GuardActor | null = null): Promise<ContactResult> {
  const r = await withSubjectLock(coldRef(id), guard, 'edit', async (tx) => {
    await tx.sandboxContact.update({ where: { id }, data: { podId } });
    await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'pod_set', actor, details: { podId } }, tx);
  }, { audit: actor });
  return r.ok ? { ok: true, id } : { ok: false, error: r.reason };
}

/** A note, on an active contact only (B048): a moved one's notes belong on its People page. */
export async function addNote(id: string, body: string, author: { id: string; name: string }, actor: AuditActor, guard: GuardActor | null = null): Promise<ContactResult> {
  const text = body.trim();
  if (!text) return { ok: false, error: 'Write the note first.' };
  const r = await withSubjectLock(coldRef(id), guard, 'note', async (tx) => {
    await tx.sandboxNote.create({ data: { sandboxContactId: id, body: text.slice(0, 5000), authorId: author.id, authorName: author.name } });
    await tx.sandboxContact.update({ where: { id }, data: { lastActivityAt: new Date() } });
    await logAudit({ entityType: 'sandbox_contact', entityId: id, action: 'note_added', actor }, tx);
  }, { audit: actor });
  return r.ok ? { ok: true, id } : { ok: false, error: r.reason };
}

/** Removed by a user (with a reason) or by retention: personal data cleared everywhere; Bellwether reads `removed` and may push again. */
export async function removeContact(id: string, actor: AuditActor, now = new Date(), opts: { guard?: GuardActor | null; reason?: string | null } = {}): Promise<ContactResult> {
  const r = await removeTransition(id, { actor, now, guard: opts.guard ?? null, reason: opts.reason ?? null });
  if (!r.ok) return { ok: false, error: r.reason };
  return r.changed ? { ok: true, id } : { ok: false, error: 'This contact was opted out or removed meanwhile; nothing was changed.' };
}

/** Erase (admins): opted out for good, then every piece of personal data in Cadence goes. */
export async function eraseContact(id: string, actor: AuditActor & { id?: string | null }, now = new Date(), guard: GuardActor | null = null): Promise<{ ok: true; recordings: string[] } | { ok: false; error: string }> {
  const r = await eraseTransition(id, { actor, now, guard, createdById: actor.id ?? null });
  return r.ok ? r : { ok: false, error: r.reason };
}
