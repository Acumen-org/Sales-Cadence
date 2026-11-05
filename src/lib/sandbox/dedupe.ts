import type { PersonCache, Prisma, SandboxContact } from '@prisma/client';
import { prisma } from '../db';
import { getSettings, type RulesSettings } from '../settings';
import { isInternalCompany } from '../internal-organizations';
import { isNeverProspect } from '../non-prospects';
import { isRoleEmail, normalizeDomain, normalizeFirmName, normalizeLinkedin, personalPhone, readExtraPhones, toE164, type ExtraPhone } from './normalize';
import { findSuppressed, type SuppressionKey } from './suppression';
import { markPersonDeleted, upsertPersonCache } from '../person-cache';
import type { TwentyClient } from '../twenty/client';

/**
 * The dedupe rules of the Bellwether contract (plan 14.6), in order; the first hit decides. Also
 * used for a contact added by hand and for Move to CRM's last look at the CRM, so a contact is
 * judged the same way wherever it enters.
 */

export type MatchedOn = 'bellwether_contact_id' | 'individual_crd' | 'email' | 'linkedin_url' | 'phone';

/** A contact as dedupe reads it: normalised already (normalize.ts). */
export type DedupeInput = {
  bellwetherContactId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  additionalEmails: string[];
  phone: string | null;
  phoneType: string;
  additionalPhones: ExtraPhone[];
  linkedinUrl: string | null;
  individualCrd: string | null;
  companyName: string | null;
  companyDomain: string | null;
  companyCrd: string | null;
  /** The firm's main office line (E.164), which never matches. */
  companyPhone: string | null;
};

export type DedupeVerdict =
  | { kind: 'suppressed'; key: SuppressionKey }
  /** The same person, by name and firm, is marked Do not contact (or opted out) in the CRM (N003). */
  | { kind: 'crm_do_not_contact'; person: { id: string; name: string } }
  | { kind: 'internal_contact' }
  | { kind: 'blocked_account'; detail: string }
  | { kind: 'already_in_crm'; matchedOn: MatchedOn; person: Pick<PersonCache, 'id' | 'ownerMemberId' | 'firstName' | 'lastName'>; /** Matched on an office or unknown line, which may be shared. */ sharedLine?: boolean }
  | { kind: 'duplicate_in_sandbox'; matchedOn: MatchedOn; contact: SandboxContact }
  | { kind: 'moved_tombstone'; contact: SandboxContact }
  | { kind: 'new' };

type Tx = Prisma.TransactionClient | typeof prisma;

const emailsOf = (c: DedupeInput) => [...new Set([c.email, ...c.additionalEmails].filter((e): e is string => Boolean(e)))];
const domainOfEmail = (e: string) => e.slice(e.lastIndexOf('@') + 1);

/** Every pushed phone with its own type: the primary one and each additional one. */
export function pushedPhones(c: Pick<DedupeInput, 'phone' | 'phoneType' | 'additionalPhones'>): ExtraPhone[] {
  const list: ExtraPhone[] = c.phone ? [{ number: c.phone, type: c.phoneType || 'unknown' }] : [];
  for (const p of c.additionalPhones) list.push({ number: p.number, type: p.type || 'unknown' });
  return list.filter((p) => toE164(p.number)).map((p) => ({ number: toE164(p.number)!, type: p.type }));
}

/**
 * Rule 2, wider in contract 1.1 (B001, B002): the email, any phone of any type, the LinkedIn URL, the
 * Bellwether id or the individual CRD is suppressed. A number someone asked us never to call stays
 * blocked however it is typed now; a shared line suppressed for one person (phone_subject) never
 * refuses anyone else.
 */
export function suppressionKeysOf(c: DedupeInput): SuppressionKey[] {
  const keys: SuppressionKey[] = emailsOf(c).map((value) => ({ kind: 'email' as const, value }));
  for (const p of pushedPhones(c)) if (!keys.some((k) => k.kind === 'phone' && k.value === p.number)) keys.push({ kind: 'phone', value: p.number });
  if (c.linkedinUrl) keys.push({ kind: 'linkedin', value: c.linkedinUrl });
  if (c.bellwetherContactId) keys.push({ kind: 'bellwether_id', value: c.bellwetherContactId });
  if (c.individualCrd) keys.push({ kind: 'individual_crd', value: c.individualCrd });
  return keys;
}

/**
 * Rule 2 also reads the opted-out contacts themselves (B002, PLAN 8.3): a personal email, the CRD,
 * the LinkedIn URL or a direct or mobile phone of a contact who asked not to be contacted counts as
 * suppressed, even where an old opt-out was never hashed under that key. Shared inboxes (info@)
 * never count: different people really do share them.
 */
