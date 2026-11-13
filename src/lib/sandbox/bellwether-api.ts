import { createHash, timingSafeEqual } from 'node:crypto';
import { Prisma, type SandboxContact } from '@prisma/client';
import { databaseNow, prisma } from '../db';
import { env } from '../env';
import { logAudit, type AuditActor } from '../audit';
import { getSettings, getTwentyConnection } from '../settings';
import { twentyPersonUrl } from '../twenty/urls';
import { getTwentyClient, type TwentyClient } from '../twenty';
import { lockColdIn } from '../outreach/guard';
import { ownerRefusal, podForOwner } from '../outreach/transfer';
import { applyTwentyAnswer, askTwentyFor, dedupeContact, possibleCrmMatch, possibleSandboxTwin, pushedPhones, refreshCrmCopyFor, type DedupeInput, type MatchedOn, type TwentyAnswer } from './dedupe';
import { cutAtWord, hasControl, isRoleEmail, normalizeCountry, normalizeCrd, normalizeDomain, normalizeEmail, normalizeFirmName, normalizeLinkedin, parsePhone, personalPhone, PHONE_TYPES, plainName, plainText, readExtraPhones, sandboxSortName, stripControl, toE164, type ExtraPhone } from './normalize';
import { hasUsableEmail } from './ready';
import { boundedText } from '../http-body';
import { cadenceUrlOf, recordRefusal, type RefusalMatch } from './status';

/**
 * The Bellwether push API (contract: "Shared contract with Bellwether" in
 * docs/outreach-sandbox-plan.md, section 14). Bellwether pushes contacts, never firms, into Cold
 * outreach; Cadence dedupes them against the cold contacts and the CRM and answers per contact. The
 * check endpoint (14.14) runs exactly the same pipeline inside a transaction it rolls back, so it
 * answers what the push would and writes nothing (B069, B073).
 *
 * Contract 1.1 (cold outreach PLAN 7.3) only adds: a request carrying X-Cadence-Contract: 1.1 gets
 * the new fields and warning codes, and one without it gets exactly the v1 answer (`pushAnswerFor`).
 */

export const MAX_BATCH = 500;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const PRODUCT_VALUES = ['PHH', 'TOLLBOOTH', 'ACUBOOTH', 'GLYNAC'] as const;
const EEA_UK = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB']);

// ---------------------------------------------------------------------------
// Contract versions (PLAN 7.3)
// ---------------------------------------------------------------------------

/** The contract versions Cadence speaks; ping lists them to every caller. */
export const CONTRACTS = ['1', '1.1'] as const;
export type Contract = (typeof CONTRACTS)[number];
/** The version a request reads: 1.1 only when it says so in X-Cadence-Contract. */
export const contractOf = (header: string | null | undefined): Contract => (header?.trim() === '1.1' ? '1.1' : '1');

/** The warning codes of contract v1 (14.8); the rest are 1.1's. */
export const V1_WARNINGS = new Set(['email_dropped', 'phone_dropped', 'linkedin_dropped', 'product_dropped', 'pod_ignored', 'possible_crm_match']);

// ---------------------------------------------------------------------------
// Errors, auth and limits
// ---------------------------------------------------------------------------

export type ApiError = { status: number; code: string; message: string; fields?: { path: string; problem: string }[]; retryAfter?: number };
export const apiError = (status: number, code: string, message: string, extra: Partial<ApiError> = {}): ApiError => ({ status, code, message, ...extra });

