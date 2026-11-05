import { createHash, timingSafeEqual } from 'node:crypto';
import { Prisma, type Role, type SandboxContact } from '@prisma/client';
import { prisma } from '../db';
import { env } from '../env';
import { logAudit } from '../audit';
import { getSettings, getTwentyConnection } from '../settings';
import { twentyPersonUrl } from '../twenty/urls';
import { getTwentyClient, type TwentyClient } from '../twenty';
import { dedupeContact, possibleCrmMatch, refreshCrmCopyFor, type DedupeInput, type MatchedOn } from './dedupe';
import { isRoleEmail, normalizeCrd, normalizeDomain, normalizeEmail, normalizeLinkedin, parsePhone, PHONE_TYPES, sandboxSortName, toE164, type ExtraPhone } from './normalize';
import { recordRefusal, type RefusalMatch } from './status';
import { podForOwner } from '../outreach/transfer';

/**
 * The Bellwether push API (contract: "Shared contract with Bellwether" in
 * docs/outreach-sandbox-plan.md). Bellwether pushes contacts, never firms, into the sandbox; Cadence
 * dedupes them against the sandbox and the CRM and answers per contact. The check endpoint (14.14)
 * runs the same pipeline and writes nothing.
 */

export const MAX_BATCH = 500;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const PRODUCT_VALUES = ['PHH', 'TOLLBOOTH', 'ACUBOOTH', 'GLYNAC'] as const;
const OWNER_ROLES: Role[] = ['ADMIN', 'JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'];
const EEA_UK = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB']);

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
  if (!(await getSettings()).sandbox.enabled) return apiError(503, 'integration_disabled', 'The sandbox is switched off in Cadence.');
  const given = (header ?? '').trim();
  const previous = e.BELLWETHER_API_KEY_PREVIOUS?.trim();
  const ok = Boolean(given) && (sameKey(given, current) || (previous ? sameKey(given, previous) : false));
  return ok ? null : apiError(401, 'unauthorized', 'The X-Cadence-Api-Key header is missing or wrong.');
}

/** 30 push (and check) requests and 60 status requests a minute per key, per process. */
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
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return apiError(413, 'payload_too_large', 'The body is over 2 MB.');
  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return apiError(413, 'payload_too_large', 'The body is over 2 MB.');
  try { return { raw, body: JSON.parse(raw) }; } catch { return apiError(400, 'invalid_json', 'The body is not JSON.'); }
}

// ---------------------------------------------------------------------------
// Validation and normalisation (14.4, 14.5)
// ---------------------------------------------------------------------------

export type Envelope = { pushedBy: { email: string; name: string | null; microsoftObjectId: string | null }; assignTo: { email: string } | null; pod: string | null; contacts: unknown[] };

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
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

const strList = (v: unknown, maxItems: number, maxLen: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && Boolean(x.trim()) && x.trim().length <= maxLen).map((x) => x.trim()).slice(0, maxItems) : []);
const warn = (code: string, field: string, detail: string): Warning => ({ code, field, crmPersonId: null, detail });