export async function optedOutTwin(c: Pick<DedupeInput, 'email' | 'additionalEmails' | 'linkedinUrl' | 'individualCrd' | 'phone' | 'phoneType' | 'additionalPhones'>, tx: Tx = prisma, excludeId?: string): Promise<{ id: string; matchedOn: MatchedOn } | null> {
  const optedOut = { optedOutAt: { not: null }, piiClearedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) } satisfies Prisma.SandboxContactWhereInput;
  const emails = [...new Set([c.email, ...c.additionalEmails].filter((e): e is string => Boolean(e) && !isRoleEmail(e)))];
  if (emails.length) {
    const hit = await tx.sandboxContact.findFirst({ where: { ...optedOut, OR: [{ email: { in: emails } }, { additionalEmails: { hasSome: emails } }] }, select: { id: true } });
    if (hit) return { id: hit.id, matchedOn: 'email' };
  }
  if (c.individualCrd) {
    const hit = await tx.sandboxContact.findFirst({ where: { ...optedOut, individualCrd: c.individualCrd }, select: { id: true } });
    if (hit) return { id: hit.id, matchedOn: 'individual_crd' };
  }
  if (c.linkedinUrl) {
    const hit = await tx.sandboxContact.findFirst({ where: { ...optedOut, linkedinUrl: c.linkedinUrl }, select: { id: true } });
    if (hit) return { id: hit.id, matchedOn: 'linkedin_url' };
  }
  for (const p of pushedPhones({ phone: c.phone, phoneType: c.phoneType, additionalPhones: c.additionalPhones })) {
    if (!personalPhone(p.type)) continue;
    const rows = await tx.sandboxContact.findMany({ where: { ...optedOut, OR: [{ phone: p.number }, { additionalPhones: { array_contains: [{ number: p.number }] } }] }, select: { id: true, phone: true, phoneType: true, additionalPhones: true }, take: 10 });
    const hit = rows.find((r) => (r.phone === p.number && personalPhone(r.phoneType)) || readExtraPhones(r.additionalPhones).some((x) => x.number === p.number && personalPhone(x.type)));
    if (hit) return { id: hit.id, matchedOn: 'phone' };
  }
  return null;
}

/**
 * N003: a CRM person with the same first and last name at the same firm (by name, domain or CRD)
 * who is marked Do not contact in the CRM or opted out in Cadence. Such a contact is refused on add,
 * push and edit ("Dummy Nine is marked Do not contact in the CRM"), and never moved.
 */
export async function crmDoNotContactTwin(c: Pick<DedupeInput, 'firstName' | 'lastName' | 'companyName' | 'companyDomain' | 'companyCrd'>, tx: Tx = prisma): Promise<{ id: string; name: string } | null> {
  if (!c.firstName.trim() || !c.lastName.trim() || (!c.companyName && !c.companyDomain && !c.companyCrd)) return null;
  const people = await tx.personCache.findMany({
    where: { deletedAt: null, firstName: { equals: c.firstName.trim(), mode: 'insensitive' }, lastName: { equals: c.lastName.trim(), mode: 'insensitive' }, OR: [{ dnd: true }, { optedOut: true }] },
    select: { id: true, firstName: true, lastName: true, companyId: true, companyName: true }, take: 10,
  });
  if (!people.length) return null;
  const firm = normalizeFirmName(c.companyName);
  const companyIds = people.flatMap((p) => (p.companyId ? [p.companyId] : []));
  const companies = companyIds.length ? await tx.companyCache.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true, domain: true, raw: true } }) : [];
  const sameFirm = (p: (typeof people)[number]) => {
    if (firm && normalizeFirmName(p.companyName) === firm) return true;
    const co = companies.find((x) => x.id === p.companyId);
    if (!co) return false;
    return Boolean((firm && normalizeFirmName(co.name) === firm) || (c.companyDomain && normalizeDomain(co.domain) === c.companyDomain) || (c.companyCrd && String((co.raw as Record<string, unknown> | null)?.crd ?? '') === c.companyCrd));
  };
  const hit = people.find(sameFirm);
  return hit ? { id: hit.id, name: `${hit.firstName} ${hit.lastName}`.trim() } : null;
}