function sameKey(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** 503 when Cadence has no key or the sandbox is off; 401 when the key is missing or wrong. */
export async function authorize(header: string | null): Promise<ApiError | null> {
  const e = env();
  const current = e.BELLWETHER_API_KEY?.trim();
  if (!current) return apiError(503, 'integration_disabled', 'The Bellwether integration is not configured in Cadence.');
  if (!(await getSettings()).sandbox.enabled) return apiError(503, 'integration_disabled', 'Cold outreach is switched off in Cadence.');
  const given = (header ?? '').trim();
  const previous = e.BELLWETHER_API_KEY_PREVIOUS?.trim();
  const ok = Boolean(given) && (sameKey(given, current) || (previous ? sameKey(given, previous) : false));
  return ok ? null : apiError(401, 'unauthorized', 'The X-Cadence-Api-Key header is missing or wrong.');
}

/** 30 push (and check, and suppress) requests and 60 status (and owners) requests a minute per key, per process. */
const LIMITS = { push: 30, status: 60 } as const;
const g = globalThis as unknown as { __bellwetherWindows?: Map<string, number[]> };
export function rateLimit(kind: keyof typeof LIMITS, key: string, now = Date.now()): ApiError | null {
  const windows = (g.__bellwetherWindows ??= new Map<string, number[]>());
  const id = `${kind}:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
  const recent = (windows.get(id) ?? []).filter((t: number) => now - t < 60_000);
  if (recent.length >= LIMITS[kind]) {
    windows.set(id, recent);
    return apiError(429, 'rate_limited', `More than ${LIMITS[kind]} ${kind} requests in a minute.`, { retryAfter: Math.max(1, Math.ceil((60_000 - (now - recent[0])) / 1000)) });
  }
  recent.push(now);
  windows.set(id, recent);
  return null;
}
export function resetRateLimits() { g.__bellwetherWindows = new Map(); }

/** The raw body, refused when it is not JSON, too large or does not parse. */
export async function readJson(req: Request): Promise<{ raw: string; body: unknown } | ApiError> {
  const type = req.headers.get('content-type') ?? '';
  if (!/application\/json/i.test(type)) return apiError(415, 'unsupported_media_type', 'Send Content-Type: application/json.');
  // Q21: never read whole first, length header or not.
  const raw = await boundedText(req, MAX_BODY_BYTES);
  if (raw === null) return apiError(413, 'payload_too_large', 'The body is over 2 MB.');
  try { return { raw, body: JSON.parse(raw) }; } catch { return apiError(400, 'invalid_json', 'The body is not JSON.'); }
}

// ---------------------------------------------------------------------------
// Validation and normalisation (14.4, 14.5)
// ---------------------------------------------------------------------------

export type Envelope = { pushedBy: { email: string; name: string | null; microsoftObjectId: string | null }; assignTo: { email: string } | null; pod: string | null; contacts: unknown[] };

/** Text within its limit, trimmed, control characters out; null when empty or over the limit. */
const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = stripControl(v).trim();
  return t && t.length <= max ? t : null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateEnvelope(body: unknown, opts: { idempotencyKey: string | null; requireKey: boolean }): Envelope | ApiError {
  const fields: { path: string; problem: string }[] = [];
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (opts.requireKey && !opts.idempotencyKey) fields.push({ path: 'Idempotency-Key', problem: 'The Idempotency-Key header is required.' });
  else if (opts.requireKey && !UUID.test(opts.idempotencyKey ?? '')) fields.push({ path: 'Idempotency-Key', problem: 'The Idempotency-Key must be a UUID.' });
  const pushedBy = (b.pushedBy && typeof b.pushedBy === 'object' ? b.pushedBy : null) as Record<string, unknown> | null;
  const email = typeof pushedBy?.email === 'string' ? pushedBy.email.trim().toLowerCase() : '';
  if (!pushedBy) fields.push({ path: 'pushedBy', problem: 'pushedBy is required.' });
  else if (email.length < 3 || email.length > 254) fields.push({ path: 'pushedBy.email', problem: 'pushedBy.email is required (3 to 254 characters).' });
  let assignTo: Envelope['assignTo'] = null;
  if (b.assignTo !== undefined && b.assignTo !== null) {
    const a = (typeof b.assignTo === 'object' ? b.assignTo : {}) as Record<string, unknown>;
    const ae = typeof a.email === 'string' ? a.email.trim().toLowerCase() : '';
    if (!ae) fields.push({ path: 'assignTo.email', problem: 'assignTo needs an email.' });
    else assignTo = { email: ae };
  }
  if (!Array.isArray(b.contacts) || !b.contacts.length) fields.push({ path: 'contacts', problem: 'contacts must be a list of 1 to 500 contacts.' });
  if (fields.length) return apiError(422, 'invalid_request', fields.map((f) => f.problem).join(' '), { fields });
  const contacts = b.contacts as unknown[];
  if (contacts.length > MAX_BATCH) return apiError(413, 'payload_too_large', `More than ${MAX_BATCH} contacts in one push.`);
  return {
    pushedBy: { email, name: str(pushedBy!.name, 200), microsoftObjectId: str(pushedBy!.microsoftObjectId, 100) },
    assignTo,
    pod: str(b.pod, 100),
    contacts,
  };
}

export type Warning = { code: string; field: string | null; crmPersonId: string | null; detail: string };

/** A pushed contact, normalised: what dedupe and the sandbox row read. */
export type PushContact = DedupeInput & {
  bellwetherContactId: string;
  jobTitle: string | null;
  emailVerification: string;
  phoneExtension: string | null;
  city: string | null;
  state: string | null;
  country: string;
  designations: string[];
  productInterest: string[];
  tags: string[];
  notes: string | null;
  bellwetherUrl: string | null;
  source: string | null;
  collectedAt: string | null;
  doNotContact: boolean;
  companyWebsite: string | null;
  companyCity: string | null;
  companyState: string | null;
  companyCountry: string | null;
  companyAumUsd: string | null;
  companyEmployees: number | null;
  warnings: Warning[];
};

const warn = (code: string, field: string | null, detail: string): Warning => ({ code, field, crmPersonId: null, detail });
const present = (v: unknown) => v !== undefined && v !== null && v !== '';

/** An optional text field; one that is not text or is over its limit is left out with a warning (B072). */
function optional(v: unknown, field: string, max: number, warnings: Warning[]): string | null {
  if (!present(v)) return null;
  const t = typeof v === 'string' ? stripControl(v).trim() : '';
  if (!t) { if (typeof v !== 'string') warnings.push(warn('value_defaulted', field, `${field} was not text, so it was left out.`)); return null; }
  if (t.length > max) { warnings.push(warn('value_defaulted', field, `${field} was over ${max} characters, so it was left out.`)); return null; }
  return t;
}

/** A list of short texts; items that are not text or are too long, and items past the limit, are left out with a warning. */
function textList(v: unknown, field: string, maxItems: number, maxLen: number, warnings: Warning[]): string[] {
  if (!present(v)) return [];
  if (!Array.isArray(v)) { warnings.push(warn('value_defaulted', field, `${field} was not a list, so it was left out.`)); return []; }
  const items = v.map((x) => (typeof x === 'string' ? stripControl(x).trim() : '')).filter(Boolean);
  const kept = items.filter((x) => x.length <= maxLen).slice(0, maxItems);
  if (kept.length < v.length) warnings.push(warn('value_defaulted', field, `${v.length - kept.length} of the ${field} ${v.length - kept.length === 1 ? 'was' : 'were'} empty, too long or past the first ${maxItems}, and left out.`));
  return kept;
}

/** One of a closed set, read case-insensitively (B072). Missing: the default, silently; unknown: the default, with a warning. */
function oneOf(v: unknown, allowed: readonly string[], fallback: string, field: string, warnings: Warning[]): string {
  if (!present(v)) return fallback;
  const value = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (allowed.includes(value)) return value;
  warnings.push(warn('value_defaulted', field, `Cadence does not know ${field} "${String(v).slice(0, 40)}", so it used "${fallback}".`));
  return fallback;
}

/** Bellwether's own Do not contact: true, "true", "yes" or 1 (B072). */
const truthy = (v: unknown) => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|1)$/i.test(v.trim()));

/** Decimal(24,2) holds 22 whole digits; an Int column holds up to 2,147,483,647 (B012). */
const MAX_AUM = 1e22 - 1;
const MAX_INT = 2_147_483_647;

export function normalizeContact(raw: unknown): { ok: true; contact: PushContact } | { ok: false; id: string; detail: string } {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = typeof c.bellwetherContactId === 'string' ? c.bellwetherContactId : '';
  // B170: an id of spaces is no id. The id is kept exactly as sent: Bellwether compares it so.
  if (!id.trim()) return { ok: false, id, detail: 'bellwetherContactId is empty' };
  if (id.length > 200) return { ok: false, id, detail: 'bellwetherContactId is longer than 200 characters' };
  // Echoed without them: a NUL can be stored nowhere, the push's own answer included.
  if (hasControl(id)) return { ok: false, id: stripControl(id), detail: 'bellwetherContactId has control characters' };
  // B114: a name never carries HTML, markdown brackets or control characters.
  const name = (field: 'firstName' | 'lastName') => (typeof c[field] === 'string' ? plainName(c[field] as string) : '');
  const firstName = name('firstName');
  if (!firstName) return { ok: false, id, detail: 'firstName is empty' };
  if (firstName.length > 100) return { ok: false, id, detail: 'firstName is longer than 100 characters' };
  const lastName = name('lastName');
  if (!lastName) return { ok: false, id, detail: 'lastName is empty' };
  if (lastName.length > 100) return { ok: false, id, detail: 'lastName is longer than 100 characters' };
  const firm = (c.firm && typeof c.firm === 'object' ? c.firm : null) as Record<string, unknown> | null;
  if (!firm) return { ok: false, id, detail: 'firm is missing' };
  const firmName = typeof firm.name === 'string' ? plainText(firm.name).replace(/\s+/g, ' ') : '';
  if (!firmName) return { ok: false, id, detail: 'firm.name is empty' };
  if (firmName.length > 200) return { ok: false, id, detail: 'firm.name is longer than 200 characters' };

  const warnings: Warning[] = [];
  // B072: "United Kingdom" is GB, never US or "UN"; a country Cadence does not know falls back to US and says so.
  let country = 'US';
  if (present(c.country)) {
    const known = typeof c.country === 'string' ? normalizeCountry(c.country) : null;
    if (known) country = known;
    else warnings.push(warn('value_defaulted', 'country', `Cadence does not know the country "${String(c.country).slice(0, 40)}", so it used US.`));
  }
  let email: string | null = null;
  if (present(c.email)) {
    email = typeof c.email === 'string' && c.email.length <= 254 ? normalizeEmail(c.email) : null;
    if (!email) warnings.push(warn('email_dropped', 'email', 'The email address was not valid and was left out.'));
  }
  const extraEmails = textList(c.additionalEmails, 'additionalEmails', 5, 254, warnings);
  const additionalEmails = [...new Set(extraEmails.map((e) => normalizeEmail(e)).filter((e): e is string => Boolean(e) && e !== email))];
  if (extraEmails.some((e) => !normalizeEmail(e))) warnings.push(warn('email_dropped', 'additionalEmails', 'An additional email address was not valid and was left out.'));
  const verification = oneOf(c.emailVerification, ['valid', 'risky', 'unknown', 'invalid'], 'unknown', 'emailVerification', warnings);
  let phoneType = oneOf(c.phoneType, PHONE_TYPES, 'unknown', 'phoneType', warnings);
  const companyPhone = typeof firm.phone === 'string' ? toE164(firm.phone, country) : null;
  let phone: string | null = null;
  let phoneExtension = typeof c.phoneExtension === 'string' && /^\d{1,10}$/.test(c.phoneExtension.trim()) ? c.phoneExtension.trim() : null;
  if (present(c.phone)) {
    const parsed = typeof c.phone === 'string' && c.phone.length <= 40 ? parsePhone(c.phone, country) : null;
    if (parsed) { phone = parsed.e164; phoneExtension = phoneExtension ?? parsed.extension; }
    else warnings.push(warn('phone_dropped', 'phone', 'The phone number could not be read and was left out.'));
  }
  // B018: the firm's switchboard is the firm's line, never the person's own, whatever it was typed.
  const firmLine = (number: string, type: string) => number === companyPhone && type !== 'main' && type !== 'toll_free';
  if (phone && firmLine(phone, phoneType)) {
    warnings.push(warn('value_defaulted', 'phoneType', 'This number is the firm\'s main line, so Cadence keeps it as the firm\'s line, not the person\'s.'));
    phoneType = 'main';
  }
  const additionalPhones: ExtraPhone[] = [];
  if (present(c.additionalPhones)) {
    const list = Array.isArray(c.additionalPhones) ? c.additionalPhones : [];
    if (!Array.isArray(c.additionalPhones) || list.length > 5) warnings.push(warn('value_defaulted', 'additionalPhones', 'Only the first 5 additional phones are kept.'));
    for (const item of list.slice(0, 5)) {
      const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const number = typeof p.number === 'string' ? toE164(p.number, country) : null;
      if (!number) { warnings.push(warn('phone_dropped', 'additionalPhones', 'An additional phone number could not be read and was left out.')); continue; }
      if (number === phone || additionalPhones.some((x) => x.number === number)) continue;
      let type = oneOf(p.type, PHONE_TYPES, 'unknown', 'additionalPhones.type', warnings);
      if (firmLine(number, type)) type = 'main';
      additionalPhones.push({ number, type });
    }
  }
  let linkedinUrl: string | null = null;
  if (present(c.linkedinUrl)) {
    linkedinUrl = typeof c.linkedinUrl === 'string' ? normalizeLinkedin(c.linkedinUrl) : null;
    if (!linkedinUrl) warnings.push(warn('linkedin_dropped', 'linkedinUrl', 'The LinkedIn URL is not a person profile and was left out.'));
  }
  const products = textList(c.productInterest, 'productInterest', 10, 50, warnings).map((p) => p.toUpperCase());
  const productInterest = products.filter((p) => (PRODUCT_VALUES as readonly string[]).includes(p));
  for (const p of products.filter((x) => !productInterest.includes(x))) warnings.push(warn('product_dropped', 'productInterest', `${p} is not a product the CRM knows and was left out.`));
  // B172: a long title is cut at a word, never mid-word, and the push says so.
  let jobTitle = typeof c.jobTitle === 'string' ? plainText(c.jobTitle).replace(/\s+/g, ' ') || null : null;
  if (jobTitle && jobTitle.length > 200) {
    jobTitle = cutAtWord(jobTitle, 200);
    warnings.push(warn('value_defaulted', 'jobTitle', 'The job title was over 200 characters, so it was cut at a word.'));
  }
  // B072, B114: a note over 5000 characters is cut, not lost; HTML and markdown links go at the door.
  let notes = typeof c.notes === 'string' ? plainText(c.notes) || null : null;
  if (notes && notes.length > 5000) {
    notes = cutAtWord(notes, 5000);
    warnings.push(warn('note_truncated', 'notes', 'The note was over 5000 characters, so it was cut at a word.'));
  }
  const website = optional(firm.website, 'firm.website', 500, warnings);
  const companyDomain = normalizeDomain(str(firm.domain, 255)) ?? normalizeDomain(website);
  let aum: string | null = null;
  if (present(firm.aumUsd)) {
    if (typeof firm.aumUsd === 'number' && Number.isFinite(firm.aumUsd) && firm.aumUsd >= 0 && firm.aumUsd <= MAX_AUM) aum = String(Math.round(firm.aumUsd));
    else warnings.push(warn('value_defaulted', 'firm.aumUsd', 'firm.aumUsd is not a whole number of dollars Cadence can keep, so it was left out.'));
  }
  let employees: number | null = null;
  if (present(firm.employees)) {
    if (typeof firm.employees === 'number' && Number.isInteger(firm.employees) && firm.employees >= 0 && firm.employees <= MAX_INT) employees = firm.employees;
    else warnings.push(warn('value_defaulted', 'firm.employees', 'firm.employees is not a whole number Cadence can keep, so it was left out.'));
  }
  let companyCountry: string | null = null;
  if (present(firm.country)) {
    companyCountry = typeof firm.country === 'string' ? normalizeCountry(firm.country) : null;
    if (!companyCountry) warnings.push(warn('value_defaulted', 'firm.country', `Cadence does not know the country "${String(firm.country).slice(0, 40)}", so it was left out.`));
  }
  let bellwetherUrl: string | null = null;
  if (present(c.bellwetherUrl)) {
    bellwetherUrl = typeof c.bellwetherUrl === 'string' && /^https:\/\//i.test(c.bellwetherUrl.trim()) && c.bellwetherUrl.trim().length <= 1000 ? c.bellwetherUrl.trim() : null;
    if (!bellwetherUrl) warnings.push(warn('value_defaulted', 'bellwetherUrl', 'bellwetherUrl is not an https link, so it was left out.'));
  }
  let collectedAt: string | null = null;
  if (present(c.collectedAt)) {
    collectedAt = typeof c.collectedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(c.collectedAt) ? c.collectedAt.slice(0, 10) : null;
    if (!collectedAt) warnings.push(warn('value_defaulted', 'collectedAt', 'collectedAt is not a date, so it was left out.'));
  }
  const contact: PushContact = {
    bellwetherContactId: id, firstName, lastName, jobTitle, email, emailVerification: verification, additionalEmails,
    phone, phoneType, phoneExtension, additionalPhones, linkedinUrl, city: optional(c.city, 'city', 100, warnings), state: optional(c.state, 'state', 100, warnings), country,
    individualCrd: normalizeCrd(typeof c.individualCrd === 'string' || typeof c.individualCrd === 'number' ? c.individualCrd : null),
    designations: textList(c.designations, 'designations', 20, 20, warnings), productInterest: [...new Set(productInterest)], tags: textList(c.tags, 'tags', 20, 50, warnings),
    notes, bellwetherUrl, source: optional(c.source, 'source', 200, warnings), collectedAt,
    doNotContact: truthy(c.doNotContact),
    companyName: firmName, companyDomain, companyCrd: normalizeCrd(typeof firm.crd === 'string' || typeof firm.crd === 'number' ? firm.crd : null),
    companyWebsite: website, companyCity: optional(firm.city, 'firm.city', 100, warnings), companyState: optional(firm.state, 'firm.state', 100, warnings), companyCountry,
    companyPhone, companyAumUsd: aum, companyEmployees: employees,
    warnings,
  };
  return { ok: true, contact };
}

/** B171: a usable email, a phone or a LinkedIn profile is left once the push was read (contactability's channels, PLAN 8.2 block 6). */
export const reachable = (c: Pick<PushContact, 'email' | 'emailVerification' | 'additionalEmails' | 'phone' | 'additionalPhones' | 'linkedinUrl'>) =>
  hasUsableEmail({ email: c.email, badEmail: false, emailVerification: c.emailVerification }) || c.additionalEmails.length > 0 || Boolean(c.phone) || c.additionalPhones.length > 0 || Boolean(c.linkedinUrl);

// ---------------------------------------------------------------------------
// Ownership (14.7, PLAN 8.8)
// ---------------------------------------------------------------------------

export type Owner = { id: string; email: string; name: string; podId: string } | null;
export type Ownership = { owner: Owner; podIgnored: boolean; /** Why nobody can own the new contacts (B070): each one that would be created is refused with it (U01). */ warning: Warning | null };

/**
 * Who owns what this push creates (14.7) by the ownership rules every other path uses (transfer.ts):
 * an active sales rep, never an admin or Biz Ops (B119, B208), in a pod; the pod Bellwether named
 * when the owner works it (compared case-insensitively, by its CRM value or its name, B170), else
 * the owner's only pod, else their first pod by name. The owner is `assignTo`, else `pushedBy`.
 * Agreed owner contract (audit U01, U02, U03, U05; 13 Nov 2026): when that person cannot own contacts
 * now (unknown, deactivated, an admin or Biz Ops, in no pod), each contact this push would create is
 * refused (`rejected`, `owner_not_found`, saying who and why), never created unclaimed. Contacts
 * already in Cadence or the CRM keep their own owner rules.
 */
export async function resolveOwner(env: Envelope): Promise<Ownership> {
  const users = await prisma.user.findMany({ include: { pods: { where: { pod: { archived: false } }, include: { pod: true } } } });
  const target = env.assignTo?.email ?? env.pushedBy.email;
  const known = (u: (typeof users)[number]) => u.email.toLowerCase() === target || u.aliases.some((a) => a.toLowerCase() === target);
  const byObject = !env.assignTo && env.pushedBy.microsoftObjectId ? users.find((u) => u.active && u.microsoftId && u.microsoftId.toLowerCase() === env.pushedBy.microsoftObjectId!.toLowerCase()) : undefined;
  const user = byObject ?? users.find((u) => u.active && known(u)) ?? users.find(known);
  const nobody = (why: string): Ownership => ({
    owner: null, podIgnored: Boolean(env.pod),
    warning: warn(env.assignTo ? 'assign_to_not_found' : 'owner_not_found', env.assignTo ? 'assignTo.email' : 'pushedBy.email', `${why} The contact was not created: send it again with an owner who can own contacts.`),
  });
  if (!user) return nobody(`${target} is not a Cadence user.`);
  const pods = user.pods.map((p) => p.pod);
  const candidate = { id: user.id, name: user.name, role: user.role, active: user.active, podIds: pods.map((p) => p.id) };
  const refusal = ownerRefusal(null, candidate, null);
  if (refusal) return nobody(refusal);
  const wanted = env.pod?.trim().toLowerCase();
  const named = wanted ? pods.find((p) => p.podOwnerValue.toLowerCase() === wanted || p.name.toLowerCase() === wanted) : undefined;
  const choice = podForOwner(candidate, null, named?.id);
  // S3: a rep in several pods, the push naming none of theirs, gets their first pod by name.
  const podId = choice.ok ? choice.podId : [...pods].sort((a, b) => a.name.localeCompare(b.name))[0]?.id ?? null;
  if (!podId) return nobody(choice.ok ? `${user.name} is in no pod.` : choice.reason);
  return { owner: { id: user.id, email: user.email, name: user.name, podId }, podIgnored: Boolean(env.pod && !named), warning: null };
}

/**
 * GET /v1/owners (contract 1.1, B022): who can own contacts pushed from Bellwether, by the same rules
 * as resolveOwner, with the pods each works as Bellwether sends them in `pod` (the CRM's pod value).
 */
export async function ownersList(): Promise<{ owners: { email: string; name: string; pods: string[] }[] }> {
  const users = await prisma.user.findMany({ where: { active: true }, include: { pods: { where: { pod: { archived: false } }, include: { pod: true } } }, orderBy: { name: 'asc' } });
  const owners = users.flatMap((u) => {
    const pods = u.pods.map((p) => p.pod).sort((a, b) => a.name.localeCompare(b.name));
    if (!pods.length || ownerRefusal(null, { id: u.id, name: u.name, role: u.role, active: u.active, podIds: pods.map((p) => p.id) }, null)) return [];
    return [{ email: u.email.toLowerCase(), name: u.name, pods: pods.map((p) => p.podOwnerValue) }];
  });
  return { owners };
}

// ---------------------------------------------------------------------------
// The pipeline (14.6 to 14.8)
// ---------------------------------------------------------------------------

export type ContactResult = {
  bellwetherContactId: string;
  result: 'created' | 'duplicate_in_sandbox' | 'already_in_crm' | 'rejected';
  cadenceContactId: string | null;
  reason: string | null;
  detail: string | null;
  matchedOn: MatchedOn | null;
  crmPersonId: string | null;
  crmUrl: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  filledFields: string[];
  warnings: Warning[];
  /** Contract 1.1: the contact's page in Cadence, for created and duplicate_in_sandbox. */
  cadenceUrl?: string | null;
};

export type PushResponse = {
  pushId: string | null;
  replayed: boolean;
  receivedAt: string;
  owner: { email: string; name: string } | null;
  summary: { created: number; duplicate_in_sandbox: number; already_in_crm: number; rejected: number };
  results: ContactResult[];
};

/** A push or check answer as a contract version reads it: v1 gets exactly v1's fields and warning codes. */
export function pushAnswerFor(body: PushResponse, contract: Contract): PushResponse {
  if (contract === '1.1') return { ...body, results: body.results.map((r) => ({ ...r, cadenceUrl: r.cadenceUrl ?? null })) };
  return {
    ...body,
    results: body.results.map((r) => ({
      bellwetherContactId: r.bellwetherContactId, result: r.result, cadenceContactId: r.cadenceContactId, reason: r.reason, detail: r.detail, matchedOn: r.matchedOn,
      crmPersonId: r.crmPersonId, crmUrl: r.crmUrl, ownerEmail: r.ownerEmail, ownerName: r.ownerName, filledFields: r.filledFields,
      warnings: r.warnings.filter((w) => V1_WARNINGS.has(w.code)),
    })),
  };
}

const blank = (id: string): ContactResult => ({ bellwetherContactId: id, result: 'rejected', cadenceContactId: null, reason: null, detail: null, matchedOn: null, crmPersonId: null, crmUrl: null, ownerEmail: null, ownerName: null, filledFields: [], warnings: [] });
const reject = (id: string, reason: string, detail: string, warnings: Warning[] = []): ContactResult => ({ ...blank(id), reason, detail, warnings });

/** Payload fields and the sandbox columns they fill when empty (duplicate_in_sandbox). */
const FILLABLE: Array<[string, keyof SandboxContact, (c: PushContact) => unknown]> = [
  ['bellwetherContactId', 'bellwetherContactId', (c) => c.bellwetherContactId],
  ['jobTitle', 'jobTitle', (c) => c.jobTitle],
  ['email', 'email', (c) => c.email],
  ['additionalEmails', 'additionalEmails', (c) => c.additionalEmails],
  ['phone', 'phone', (c) => c.phone],
  ['additionalPhones', 'additionalPhones', (c) => c.additionalPhones],
  ['linkedinUrl', 'linkedinUrl', (c) => c.linkedinUrl],
  ['city', 'city', (c) => c.city],
  ['state', 'state', (c) => c.state],
  ['country', 'country', (c) => c.country],
  ['individualCrd', 'individualCrd', (c) => c.individualCrd],
  ['designations', 'designations', (c) => c.designations],
  ['productInterest', 'productInterest', (c) => c.productInterest],
  ['tags', 'tags', (c) => c.tags],
  ['bellwetherUrl', 'bellwetherUrl', (c) => c.bellwetherUrl],
  ['source', 'sourceNote', (c) => c.source],
  ['collectedAt', 'collectedAt', (c) => c.collectedAt],
  ['firm.name', 'companyName', (c) => c.companyName],
  ['firm.crd', 'companyCrd', (c) => c.companyCrd],
  ['firm.website', 'companyWebsite', (c) => c.companyWebsite],
  ['firm.domain', 'companyDomain', (c) => c.companyDomain],
  ['firm.city', 'companyCity', (c) => c.companyCity],
  ['firm.state', 'companyState', (c) => c.companyState],
  ['firm.country', 'companyCountry', (c) => c.companyCountry],
  ['firm.phone', 'companyPhone', (c) => c.companyPhone],
  ['firm.aumUsd', 'companyAumUsd', (c) => c.companyAumUsd],
  ['firm.employees', 'companyEmployees', (c) => c.companyEmployees],
];
const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Details that belong to the firm a person works at, not to the person (B068). */
const FIRM_BOUND = new Set<keyof SandboxContact>(['jobTitle', 'city', 'state', 'companyName', 'companyCrd', 'companyWebsite', 'companyDomain', 'companyCity', 'companyState', 'companyCountry', 'companyPhone', 'companyAumUsd', 'companyEmployees']);

/** The push has the person at the firm the contact is at (by name, domain or CRD), or the contact has no firm yet. */
export function sameFirmAs(existing: Pick<SandboxContact, 'companyName' | 'companyDomain' | 'companyCrd'>, c: Pick<PushContact, 'companyName' | 'companyDomain' | 'companyCrd'>): boolean {
  const firm = normalizeFirmName(existing.companyName);
  if (!firm && !existing.companyDomain && !existing.companyCrd) return true;
  return Boolean((firm && firm === normalizeFirmName(c.companyName)) || (existing.companyDomain && existing.companyDomain === c.companyDomain) || (existing.companyCrd && existing.companyCrd === c.companyCrd));
}

/**
 * Empty fields of the existing contact that the push would fill; nothing is ever overwritten. When
 * the push has the person at another firm, only their own details fill (emails, direct and mobile
 * phones, LinkedIn, CRD): a new firm's title, office line or address never lands on the old record (B068).
 */
export function fillPlan(existing: SandboxContact, c: PushContact): { fields: string[]; data: Prisma.SandboxContactUpdateInput; alias: string | null } {
  const fields: string[] = [];
  const data: Record<string, unknown> = {};
  const sameFirm = sameFirmAs(existing, c);
  for (const [field, column, raw] of FILLABLE) {
    if (!sameFirm && FIRM_BOUND.has(column)) continue;
    if (!sameFirm && column === 'phone' && !personalPhone(c.phoneType)) continue;
    const v = !sameFirm && column === 'additionalPhones' ? c.additionalPhones.filter((p) => personalPhone(p.type)) : raw(c);
    if (isEmpty(v) || !isEmpty(existing[column])) continue;
    if (column === 'additionalPhones' && Array.isArray(existing.additionalPhones) && existing.additionalPhones.length) continue;
    fields.push(field);
    data[column] = column === 'companyAumUsd' ? new Prisma.Decimal(String(v)) : v;
    if (column === 'phone') { data.phoneType = c.phoneType; data.phoneExtension = c.phoneExtension; }
    if (column === 'email') { data.emailVerification = c.emailVerification; data.emailIsRole = isRoleEmail(c.email); }
  }
  const alias = existing.bellwetherContactId && existing.bellwetherContactId !== c.bellwetherContactId && !existing.bellwetherAliases.includes(c.bellwetherContactId) ? c.bellwetherContactId : null;
  if (alias) data.bellwetherAliases = { push: alias };
  return { fields, data: data as Prisma.SandboxContactUpdateInput, alias };
}

/**
 * B068: what a push knows that the existing contact does not, once its empty fields are filled. A
 * personal email and a direct or mobile number follow the person, so they are added as extra details;
 * an office line is added only at the same firm (a new firm's switchboard never lands on the old
 * record). A different firm or title is only reported, for the owner to review.
 */
export function newerDetails(existing: SandboxContact, c: PushContact, filled: Prisma.SandboxContactUpdateInput): { additionalEmails: string[]; additionalPhones: ExtraPhone[]; words: string[] } {
  const filledData = filled as Record<string, unknown>;
  const knownEmails = new Set([existing.email, ...existing.additionalEmails, filledData.email as string | undefined, ...((filledData.additionalEmails as string[] | undefined) ?? [])].filter((e): e is string => Boolean(e)));
  const extraEmails = isEmpty(filledData.additionalEmails) ? [...existing.additionalEmails] : [...(filledData.additionalEmails as string[])];
  const addedEmails = [c.email, ...c.additionalEmails].filter((e): e is string => Boolean(e) && !knownEmails.has(e!) && !isRoleEmail(e)).slice(0, Math.max(0, 5 - extraEmails.length));
  const sameFirm = sameFirmAs(existing, c);
  const knownPhones = new Set([existing.phone, filledData.phone as string | undefined, ...readExtraPhones(existing.additionalPhones).map((p) => p.number), ...readExtraPhones(filledData.additionalPhones).map((p) => p.number)].filter((n): n is string => Boolean(n)));
  const extraPhones = readExtraPhones(isEmpty(filledData.additionalPhones) ? existing.additionalPhones : filledData.additionalPhones);
  const addedPhones = pushedPhones(c).filter((p) => !knownPhones.has(p.number) && p.number !== c.companyPhone && p.number !== existing.companyPhone && p.type !== 'main' && p.type !== 'toll_free' && (personalPhone(p.type) || sameFirm)).slice(0, Math.max(0, 5 - extraPhones.length));
  const words: string[] = [];
  if (addedEmails.length) words.push(`${addedEmails.length === 1 ? 'email' : 'emails'} ${addedEmails.join(', ')} added`);
  if (addedPhones.length) words.push(`${addedPhones.length === 1 ? 'phone' : 'phones'} ${addedPhones.map((p) => p.number).join(', ')} added`);
  if (!sameFirm && c.companyName) words.push(`their firm there is ${c.companyName}`);
  if (c.jobTitle && existing.jobTitle && c.jobTitle.toLowerCase() !== existing.jobTitle.toLowerCase()) words.push(`their title there is ${c.jobTitle}`);
  return { additionalEmails: addedEmails.length ? [...extraEmails, ...addedEmails] : [], additionalPhones: addedPhones.length ? [...extraPhones, ...addedPhones] : [], words };
}

async function ownerOfPerson(memberId: string | null, tx: Tx): Promise<{ email: string; name: string } | null> {
  if (!memberId) return null;
  const u = await tx.user.findFirst({ where: { twentyMemberId: memberId }, select: { email: true, name: true } });
  return u ?? null;
}

const REASON_DETAIL: Record<string, string> = {
  internal_contact: 'This is one of Acumen\'s own addresses or firms.',
  do_not_contact: 'Bellwether marked this contact do not contact.',
  duplicate_in_request: 'The same contact appears earlier in this push.',
  internal_error: 'Cadence hit an error on this contact and finished the rest. Send it again; if it happens again, report it.',
};

type Tx = Prisma.TransactionClient | typeof prisma;
type JudgeCtx = {
  ownership: Ownership;
  envelope: Envelope;
  conn: { baseUrl: string | null };
  /** True for the check (14.14): its writes are rolled back, so a created contact has no id to give. */
  check: boolean;
  /** Contacts this check created (and will roll back): a later one matching them has no id either. */
  createdHere: Set<string>;
  actor: AuditActor;
};

/**
 * Judge every contact of a push. The push (`write`) changes Cadence (created, filled, noted) and
 * records each outcome for the status endpoint; the check runs the very same steps inside a
 * transaction it rolls back, so its answer is the push's answer and nothing stays written (B069).
 */
export async function runContacts(envelope: Envelope, opts: { write: boolean; pushId?: string | null; now?: Date }): Promise<{ results: ContactResult[]; owner: Owner }> {
  const ownership = await resolveOwner(envelope);
  const conn = await getTwentyConnection();
  const parsed = envelope.contacts.map(normalizeContact);
  const valid = parsed.flatMap((p) => (p.ok && !p.contact.doNotContact ? [p.contact] : []));
  const ctx: JudgeCtx = { ownership, envelope, conn, check: !opts.write, createdHere: new Set(), actor: { type: 'WEBHOOK', label: `bellwether:${envelope.pushedBy.email}` } };
  let client: TwentyClient | null = null;
  if (valid.length) { try { client = await getTwentyClient(); } catch { client = null; } }

  if (opts.write) {
    // Twenty is asked once per push, before any contact is judged, and its answer goes into the copy (dedupe.ts).
    if (client) await refreshCrmCopyFor(valid, client);
    const results = await judgeAll(parsed, ctx, async (id, work) => {
      try {
        return await prisma.$transaction(async (tx) => {
          // One push at a time decides who is new, so two pushes of the same person cannot both create it.
          await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('bellwether-push'))`;
          const result = await work(tx);
          if (opts.pushId) await tx.bellwetherPushItem.create({ data: { pushId: opts.pushId, bellwetherContactId: result.bellwetherContactId, result: result.result, reason: result.reason, sandboxContactId: result.cadenceContactId, crmPersonId: result.crmPersonId } });
          return result;
        }, { timeout: 20_000 });
      } catch (err) {
        return failedOne(id, err, opts.pushId ?? null);
      }
    });
    return { results, owner: ownership.owner };
  }

  // The check: Twenty is asked the same way, read only; its answer and every write below are rolled back.
  const answer: TwentyAnswer | null = client ? await askTwentyFor(valid, client) : null;
  let results: ContactResult[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      if (answer) await applyTwentyAnswer(answer, tx);
      results = await judgeAll(parsed, ctx, async (id, work) => {
        await tx.$executeRawUnsafe('SAVEPOINT bellwether_check_contact');
        try {
          const r = await work(tx);
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT bellwether_check_contact');
          return r;
        } catch (err) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT bellwether_check_contact');
          return failedOne(id, err, null);
        }
      });
      throw new CheckDone();
    }, { timeout: 55_000, maxWait: 10_000 });
  } catch (err) {
    if (!(err instanceof CheckDone)) throw err;
  }
  return { results, owner: ownership.owner };
}

