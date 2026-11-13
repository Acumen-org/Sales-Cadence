import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';

/**
 * Keys for the read API (Notes/public-api-2026-11-08/CONTRACT.md). A key is `cad_<id>_<secret>`: the
 * id finds the row, the secret is 32 random bytes, and only sha256(whole key) is stored, compared in
 * constant time. Admins make and revoke them in Settings > API keys.
 */

export const SCOPES = [
  { key: 'team', label: 'Team', what: 'Users and pods' },
  { key: 'crm', label: 'CRM', what: 'People and companies (Cadence’s copy of Twenty)' },
  { key: 'campaigns', label: 'Campaigns', what: 'Sequences, campaigns and enrollments' },
  { key: 'tasks', label: 'Tasks', what: 'Tasks and next actions' },
  { key: 'activity', label: 'Activity', what: 'Touches and calls' },
  // S03: meetings carry transcripts of calls with outside people, so they need their own scope.
  { key: 'meetings', label: 'Meetings', what: 'Approved meetings, with their notes, analysis and full transcripts' },
  { key: 'cold-outreach', label: 'Cold outreach', what: 'Cold contacts, their notes, and do-not-contact entries' },
  { key: 'reports', label: 'Reports', what: 'The Reports section’s numbers' },
] as const;
export type Scope = (typeof SCOPES)[number]['key'];
export const isScope = (s: string): s is Scope => SCOPES.some((x) => x.key === s);

export const DEFAULT_EXPIRY_DAYS = 90;
/** How long the request log keeps a row. */
export const LOG_DAYS = 90;
export const MAX_EXPIRY_DAYS = 365;
const KEY_RE = /^cad_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const hashKey = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');

function newId(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

export type KeyInput = { name: string; scopes: string[]; expiresInDays: number | null; allowedIps: string[] };

/** What is wrong with a new key's settings, or null. */
export function validateKeyInput(input: KeyInput): string | null {
  if (!input.name.trim() || input.name.trim().length > 80) return 'Give the key a name of 1 to 80 characters, e.g. the tool that will use it.';
  if (!input.scopes.length) return 'Choose at least one kind of data the key may read.';
  const unknown = input.scopes.find((s) => !isScope(s));
  if (unknown) return `“${unknown}” is not a scope.`;
  if (input.expiresInDays !== null && (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > MAX_EXPIRY_DAYS)) return `Expiry must be 1 to ${MAX_EXPIRY_DAYS} days.`;
  const bad = input.allowedIps.find((ip) => !parseCidr(ip));
  if (bad) return `“${bad}” is not an IP address or CIDR range.`;
  return null;
}

/** Makes a key; the answer is the only time the whole key exists outside the caller's hands. */
export async function createApiKey(input: KeyInput, by: { id: string; name: string }, actor: AuditActor, now = new Date()) {
  const problem = validateKeyInput(input);
  if (problem) return { ok: false as const, error: problem };
  const id = newId();
  const key = `cad_${id}_${randomBytes(32).toString('base64url')}`;
  const scopes = [...new Set(input.scopes)];
  const expiresAt = input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * 86_400_000);
  await prisma.apiKey.create({ data: { id, name: input.name.trim(), keyHash: hashKey(key), scopes, allowedIps: input.allowedIps, expiresAt, createdById: by.id, createdByName: by.name } });
  await logAudit({ entityType: 'api_key', entityId: id, action: 'api_key_created', actor, details: { name: input.name.trim(), scopes, expiresAt: expiresAt?.toISOString() ?? null, allowedIps: input.allowedIps } });
  return { ok: true as const, id, key };
}

export async function revokeApiKey(id: string, by: { name: string }, actor: AuditActor, now = new Date()) {
  const row = await prisma.apiKey.findUnique({ where: { id } });
  if (!row) return { ok: false as const, error: 'That key does not exist.' };
  if (row.revokedAt) return { ok: false as const, error: 'That key is already revoked.' };
  await prisma.apiKey.update({ where: { id }, data: { revokedAt: now, revokedByName: by.name } });
  await logAudit({ entityType: 'api_key', entityId: id, action: 'api_key_revoked', actor, details: { name: row.name } });
  return { ok: true as const, name: row.name };
}

export type KeyRow = { id: string; name: string; scopes: Scope[]; allowedIps: string[]; expiresAt: Date | null };

/** The key's row when the bearer token is a live key, else why not (always the same 401 to the caller). */
export async function findKey(token: string | null, now = new Date()): Promise<KeyRow | null> {
  const m = KEY_RE.exec(token ?? '');
  if (!m) return null;
  const row = await prisma.apiKey.findUnique({ where: { id: m[1] } });
  if (!row) return null;
  const given = Buffer.from(hashKey(token!), 'hex');
  const stored = Buffer.from(row.keyHash, 'hex');
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;
  if (row.revokedAt || (row.expiresAt && row.expiresAt <= now)) return null;
  return { id: row.id, name: row.name, scopes: row.scopes.filter(isScope), allowedIps: row.allowedIps, expiresAt: row.expiresAt };
}

// ---------------------------------------------------------------------------
// IP allowlists
// ---------------------------------------------------------------------------

type Cidr = { v: 4 | 6; bits: bigint; prefix: number };

function ipToBigInt(ip: string): { v: 4 | 6; n: bigint } | null {
  const kind = isIP(ip);
  if (kind === 4) return { v: 4, n: ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n) };
  if (kind !== 6) return null;
  // An IPv4 address written as IPv6 (::ffff:1.2.3.4) is matched as the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return ipToBigInt(mapped[1]);
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

export function parseCidr(entry: string): Cidr | null {
  const [addr, len, extra] = entry.trim().split('/');
  if (extra !== undefined) return null;
  const ip = ipToBigInt(addr);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const prefix = len === undefined ? max : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (len !== undefined && !/^\d+$/.test(len))) return null;
  return { v: ip.v, bits: ip.n, prefix };
}

export function ipAllowed(ip: string | null, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const addr = ip ? ipToBigInt(ip) : null;
  if (!addr) return false;
  return allowed.some((entry) => {
    const c = parseCidr(entry);
    if (!c || c.v !== addr.v) return false;
    const width = BigInt(c.v === 4 ? 32 : 128);
    const shift = width - BigInt(c.prefix);
    return (addr.n >> shift) === (c.bits >> shift);
  });
}

/** The caller's address: the entry the trusted proxies wrote into X-Forwarded-For, or null when none is trusted. */
export function clientIp(headers: Headers, trustedHops: number): string | null {
  if (trustedHops < 1) return null;
  const hops = (headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = hops[hops.length - trustedHops];
  return ip && isIP(ip) ? ip : null;
}

/** Request log rows older than 90 days go; the nightly job runs this. */
export async function pruneReadApiLog(now = new Date()) {
  const { count } = await prisma.apiRequestLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - LOG_DAYS * 86_400_000) } } });
  return { removed: count };
}