/** Rule 3: one of Acumen's own domains, or a firm an admin blocked or the never-prospect list names. */
export async function internalOrBlocked(c: DedupeInput, rules: RulesSettings, tx: Tx = prisma): Promise<DedupeVerdict | null> {
  const ownDomain = (d: string | null) => Boolean(d && rules.internalDomains.some((own) => d === own || d.endsWith(`.${own}`)));
  if (emailsOf(c).some((e) => ownDomain(domainOfEmail(e))) || ownDomain(c.companyDomain)) return { kind: 'internal_contact' };
  if (c.companyName && isInternalCompany({ name: c.companyName, domain: c.companyDomain }, rules)) return { kind: 'internal_contact' };
  const name = normalizeFirmName(c.companyName);
  if (c.companyName && isNeverProspect({ id: '', name: c.companyName, domain: c.companyDomain }, rules)) return { kind: 'blocked_account', detail: `${c.companyName} is on the never-prospect list.` };
  const blocked = await tx.blockedAccount.findMany({ select: { name: true, domain: true } });
  const hit = blocked.find((b) => (c.companyDomain && normalizeDomain(b.domain) === c.companyDomain) || (name && normalizeFirmName(b.name) === name));
  return hit ? { kind: 'blocked_account', detail: `${hit.name} is a blocked account in Cadence.` } : null;
}

/** Team members are not prospects: their addresses never make a CRM match. */
async function teamEmails(tx: Tx): Promise<Set<string>> {
  const users = await tx.user.findMany({ select: { email: true, aliases: true } });
  return new Set(users.flatMap((u) => [u.email, ...u.aliases]).filter((e) => e.includes('@')).map((e) => e.toLowerCase()));
}

/** The main line Twenty keeps for a company, when its record has one (any phone-like field). */
export function companyMainLine(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  for (const key of ['phone', 'phones', 'mainPhone', 'mainLine', 'officePhone']) {
    const v = r[key];
    if (typeof v === 'string') { const e = toE164(v); if (e) return e; }
    if (v && typeof v === 'object') {
      const p = v as { primaryPhoneNumber?: string; primaryPhoneCallingCode?: string };
      const e = toE164(`${p.primaryPhoneCallingCode ?? ''}${p.primaryPhoneNumber ?? ''}`) ?? toE164(p.primaryPhoneNumber);
      if (e) return e;
    }
  }
  return null;
}

/**
 * Rule 4: a live Twenty person in Cadence's copy (not deleted, not a team member) with the same
 * email, LinkedIn URL or phone. A pushed phone typed direct or mobile matches; one typed office or
 * unknown matches too unless it is the firm's main line (firm.phone, or the line of the matching
 * person's company in Twenty); main and toll_free never match.
 */
export async function crmMatch(c: DedupeInput, tx: Tx = prisma): Promise<Extract<DedupeVerdict, { kind: 'already_in_crm' }> | null> {
  return (await crmMatches(c, tx, { first: true }))[0] ?? null;
}

/**
 * Every CRM person rule 4 finds, in rule order (email, LinkedIn, phone), each once. The nightly
 * check reads past an auto-created person to a real one behind it (B156). Emails are compared
 * through the normalised copies, so capitals never hide a person (B073).
 */
export async function crmMatches(c: DedupeInput, tx: Tx = prisma, opts: { first?: boolean } = {}): Promise<Extract<DedupeVerdict, { kind: 'already_in_crm' }>[]> {
  const team = await teamEmails(tx);
  const live = (p: Pick<PersonCache, 'email'>) => !p.email || !team.has(p.email.toLowerCase());
  const select = { id: true, ownerMemberId: true, firstName: true, lastName: true, email: true, companyId: true } as const;
  const found: Extract<DedupeVerdict, { kind: 'already_in_crm' }>[] = [];
  /** True when the caller wants only the first. */
  const add = (matchedOn: MatchedOn, person: Pick<PersonCache, 'id' | 'ownerMemberId' | 'firstName' | 'lastName'>) => {
    if (!found.some((f) => f.person.id === person.id)) found.push({ kind: 'already_in_crm', matchedOn, person });
    return Boolean(opts.first);
  };
  const emails = emailsOf(c).map((e) => e.toLowerCase());
  if (emails.length) {
    const people = await tx.personCache.findMany({ where: { deletedAt: null, OR: [{ emailNorm: { in: emails } }, { additionalEmailsNorm: { hasSome: emails } }] }, select, orderBy: { id: 'asc' }, take: 10 });
    for (const p of people.filter(live)) if (add('email', p)) return found;
  }
  if (c.linkedinUrl) {
    const slug = c.linkedinUrl.replace('linkedin.com/in/', '');
    const people = await tx.personCache.findMany({ where: { deletedAt: null, linkedinUrl: { contains: slug, mode: 'insensitive' } }, select: { ...select, linkedinUrl: true }, orderBy: { id: 'asc' }, take: 10 });
    for (const p of people.filter((x) => live(x) && normalizeLinkedin(x.linkedinUrl) === c.linkedinUrl)) if (add('linkedin_url', p)) return found;
  }
  const candidates = pushedPhones(c).filter((p) => p.type === 'direct' || p.type === 'mobile' || p.type === 'office' || p.type === 'unknown');
  for (const p of candidates) {
    if (p.type !== 'direct' && p.type !== 'mobile' && c.companyPhone && p.number === c.companyPhone) continue;
    const people = await tx.personCache.findMany({ where: { deletedAt: null, OR: [{ phoneE164: p.number }, { additionalPhoneE164: p.number }] }, select, orderBy: { id: 'asc' }, take: 10 });
    for (const person of people) {
      if (!live(person)) continue;
      if (p.type === 'office' || p.type === 'unknown') {
        const company = person.companyId ? await tx.companyCache.findUnique({ where: { id: person.companyId }, select: { raw: true } }) : null;
        if (company && companyMainLine(company.raw) === p.number) continue;
      }
      const fresh = !found.some((f) => f.person.id === person.id);
      const stop = add('phone', person);
      // An office or unknown line may be shared: a refusal on it never opts the CRM person's colleagues out (N011).
      if (fresh && !personalPhone(p.type)) found[found.length - 1].sharedLine = true;
      if (stop) return found;
    }
  }
  return found;
}