/** Thrown at the end of a check so its transaction rolls back (14.14: the check writes nothing). */
class CheckDone extends Error {
  constructor() { super('check done'); this.name = 'CheckDone'; }
}

/** The database itself is unreachable: the whole request is 503, and Bellwether sends it again (14.9). */
export function databaseDown(err: unknown): boolean {
  const code = (err as { code?: string; errorCode?: string } | null)?.code ?? (err as { errorCode?: string } | null)?.errorCode ?? '';
  if (['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(code)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ECONNRESET|Can't reach database server|Server has closed the connection|Timed out fetching a new connection/i.test(message);
}

/**
 * B012: one contact Cadence fails on is that contact's answer (rejected / internal_error), never the
 * push's: the rest go on and the push reaches DONE. Only a database that is really down stops it.
 */
function failedOne(id: string, err: unknown, pushId: string | null): ContactResult {
  if (databaseDown(err)) throw err;
  console.error('[bellwether] one contact failed', { pushId, bellwetherContactId: id, error: err instanceof Error ? err.message : String(err) });
  return reject(id, 'internal_error', REASON_DETAIL.internal_error);
}

/**
 * B173: contacts of one push that share a personal email. The one whose firm's domain is the
 * address's keeps it, else the first; the others are duplicate_in_request, and say who has it. A
 * shared inbox (info@) never makes two people one (B177).
 */
function emailHolders(parsed: ReturnType<typeof normalizeContact>[]): Map<string, number> {
  const holders = new Map<string, number>();
  const domainOf = (e: string) => e.slice(e.lastIndexOf('@') + 1);
  parsed.forEach((p, i) => {
    if (!p.ok || !p.contact.email || isRoleEmail(p.contact.email)) return;
    const e = p.contact.email;
    const d = domainOf(e);
    const ours = (c: PushContact) => Boolean(c.companyDomain && (d === c.companyDomain || d.endsWith(`.${c.companyDomain}`)));
    const held = holders.get(e);
    if (held === undefined) holders.set(e, i);
    else if (!ours((parsed[held] as { contact: PushContact }).contact) && ours(p.contact)) holders.set(e, i);
  });
  return holders;
}

type Unit = (id: string, work: (tx: Prisma.TransactionClient) => Promise<ContactResult>) => Promise<ContactResult>;

async function judgeAll(parsed: ReturnType<typeof normalizeContact>[], ctx: JudgeCtx, unit: Unit): Promise<ContactResult[]> {
  const results: ContactResult[] = [];
  const seenIds = new Set<string>();
  const holders = emailHolders(parsed);
  const { ownership, envelope } = ctx;
  for (const [i, p] of parsed.entries()) {
    if (!p.ok) {
      results.push(await unit(p.id, async (tx) => refused(tx, reject(p.id, 'invalid_field', p.detail))));
      continue;
    }
    const c = p.contact;
    const warnings = [...c.warnings];
    if (ownership.podIgnored) warnings.push(warn('pod_ignored', 'pod', ownership.owner ? `${ownership.owner.name} does not work pod ${envelope.pod}, so it was not used.` : 'The contact has no owner in Cadence, so the pod was not used.'));
    // Rule 1: the same id again (it was answered above), or a personal email another contact of this push keeps.
    if (seenIds.has(c.bellwetherContactId)) {
      results.push(await unit(c.bellwetherContactId, async () => reject(c.bellwetherContactId, 'duplicate_in_request', REASON_DETAIL.duplicate_in_request, warnings)));
      continue;
    }
    const holder = c.email ? holders.get(c.email) : undefined;
    if (holder !== undefined && holder !== i) {
      const other = (parsed[holder] as { contact: PushContact }).contact;
      const detail = `${c.email} is also on ${other.firstName} ${other.lastName} in this push${other.companyDomain && c.email!.endsWith(other.companyDomain) ? ', whose firm uses that address\'s domain' : ''}.`;
      results.push(await unit(c.bellwetherContactId, async (tx) => refused(tx, reject(c.bellwetherContactId, 'duplicate_in_request', detail, warnings))));
      continue;
    }
    seenIds.add(c.bellwetherContactId);
    if (c.doNotContact) {
      results.push(await unit(c.bellwetherContactId, async (tx) => refused(tx, reject(c.bellwetherContactId, 'do_not_contact', REASON_DETAIL.do_not_contact, warnings))));
      continue;
    }
    results.push(await unit(c.bellwetherContactId, (tx) => judgeOne(c, warnings, ctx, tx)));
  }
  return results;
}

/**
 * B015: a refusal Bellwether keeps reading as status "refused" with its reason (contract 1.1), so it
 * never turns into "Cadence has no record of it". Not when a contact Cadence still has answers for the
 * id: that contact's status is the answer.
 */
async function refused(tx: Tx, r: ContactResult): Promise<ContactResult> {
  const id = r.bellwetherContactId;
  if (!id.trim() || id.length > 200 || hasControl(id)) return r;
  const live = await tx.sandboxContact.count({ where: { status: { not: 'REMOVED' }, OR: [{ bellwetherContactId: id }, { bellwetherAliases: { has: id } }] } });
  if (!live) await recordRefusal(id, 'refused', null, { tx, reason: r.reason });
  return r;
}

const KEY_MATCH: Record<string, RefusalMatch> = { email: 'email', phone: 'phone_personal', phone_subject: 'phone_shared', linkedin: 'linkedin', bellwether_id: 'bellwether_id', individual_crd: 'individual_crd' };
const SUPPRESSED_WORDS: Record<string, string> = { bellwether_id: 'Bellwether record', individual_crd: 'individual CRD', phone_subject: 'phone' };

async function judgeOne(c: PushContact, warnings: Warning[], ctx: JudgeCtx, tx: Prisma.TransactionClient): Promise<ContactResult> {
  const { ownership } = ctx;
  const id = c.bellwetherContactId;
  const verdict = await dedupeContact(c, tx);
  const base = { ...blank(id), warnings };
  if (verdict.kind === 'suppressed') {
    await recordRefusal(id, 'opted_out', null, { tx, matchedOn: KEY_MATCH[verdict.key.kind] ?? null });
    return { ...base, reason: 'suppressed', detail: `This contact's ${SUPPRESSED_WORDS[verdict.key.kind] ?? verdict.key.kind} is on Cadence's suppression list.` };
  }
  if (verdict.kind === 'internal_contact') return refused(tx, { ...base, reason: 'internal_contact', detail: REASON_DETAIL.internal_contact });
  if (verdict.kind === 'blocked_account') return refused(tx, { ...base, reason: 'blocked_account', detail: verdict.detail });
  // N003: the same person by name and firm is Do not contact in the CRM. Bellwether reads opted_out.
  if (verdict.kind === 'crm_do_not_contact') {
    await recordRefusal(id, 'opted_out', verdict.person.id, { tx, matchedOn: 'name_firm' });
    return { ...base, reason: 'suppressed', detail: `${verdict.person.name} is marked Do not contact in the CRM.` };
  }
  if (verdict.kind === 'already_in_crm' || verdict.kind === 'moved_tombstone') {
    const personId = verdict.kind === 'already_in_crm' ? verdict.person.id : verdict.contact.twentyPersonId;
    const ownerOf = verdict.kind === 'already_in_crm' ? await ownerOfPerson(verdict.person.ownerMemberId, tx) : null;
    // B071: the CRM person is the one Cadence moved this very contact to. It stays moved_to_crm for
    // Bellwether (the moved contact answers for the id); no refusal is recorded over it.
    const movedHere = verdict.kind === 'moved_tombstone' || (personId ? (await tx.sandboxContact.count({ where: { status: 'MOVED', twentyPersonId: personId, OR: [{ bellwetherContactId: id }, { bellwetherAliases: { has: id } }] } })) > 0 : false);
    if (!movedHere) {
      const on: RefusalMatch = verdict.matchedOn === 'linkedin_url' ? 'linkedin' : verdict.matchedOn === 'phone' ? (verdict.sharedLine ? 'phone_shared' : 'phone_personal') : verdict.matchedOn === 'bellwether_contact_id' ? 'bellwether_id' : verdict.matchedOn;
      await recordRefusal(id, 'already_in_crm', personId, { tx, matchedOn: on });
    }
    return { ...base, result: 'already_in_crm', matchedOn: verdict.kind === 'already_in_crm' ? verdict.matchedOn : 'bellwether_contact_id', crmPersonId: personId, crmUrl: personId ? twentyPersonUrl(ctx.conn.baseUrl, personId) : null, ownerEmail: ownerOf?.email ?? null, ownerName: ownerOf?.name ?? null };
  }
  if (verdict.kind === 'duplicate_in_sandbox') return duplicate(c, verdict.contact, verdict.matchedOn, base, ctx, tx);

  const possible = await possibleCrmMatch(c, tx);
  const possibleName = possible ? await tx.personCache.findUnique({ where: { id: possible }, select: { firstName: true, lastName: true } }) : null;
  const twin = await possibleSandboxTwin(c, tx);
  // U01: nobody who can own contacts was named, so the contact is refused, never created unclaimed.
  if (!ownership.owner) return refused(tx, { ...base, reason: 'owner_not_found', detail: ownership.warning?.detail ?? 'Nobody who can own contacts was named. The contact was not created.' });
  const extra: Warning[] = [
    ...(reachable(c) ? [] : [warn('no_reach', null, 'No email, phone or LinkedIn profile is left, so the rep cannot reach this person.')]),
    ...(possible ? [{ code: 'possible_crm_match', field: null, crmPersonId: possible, detail: `${`${possibleName?.firstName ?? ''} ${possibleName?.lastName ?? ''}`.trim() || 'A person'}, at a firm with the same domain or CRD.` }] : []),
    ...(twin ? [warn('possible_sandbox_duplicate', null, `Possibly the same person as ${twin.name}, already in Cold outreach at the same firm.`)] : []),
  ];
  const owner = ownership.owner;
  // A contact retention removed keeps its Bellwether id only until the person is pushed again.
  await tx.sandboxContact.updateMany({ where: { status: 'REMOVED', bellwetherContactId: id }, data: { bellwetherContactId: null } });
  const created = await tx.sandboxContact.create({ data: { ...sandboxRowFromPush(c, owner, ctx), possibleCrmPersonId: possible ?? null, possibleDuplicateId: twin?.id ?? null, statusChangedAt: await databaseNow(tx) } });
  if (c.notes) await tx.sandboxNote.create({ data: { sandboxContactId: created.id, body: c.notes, authorName: pusherName(ctx) } });
  await logAudit({ entityType: 'sandbox_contact', entityId: created.id, action: 'pushed', actor: ctx.actor, details: { bellwetherContactId: id, ownerId: owner?.id ?? null, possibleDuplicateId: twin?.id ?? null } }, tx);
  if (ctx.check) ctx.createdHere.add(created.id);
  return { ...base, result: 'created', cadenceContactId: ctx.check ? null : created.id, cadenceUrl: ctx.check ? null : cadenceUrlOf(created.id), warnings: [...warnings, ...extra], ownerEmail: owner?.email ?? null, ownerName: owner?.name ?? null };
}

const pusherName = (ctx: JudgeCtx) => (ctx.envelope.pushedBy.name ? `${ctx.envelope.pushedBy.name} (Bellwether)` : 'Bellwether');

/**
 * Rule 5: the person is already in Cold outreach. Under the contact's row lock (the guard: an active
 * contact not being moved), its empty fields are filled (nothing is ever overwritten), a pushed note
 * is added (B067), and newer details are added for the owner to review (B068). The owner never changes.
 */
async function duplicate(c: PushContact, existing: SandboxContact, matchedOn: MatchedOn, base: ContactResult, ctx: JudgeCtx, tx: Prisma.TransactionClient): Promise<ContactResult> {
  const warnings = [...base.warnings];
  const locked = await lockColdIn(tx, existing.id, 'edit');
  const row = locked.ok ? await tx.sandboxContact.findUniqueOrThrow({ where: { id: existing.id } }) : existing;
  const plan = fillPlan(row, c);
  const newer = locked.ok ? newerDetails(row, c, plan.data) : { additionalEmails: [], additionalPhones: [], words: [] };
  if (locked.ok) {
    const data: Record<string, unknown> = { ...(plan.data as Record<string, unknown>) };
    if (newer.additionalEmails.length) data.additionalEmails = newer.additionalEmails;
    if (newer.additionalPhones.length) data.additionalPhones = newer.additionalPhones as unknown as Prisma.InputJsonValue;
    if (Object.keys(data).length) {
      await tx.sandboxContact.update({ where: { id: row.id }, data: data as Prisma.SandboxContactUpdateInput });
      await logAudit({ entityType: 'sandbox_contact', entityId: row.id, action: 'filled_from_push', actor: ctx.actor, details: { fields: plan.fields, added: newer.words } }, tx);
    }
    // B067: the note travels with the push; the same words twice are one note.
    if (c.notes && !(await tx.sandboxNote.count({ where: { sandboxContactId: row.id, body: c.notes } }))) {
      await tx.sandboxNote.create({ data: { sandboxContactId: row.id, body: c.notes, authorName: pusherName(ctx) } });
      warnings.push(warn('note_added', 'notes', 'The person is already in Cold outreach, so the note was added to that contact.'));
    }
    // B068: the owner sees what Bellwether knows that the contact does not.
    if (newer.words.length) {
      const words = `Newer details from Bellwether: ${newer.words.join('; ')}.`;
      await tx.sandboxNote.create({ data: { sandboxContactId: row.id, body: `${words} Check them before the next step.`, authorName: pusherName(ctx) } });
      warnings.push(warn('details_changed', null, words));
    }
  }
  const holder = row.ownerId ? await tx.user.findUnique({ where: { id: row.ownerId }, select: { email: true, name: true, active: true } }) : null;
  const owner = holder?.active ? holder : null;
  const known = !ctx.check || !ctx.createdHere.has(row.id);
  return { ...base, warnings, result: 'duplicate_in_sandbox', cadenceContactId: known ? row.id : null, cadenceUrl: known ? cadenceUrlOf(row.id) : null, matchedOn, ownerEmail: owner?.email ?? null, ownerName: owner?.name ?? null, filledFields: locked.ok ? plan.fields : [] };
}

function sandboxRowFromPush(c: PushContact, owner: Owner, ctx: JudgeCtx): Prisma.SandboxContactUncheckedCreateInput {
  const now = new Date();
  return {
    source: 'BELLWETHER', firstName: c.firstName, lastName: c.lastName, sortName: sandboxSortName(c.firstName, c.lastName), jobTitle: c.jobTitle,
    email: c.email, emailIsRole: isRoleEmail(c.email), emailVerification: c.emailVerification, additionalEmails: c.additionalEmails, phone: c.phone, phoneType: c.phoneType,
    phoneExtension: c.phoneExtension, additionalPhones: c.additionalPhones, linkedinUrl: c.linkedinUrl, city: c.city, state: c.state, country: c.country,
    individualCrd: c.individualCrd, designations: c.designations, productInterest: c.productInterest, tags: c.tags,
    companyName: c.companyName, companyDomain: c.companyDomain, companyWebsite: c.companyWebsite, companyCrd: c.companyCrd, companyCity: c.companyCity,
    companyState: c.companyState, companyCountry: c.companyCountry, companyPhone: c.companyPhone,
    companyAumUsd: c.companyAumUsd ? new Prisma.Decimal(c.companyAumUsd) : null, companyEmployees: c.companyEmployees,
    // A push is not a claim (B194): the owner is set, firstClaimedAt waits for a real one.
    ownerId: owner?.id ?? null, podId: owner?.podId ?? null, claimedAt: owner ? now : null,
    bellwetherContactId: c.bellwetherContactId, bellwetherUrl: c.bellwetherUrl, sourceNote: c.source, collectedAt: c.collectedAt,
    pushedByEmail: ctx.envelope.pushedBy.email, pushedByName: ctx.envelope.pushedBy.name ?? null, lawfulBasis: EEA_UK.has(c.country) ? 'legitimate_interest' : null,
  };
}

export function summarize(results: ContactResult[]): PushResponse['summary'] {
  const summary = { created: 0, duplicate_in_sandbox: 0, already_in_crm: 0, rejected: 0 };
  for (const r of results) summary[r.result] += 1;
  return summary;
}

// ---------------------------------------------------------------------------
// Idempotency (14.10)
// ---------------------------------------------------------------------------

const IDEMPOTENCY_DAYS = 7;
const STALE_MS = 120_000;
/** A push still PROCESSING this long was cut off (a restart, the database gone): the sweeper marks it failed (B012). */
export const STUCK_MS = 10 * 60_000;

export type PushOutcome = { status: 200; body: PushResponse } | ApiError;

/**
 * A push: replayed for the same key and body, refused for the same key and another body. The key is
 * compared in lower case (B170). The stored answer is the full one; the HTTP layer gives each caller
 * its contract version's view of it.
 */
export async function pushWithIdempotency(envelope: Envelope, rawBody: string, rawKey: string, now = new Date()): Promise<PushOutcome> {
  const key = rawKey.trim().toLowerCase();
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_DAYS * 86_400_000);
  // A key is remembered for 7 days; after that it is free again, and the old push keeps its results.
  const expired = await prisma.bellwetherPush.findFirst({ where: { idempotencyKey: key, createdAt: { lt: cutoff } }, select: { id: true } });
  if (expired) await prisma.bellwetherPush.update({ where: { id: expired.id }, data: { idempotencyKey: `expired:${expired.id}` } });
  let push = await prisma.bellwetherPush.findUnique({ where: { idempotencyKey: key } });
  if (push) {
    if (push.bodyHash !== bodyHash) return apiError(409, 'idempotency_conflict', 'This Idempotency-Key was used with a different body.');
    if (push.state === 'DONE' && push.response) return { status: 200, body: { ...(push.response as unknown as PushResponse), replayed: true } };
    if (push.state === 'PROCESSING' && now.getTime() - push.createdAt.getTime() < STALE_MS) return apiError(409, 'idempotency_in_progress', 'This push is still being processed.', { retryAfter: 5 });
    // A push cut off part-way (or swept as failed) runs again: what it created is now duplicate_in_sandbox.
    push = await prisma.bellwetherPush.update({ where: { id: push.id }, data: { createdAt: now, state: 'PROCESSING' } });
    await prisma.bellwetherPushItem.deleteMany({ where: { pushId: push.id } });
  } else {
    try {
      push = await prisma.bellwetherPush.create({ data: { idempotencyKey: key, bodyHash, state: 'PROCESSING', pushedByEmail: envelope.pushedBy.email, contactCount: envelope.contacts.length, createdAt: now } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return apiError(409, 'idempotency_in_progress', 'This push is still being processed.', { retryAfter: 5 });
      throw err;
    }
  }
  const { results, owner } = await runContacts(envelope, { write: true, pushId: push.id, now });
  const response: PushResponse = { pushId: push.id, replayed: false, receivedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), owner: owner ? { email: owner.email, name: owner.name } : null, summary: summarize(results), results };
  // The pod the push is for (From Bellwether scopes leaders by it): its owner's, else the one Bellwether named.
  const named = !owner && envelope.pod ? await prisma.pod.findFirst({ where: { archived: false, OR: [{ podOwnerValue: { equals: envelope.pod, mode: 'insensitive' } }, { name: { equals: envelope.pod, mode: 'insensitive' } }] }, select: { id: true } }) : null;
  await prisma.bellwetherPush.update({ where: { id: push.id }, data: { state: 'DONE', ownerId: owner?.id ?? null, podId: owner?.podId ?? named?.id ?? null, response: response as unknown as Prisma.InputJsonValue } });
  await logAudit({ entityType: 'bellwether', entityId: push.id, action: 'push_received', actor: { type: 'WEBHOOK', label: `bellwether:${envelope.pushedBy.email}` }, details: { ...response.summary, internalErrors: results.filter((r) => r.reason === 'internal_error').length } });
  return { status: 200, body: response };
}

/** The check before a push (14.14): the same results, nothing written. */
export async function checkContacts(envelope: Envelope, now = new Date()): Promise<PushResponse> {
  const { results, owner } = await runContacts(envelope, { write: false, now });
  return { pushId: null, replayed: false, receivedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), owner: owner ? { email: owner.email, name: owner.name } : null, summary: summarize(results), results };
}

/** The nightly purge: keys and stored answers older than 7 days are forgotten. Per-contact results stay. */
export async function purgeOldPushes(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_DAYS * 86_400_000);
  const old = await prisma.bellwetherPush.findMany({ where: { createdAt: { lt: cutoff }, NOT: { idempotencyKey: { startsWith: 'expired:' } } }, select: { id: true } });
  for (const p of old) await prisma.bellwetherPush.update({ where: { id: p.id }, data: { idempotencyKey: `expired:${p.id}`, response: Prisma.DbNull } });
  return old.length;
}

/**
 * B012: a push still PROCESSING long after it began was cut off (the app restarted, the database
 * went away mid-push). It is marked FAILED, with what it had answered so far; Bellwether's retry
 * with the same key runs it again.
 */
export async function sweepStuckPushes(now = new Date()): Promise<number> {
  const stuck = await prisma.bellwetherPush.findMany({ where: { state: 'PROCESSING', createdAt: { lt: new Date(now.getTime() - STUCK_MS) } }, select: { id: true, contactCount: true, _count: { select: { items: true } } } });
  for (const p of stuck) {
    const swept = await prisma.bellwetherPush.updateMany({ where: { id: p.id, state: 'PROCESSING' }, data: { state: 'FAILED' } });
    if (swept.count) await logAudit({ entityType: 'bellwether', entityId: p.id, action: 'push_swept', actor: { type: 'SYSTEM', label: 'Cadence' }, details: { contacts: p.contactCount, answered: p._count.items } });
  }
  return stuck.length;
}

export function errorBody(e: ApiError) {
  return { error: { code: e.code, message: e.message, ...(e.fields ? { fields: e.fields } : {}) } };
}