export function normalizeContact(raw: unknown): { ok: true; contact: PushContact } | { ok: false; id: string; detail: string } {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = typeof c.bellwetherContactId === 'string' ? c.bellwetherContactId : '';
  if (!id || id.length > 200) return { ok: false, id, detail: 'bellwetherContactId is missing or longer than 200 characters' };
  const firstName = str(c.firstName, 100);
  if (!firstName) return { ok: false, id, detail: typeof c.firstName === 'string' && c.firstName.trim() ? 'firstName is longer than 100 characters' : 'firstName is empty' };
  const lastName = str(c.lastName, 100);
  if (!lastName) return { ok: false, id, detail: typeof c.lastName === 'string' && c.lastName.trim() ? 'lastName is longer than 100 characters' : 'lastName is empty' };
  const firm = (c.firm && typeof c.firm === 'object' ? c.firm : null) as Record<string, unknown> | null;
  if (!firm) return { ok: false, id, detail: 'firm is missing' };
  const firmName = str(firm.name, 200);
  if (!firmName) return { ok: false, id, detail: 'firm.name is empty' };

  const warnings: Warning[] = [];
  const country = (str(c.country, 2) ?? 'US').toUpperCase();
  let email: string | null = null;
  if (c.email != null && c.email !== '') {
    email = typeof c.email === 'string' && c.email.length <= 254 ? normalizeEmail(c.email) : null;
    if (!email) warnings.push(warn('email_dropped', 'email', 'The email address was not valid and was left out.'));
  }
  const additionalEmails = [...new Set(strList(c.additionalEmails, 5, 254).map((e) => normalizeEmail(e)).filter((e): e is string => Boolean(e) && e !== email))];
  const verification = ['valid', 'risky', 'unknown'].includes(String(c.emailVerification)) ? String(c.emailVerification) : 'unknown';
  const phoneType = (PHONE_TYPES as readonly string[]).includes(String(c.phoneType)) ? String(c.phoneType) : 'unknown';
  let phone: string | null = null;
  let phoneExtension = typeof c.phoneExtension === 'string' && /^\d{1,10}$/.test(c.phoneExtension.trim()) ? c.phoneExtension.trim() : null;
  if (c.phone != null && c.phone !== '') {
    const parsed = typeof c.phone === 'string' && c.phone.length <= 40 ? parsePhone(c.phone, country) : null;
    if (parsed) { phone = parsed.e164; phoneExtension = phoneExtension ?? parsed.extension; }
    else warnings.push(warn('phone_dropped', 'phone', 'The phone number could not be read and was left out.'));
  }
  const additionalPhones: ExtraPhone[] = [];
  if (Array.isArray(c.additionalPhones)) {
    for (const item of c.additionalPhones.slice(0, 5)) {
      const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      const number = typeof p.number === 'string' ? toE164(p.number, country) : null;
      if (!number) { warnings.push(warn('phone_dropped', 'additionalPhones', 'An additional phone number could not be read and was left out.')); continue; }
      if (number === phone || additionalPhones.some((x) => x.number === number)) continue;
      additionalPhones.push({ number, type: (PHONE_TYPES as readonly string[]).includes(String(p.type)) ? String(p.type) : 'unknown' });
    }
  }
  let linkedinUrl: string | null = null;
  if (c.linkedinUrl != null && c.linkedinUrl !== '') {
    linkedinUrl = typeof c.linkedinUrl === 'string' ? normalizeLinkedin(c.linkedinUrl) : null;
    if (!linkedinUrl) warnings.push(warn('linkedin_dropped', 'linkedinUrl', 'The LinkedIn URL is not a person profile and was left out.'));
  }
  const products = strList(c.productInterest, 10, 50).map((p) => p.toUpperCase());
  const productInterest = products.filter((p) => (PRODUCT_VALUES as readonly string[]).includes(p));
  for (const p of products.filter((x) => !productInterest.includes(x))) warnings.push(warn('product_dropped', 'productInterest', `${p} is not a product Twenty knows and was left out.`));
  const website = str(firm.website, 500);
  const companyDomain = normalizeDomain(str(firm.domain, 255)) ?? normalizeDomain(website);
  const aum = typeof firm.aumUsd === 'number' && Number.isFinite(firm.aumUsd) && firm.aumUsd >= 0 ? String(Math.round(firm.aumUsd)) : null;
  const employees = typeof firm.employees === 'number' && Number.isInteger(firm.employees) && firm.employees >= 0 ? firm.employees : null;
  return {
    ok: true,
    contact: {
      bellwetherContactId: id, firstName, lastName, jobTitle: str(c.jobTitle, 200), email, emailVerification: verification, additionalEmails,
      phone, phoneType, phoneExtension, additionalPhones, linkedinUrl, city: str(c.city, 100), state: str(c.state, 100), country,
      individualCrd: normalizeCrd(typeof c.individualCrd === 'string' || typeof c.individualCrd === 'number' ? c.individualCrd : null),
      designations: strList(c.designations, 20, 20), productInterest: [...new Set(productInterest)], tags: strList(c.tags, 20, 50),
      notes: str(c.notes, 5000), bellwetherUrl: typeof c.bellwetherUrl === 'string' && /^https:\/\//i.test(c.bellwetherUrl.trim()) ? c.bellwetherUrl.trim() : null,
      source: str(c.source, 200), collectedAt: typeof c.collectedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(c.collectedAt) ? c.collectedAt.slice(0, 10) : null,
      doNotContact: c.doNotContact === true,
      companyName: firmName, companyDomain, companyCrd: normalizeCrd(typeof firm.crd === 'string' || typeof firm.crd === 'number' ? firm.crd : null),
      companyWebsite: website, companyCity: str(firm.city, 100), companyState: str(firm.state, 100), companyCountry: str(firm.country, 2)?.toUpperCase() ?? null,
      companyPhone: typeof firm.phone === 'string' ? toE164(firm.phone, country) : null, companyAumUsd: aum, companyEmployees: employees,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Ownership (14.7)
// ---------------------------------------------------------------------------

export type Owner = { id: string; email: string; name: string; podId: string | null } | null;

export async function resolveOwner(env: Envelope): Promise<{ owner: Owner; podIgnored: boolean }> {
  const users = await prisma.user.findMany({ where: { active: true }, include: { pods: { include: { pod: true } } } });
  const target = env.assignTo?.email ?? env.pushedBy.email;
  const byObject = !env.assignTo && env.pushedBy.microsoftObjectId ? users.find((u) => u.microsoftId && u.microsoftId.toLowerCase() === env.pushedBy.microsoftObjectId!.toLowerCase()) : undefined;
  const user = byObject ?? users.find((u) => u.email.toLowerCase() === target) ?? users.find((u) => u.aliases.some((a) => a.toLowerCase() === target));
  if (!user || !OWNER_ROLES.includes(user.role)) return { owner: null, podIgnored: Boolean(env.pod) };
  const pods = user.pods.map((p) => p.pod).filter((p) => !p.archived);
  const named = env.pod ? pods.find((p) => p.podOwnerValue === env.pod) : undefined;
  // B050: an owner's contact always has a pod: the one Bellwether named, else the owner's only pod,
  // else (an owner in several pods, the push naming none) the first of theirs by name. An owner in
  // no pod (an admin) does not own it: the contact arrives unclaimed.
  const choice = podForOwner({ name: user.name, podIds: pods.map((p) => p.id) }, null, named?.id);
  const podId = choice.ok ? choice.podId : [...pods].sort((a, b) => a.name.localeCompare(b.name))[0]?.id ?? null;
  if (!podId) return { owner: null, podIgnored: Boolean(env.pod) };
  return { owner: { id: user.id, email: user.email, name: user.name, podId }, podIgnored: Boolean(env.pod && !named) };
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
};

export type PushResponse = {
  pushId: string | null;
  replayed: boolean;
  receivedAt: string;
  owner: { email: string; name: string } | null;
  summary: { created: number; duplicate_in_sandbox: number; already_in_crm: number; rejected: number };
  results: ContactResult[];
};

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

/** Empty fields of the existing contact that the push would fill; nothing is ever overwritten. */
export function fillPlan(existing: SandboxContact, c: PushContact): { fields: string[]; data: Prisma.SandboxContactUpdateInput; alias: string | null } {
  const fields: string[] = [];
  const data: Record<string, unknown> = {};
  for (const [field, column, value] of FILLABLE) {
    const v = value(c);
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

async function ownerOfPerson(memberId: string | null): Promise<{ email: string; name: string } | null> {
  if (!memberId) return null;
  const u = await prisma.user.findFirst({ where: { twentyMemberId: memberId }, select: { email: true, name: true } });
  return u ?? null;
}

const REASON_DETAIL: Record<string, string> = {
  internal_contact: 'This is one of Acumen\'s own addresses or firms.',
  do_not_contact: 'Bellwether marked this contact do not contact.',
  duplicate_in_request: 'The same contact appears earlier in this push.',
};

/**
 * Judge every contact of a push. With `write` the sandbox is changed (created, filled, noted) and the
 * outcome recorded for the status endpoint; without it (the check endpoint) nothing is written.
 */
export async function runContacts(envelope: Envelope, opts: { write: boolean; pushId?: string | null; now?: Date }): Promise<{ results: ContactResult[]; owner: Owner }> {
  const now = opts.now ?? new Date();
  const { owner, podIgnored } = await resolveOwner(envelope);
  const conn = await getTwentyConnection();
  const results: ContactResult[] = [];
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  const parsedAll = envelope.contacts.map(normalizeContact);
  // Twenty is asked once per push, before any contact is judged (dedupe.ts).
  const valid = parsedAll.flatMap((p) => (p.ok && !p.contact.doNotContact ? [p.contact] : []));
  if (valid.length) {
    let client: TwentyClient | null = null;
    try { client = await getTwentyClient(); } catch { client = null; }
    if (client) await refreshCrmCopyFor(valid, client);
  }
  for (const parsed of parsedAll) {
    if (!parsed.ok) { results.push(reject(parsed.id, 'invalid_field', parsed.detail)); continue; }
    const c = parsed.contact;
    const warnings = [...c.warnings];
    if (podIgnored) warnings.push({ code: 'pod_ignored', field: 'pod', crmPersonId: null, detail: owner ? `${owner.name} does not work pod ${envelope.pod}, so it was not used.` : 'The contact has no owner in Cadence, so the pod was not used.' });
    if (seenIds.has(c.bellwetherContactId) || (c.email && seenEmails.has(c.email))) { results.push(reject(c.bellwetherContactId, 'duplicate_in_request', REASON_DETAIL.duplicate_in_request, warnings)); continue; }
    seenIds.add(c.bellwetherContactId);
    if (c.email) seenEmails.add(c.email);
    if (c.doNotContact) { results.push(reject(c.bellwetherContactId, 'do_not_contact', REASON_DETAIL.do_not_contact, warnings)); continue; }

    const result = opts.write
      ? await prisma.$transaction(async (tx) => {
          // One push at a time decides who is new, so two pushes of the same person cannot both create it.
          await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('bellwether-push'))`;
          return judgeOne(c, warnings, { owner, envelope, conn, now, write: true, tx });
        }, { timeout: 20_000 })
      : await judgeOne(c, warnings, { owner, envelope, conn, now, write: false, tx: prisma });
    results.push(result);
    if (opts.write && opts.pushId) {
      await prisma.bellwetherPushItem.create({ data: { pushId: opts.pushId, bellwetherContactId: result.bellwetherContactId, result: result.result, reason: result.reason, sandboxContactId: result.cadenceContactId, crmPersonId: result.crmPersonId } });
      if (result.result === 'already_in_crm') await recordRefusal(result.bellwetherContactId, 'already_in_crm', result.crmPersonId, now, refusalMatches.get(result)?.on ?? null);
      if (result.result === 'rejected' && result.reason === 'suppressed') await recordRefusal(result.bellwetherContactId, 'opted_out', refusalMatches.get(result)?.personId ?? null, now, refusalMatches.get(result)?.on ?? null);
    }
  }
  return { results, owner };
}

type JudgeCtx = { owner: Owner; envelope: Envelope; conn: { baseUrl: string | null }; now: Date; write: boolean; tx: Prisma.TransactionClient | typeof prisma };

/** What each refused result matched on, for the refusal Bellwether keeps reading (N011); never in the response. */
const refusalMatches = new WeakMap<ContactResult, { on: RefusalMatch; personId: string | null }>();
const KEY_MATCH: Record<string, RefusalMatch> = { email: 'email', phone: 'phone_personal', phone_subject: 'phone_shared', linkedin: 'linkedin', bellwether_id: 'bellwether_id', individual_crd: 'individual_crd' };
const SUPPRESSED_WORDS: Record<string, string> = { bellwether_id: 'Bellwether record', individual_crd: 'individual CRD', phone_subject: 'phone' };

async function judgeOne(c: PushContact, warnings: Warning[], ctx: JudgeCtx): Promise<ContactResult> {
  const { owner, tx } = ctx;
  const verdict = await dedupeContact(c, tx);
  const base = { ...blank(c.bellwetherContactId), warnings };
  const matched = (r: ContactResult, on: RefusalMatch | null, personId: string | null = r.crmPersonId) => { if (on) refusalMatches.set(r, { on, personId }); return r; };
  if (verdict.kind === 'suppressed') return matched({ ...base, reason: 'suppressed', detail: `This contact's ${SUPPRESSED_WORDS[verdict.key.kind] ?? verdict.key.kind} is on Cadence's suppression list.` }, KEY_MATCH[verdict.key.kind] ?? null);
  if (verdict.kind === 'internal_contact') return { ...base, reason: 'internal_contact', detail: REASON_DETAIL.internal_contact };
  if (verdict.kind === 'blocked_account') return { ...base, reason: 'blocked_account', detail: verdict.detail };
  // N003: the same person by name and firm is Do not contact in the CRM. Bellwether reads opted_out.
  if (verdict.kind === 'crm_do_not_contact') return matched({ ...base, reason: 'suppressed', detail: `${verdict.person.name} is marked Do not contact in the CRM.` }, 'name_firm', verdict.person.id);
  if (verdict.kind === 'already_in_crm' || verdict.kind === 'moved_tombstone') {
    const personId = verdict.kind === 'already_in_crm' ? verdict.person.id : verdict.contact.twentyPersonId;
    const ownerOf = verdict.kind === 'already_in_crm' ? await ownerOfPerson(verdict.person.ownerMemberId) : null;
    const on: RefusalMatch = verdict.kind === 'moved_tombstone' ? 'bellwether_id' : verdict.matchedOn === 'linkedin_url' ? 'linkedin' : verdict.matchedOn === 'phone' ? (verdict.sharedLine ? 'phone_shared' : 'phone_personal') : verdict.matchedOn === 'bellwether_contact_id' ? 'bellwether_id' : verdict.matchedOn;
    return matched({ ...base, result: 'already_in_crm', matchedOn: verdict.kind === 'already_in_crm' ? verdict.matchedOn : 'bellwether_contact_id', crmPersonId: personId, crmUrl: personId ? twentyPersonUrl(ctx.conn.baseUrl, personId) : null, ownerEmail: ownerOf?.email ?? null, ownerName: ownerOf?.name ?? null }, on);
  }
  if (verdict.kind === 'duplicate_in_sandbox') {
    const existing = verdict.contact;
    const plan = fillPlan(existing, c);
    if (ctx.write && Object.keys(plan.data).length) {
      await tx.sandboxContact.update({ where: { id: existing.id }, data: plan.data });
      await logAudit({ entityType: 'sandbox_contact', entityId: existing.id, action: 'filled_from_push', actor: { type: 'WEBHOOK', label: `bellwether:${ctx.envelope.pushedBy.email}` }, details: { fields: plan.fields } }, tx);
    }
    const holder = existing.ownerId ? await tx.user.findUnique({ where: { id: existing.ownerId }, select: { email: true, name: true } }) : null;
    return { ...base, result: 'duplicate_in_sandbox', cadenceContactId: existing.id, matchedOn: verdict.matchedOn, ownerEmail: holder?.email ?? null, ownerName: holder?.name ?? null, filledFields: plan.fields };
  }
  const possible = await possibleCrmMatch(c, tx);
  const allWarnings = possible ? [...warnings, { code: 'possible_crm_match', field: null, crmPersonId: possible, detail: 'Twenty has a person with this name at the same firm.' }] : warnings;
  if (!ctx.write) return { ...base, result: 'created', warnings: allWarnings, ownerEmail: owner?.email ?? null, ownerName: owner?.name ?? null };
  // A contact retention removed keeps its Bellwether id only until the person is pushed again.
  await tx.sandboxContact.updateMany({ where: { status: 'REMOVED', bellwetherContactId: c.bellwetherContactId }, data: { bellwetherContactId: null } });
  const created = await tx.sandboxContact.create({ data: { ...sandboxRowFromPush(c, owner, ctx), possibleCrmPersonId: possible ?? null } });
  if (c.notes) await tx.sandboxNote.create({ data: { sandboxContactId: created.id, body: c.notes, authorName: ctx.envelope.pushedBy.name ? `${ctx.envelope.pushedBy.name} (Bellwether)` : 'Bellwether' } });
  await logAudit({ entityType: 'sandbox_contact', entityId: created.id, action: 'pushed', actor: { type: 'WEBHOOK', label: `bellwether:${ctx.envelope.pushedBy.email}` }, details: { bellwetherContactId: c.bellwetherContactId, ownerId: owner?.id ?? null } }, tx);
  return { ...base, result: 'created', cadenceContactId: created.id, warnings: allWarnings, ownerEmail: owner?.email ?? null, ownerName: owner?.name ?? null };
}

function sandboxRowFromPush(c: PushContact, owner: Owner, ctx: JudgeCtx): Prisma.SandboxContactUncheckedCreateInput {
  return {
    source: 'BELLWETHER', firstName: c.firstName, lastName: c.lastName, sortName: sandboxSortName(c.firstName, c.lastName), jobTitle: c.jobTitle,
    email: c.email, emailIsRole: isRoleEmail(c.email), emailVerification: c.emailVerification, additionalEmails: c.additionalEmails, phone: c.phone, phoneType: c.phoneType,
    phoneExtension: c.phoneExtension, additionalPhones: c.additionalPhones, linkedinUrl: c.linkedinUrl, city: c.city, state: c.state, country: c.country,
    individualCrd: c.individualCrd, designations: c.designations, productInterest: c.productInterest, tags: c.tags,
    companyName: c.companyName, companyDomain: c.companyDomain, companyWebsite: c.companyWebsite, companyCrd: c.companyCrd, companyCity: c.companyCity,
    companyState: c.companyState, companyCountry: c.companyCountry, companyPhone: c.companyPhone,
    companyAumUsd: c.companyAumUsd ? new Prisma.Decimal(c.companyAumUsd) : null, companyEmployees: c.companyEmployees,
    ownerId: owner?.id ?? null, podId: owner?.podId ?? null, claimedAt: owner ? ctx.now : null,
    bellwetherContactId: c.bellwetherContactId, bellwetherUrl: c.bellwetherUrl, sourceNote: c.source, collectedAt: c.collectedAt,
    pushedByEmail: ctx.envelope.pushedBy.email, pushedByName: ctx.envelope.pushedBy.name ?? null, lawfulBasis: EEA_UK.has(c.country) ? 'legitimate_interest' : null, statusChangedAt: ctx.now,
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

export type PushOutcome = { status: 200; body: PushResponse } | ApiError;

/** A push: replayed for the same key and body, refused for the same key and another body. */
export async function pushWithIdempotency(envelope: Envelope, rawBody: string, key: string, now = new Date()): Promise<PushOutcome> {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_DAYS * 86_400_000);
  // A key is remembered for 7 days; after that it is free again, and the old push keeps its results.
  const expired = await prisma.bellwetherPush.findFirst({ where: { idempotencyKey: key, createdAt: { lt: cutoff } }, select: { id: true } });
  if (expired) await prisma.bellwetherPush.update({ where: { id: expired.id }, data: { idempotencyKey: `expired:${expired.id}` } });
  let push = await prisma.bellwetherPush.findUnique({ where: { idempotencyKey: key } });
  if (push) {
    if (push.bodyHash !== bodyHash) return apiError(409, 'idempotency_conflict', 'This Idempotency-Key was used with a different body.');
    if (push.state === 'DONE' && push.response) return { status: 200, body: { ...(push.response as unknown as PushResponse), replayed: true } };
    if (now.getTime() - push.createdAt.getTime() < STALE_MS) return apiError(409, 'idempotency_in_progress', 'This push is still being processed.', { retryAfter: 5 });
    push = await prisma.bellwetherPush.update({ where: { id: push.id }, data: { createdAt: now } });
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
  await prisma.bellwetherPush.update({ where: { id: push.id }, data: { state: 'DONE', ownerId: owner?.id ?? null, response: response as unknown as Prisma.InputJsonValue } });
  await logAudit({ entityType: 'bellwether', entityId: push.id, action: 'push_received', actor: { type: 'WEBHOOK', label: `bellwether:${envelope.pushedBy.email}` }, details: { ...response.summary } });
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

export function errorBody(e: ApiError) {
  return { error: { code: e.code, message: e.message, ...(e.fields ? { fields: e.fields } : {}) } };
}