/** Rule 5: an ACTIVE sandbox contact with the same Bellwether id, CRD, email, LinkedIn or direct/mobile phone. */
export async function sandboxMatch(c: DedupeInput, tx: Tx = prisma, excludeId?: string): Promise<{ matchedOn: MatchedOn; contact: SandboxContact } | null> {
  const active = { status: 'ACTIVE' as const, ...(excludeId ? { id: { not: excludeId } } : {}) };
  if (c.bellwetherContactId) {
    const hit = await tx.sandboxContact.findFirst({ where: { ...active, OR: [{ bellwetherContactId: c.bellwetherContactId }, { bellwetherAliases: { has: c.bellwetherContactId } }] } });
    if (hit) return { matchedOn: 'bellwether_contact_id', contact: hit };
  }
  if (c.individualCrd) {
    const hit = await tx.sandboxContact.findFirst({ where: { ...active, individualCrd: c.individualCrd } });
    if (hit) return { matchedOn: 'individual_crd', contact: hit };
  }
  const emails = emailsOf(c);
  if (emails.length) {
    const hit = await tx.sandboxContact.findFirst({ where: { ...active, OR: [{ email: { in: emails } }, { additionalEmails: { hasSome: emails } }] } });
    if (hit) return { matchedOn: 'email', contact: hit };
  }
  if (c.linkedinUrl) {
    const hit = await tx.sandboxContact.findFirst({ where: { ...active, linkedinUrl: c.linkedinUrl } });
    if (hit) return { matchedOn: 'linkedin_url', contact: hit };
  }
  for (const p of pushedPhones(c)) {
    if (p.type !== 'direct' && p.type !== 'mobile') continue;
    const rows = await tx.sandboxContact.findMany({ where: { ...active, OR: [{ phone: p.number }, { additionalPhones: { array_contains: [{ number: p.number }] } }] }, take: 10 });
    const hit = rows.find((r) => (r.phone === p.number && (r.phoneType === 'direct' || r.phoneType === 'mobile')) || readExtraPhones(r.additionalPhones).some((x) => x.number === p.number && (x.type === 'direct' || x.type === 'mobile')));
    if (hit) return { matchedOn: 'phone', contact: hit };
  }
  return null;
}

const TWIN_KIND: Record<MatchedOn, SuppressionKey['kind']> = { bellwether_contact_id: 'bellwether_id', individual_crd: 'individual_crd', email: 'email', linkedin_url: 'linkedin', phone: 'phone' };

/** Rules 2 to 5 for one contact (rule 1, within the request, is the caller's). */
export async function dedupeContact(c: DedupeInput, tx: Tx = prisma): Promise<DedupeVerdict> {
  const settings = await getSettings();
  const suppressed = await findSuppressed(suppressionKeysOf(c), tx);
  if (suppressed) return { kind: 'suppressed', key: suppressed };
  const twin = await optedOutTwin(c, tx);
  if (twin) return { kind: 'suppressed', key: { kind: TWIN_KIND[twin.matchedOn], value: '' } };
  const blocked = await internalOrBlocked(c, settings.rules, tx);
  if (blocked) return blocked;
  const dnc = await crmDoNotContactTwin(c, tx);
  if (dnc) return { kind: 'crm_do_not_contact', person: dnc };
  const crm = await crmMatch(c, tx);
  if (crm) return crm;
  const sandbox = await sandboxMatch(c, tx);
  if (sandbox) return { kind: 'duplicate_in_sandbox', ...sandbox };
  // A contact moved earlier whose person is not in Cadence's copy yet (a dry-run move, a sync lag).
  if (c.bellwetherContactId) {
    const tomb = await tx.sandboxContact.findFirst({ where: { status: 'MOVED', OR: [{ bellwetherContactId: c.bellwetherContactId }, { bellwetherAliases: { has: c.bellwetherContactId } }] } });
    if (tomb) return { kind: 'moved_tombstone', contact: tomb };
  }
  return { kind: 'new' };
}

/** Contacts per findPeople call: three keys each stay well inside Twenty's 60-row page. */
const LIVE_CHUNK = 20;
/** Bellwether waits 60 s for a push of up to 500; past this the copy decides for the rest. */
export const LIVE_BUDGET_MS = 20_000;

/**
 * Ask Twenty itself before a push is judged. Cadence's copy follows Twenty by webhook and a nightly
 * refresh, so a person added seconds ago, or whose webhook was lost, can be missing from it, and a
 * person deleted there can linger. The people Twenty has for these emails, phones and LinkedIn
 * profiles go into the copy, and a copy hit Twenty no longer has is marked deleted; crmMatch then
 * decides as before. When Twenty cannot be reached the copy decides on its own.
 */
export async function refreshCrmCopyFor(contacts: DedupeInput[], client: TwentyClient, budgetMs = LIVE_BUDGET_MS): Promise<{ found: number; gone: number; asked: number } | null> {
  const stats = { found: 0, gone: 0, asked: 0 };
  const deadline = Date.now() + budgetMs;
  // A call still running at the deadline (Twenty's own retries and rate-limit waits) is left behind.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${budgetMs} ms`)), budgetMs); });
  late.catch(() => undefined);
  const inTime = <T>(p: Promise<T>) => Promise.race([p, late]);
  try {
    for (let i = 0; i < contacts.length && Date.now() < deadline; i += LIVE_CHUNK) {
      const chunk = contacts.slice(i, i + LIVE_CHUNK);
      stats.asked += chunk.length;
      const found = await inTime(client.findPeople({ emails: chunk.flatMap(emailsOf), phones: chunk.flatMap((c) => pushedPhones(c).map((p) => p.number)), linkedinUrls: chunk.flatMap((c) => (c.linkedinUrl ? [c.linkedinUrl] : [])) }));
      for (const p of found) await upsertPersonCache(p);
      stats.found += found.length;
      // A copy hit Twenty did not return may be gone there, or matched on a field findPeople does not search.
      const live = new Set(found.map((p) => p.id));
      for (let round = 0; round < 3; round++) {
        const hits = (await Promise.all(chunk.map((c) => crmMatch(c)))).flatMap((m) => (m && !live.has(m.person.id) ? [m.person.id] : []));
        if (!hits.length) break;
        const kept = new Map((await inTime(client.getPeopleByIds([...new Set(hits)]))).map((p) => [p.id, p]));
        for (const id of new Set(hits)) {
          live.add(id);
          const p = kept.get(id);
          if (p && !p.deletedAt) continue;
          await markPersonDeleted(id, p?.deletedAt ? new Date(p.deletedAt) : new Date());
          stats.gone++;
        }
      }
    }
    if (stats.asked < contacts.length) console.warn(`[bellwether] Twenty was slow: ${stats.asked} of ${contacts.length} contacts asked live; Cadence's copy decides for the rest`);
    return stats;
  } catch (err) {
    console.warn('[bellwether] Twenty could not be asked; Cadence\'s copy decides', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A Twenty person with the same first and last name at a company with the same domain or CRD. */
export async function possibleCrmMatch(c: DedupeInput, tx: Tx = prisma): Promise<string | null> {
  if (!c.companyDomain && !c.companyCrd) return null;
  const people = await tx.personCache.findMany({ where: { deletedAt: null, firstName: { equals: c.firstName, mode: 'insensitive' }, lastName: { equals: c.lastName, mode: 'insensitive' }, companyId: { not: null } }, select: { id: true, companyId: true }, take: 10 });
  if (!people.length) return null;
  const companies = await tx.companyCache.findMany({ where: { id: { in: people.map((p) => p.companyId!) } }, select: { id: true, domain: true, raw: true } });
  const same = companies.find((co) => (c.companyDomain && normalizeDomain(co.domain) === c.companyDomain) || (c.companyCrd && String((co.raw as Record<string, unknown> | null)?.crd ?? '') === c.companyCrd));
  return same ? people.find((p) => p.companyId === same.id)?.id ?? null : null;
}
