import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { databaseNow, prisma } from '../db';
import { env } from '../env';
import { bucketId, resetWindows, takeFromWindow, windowWait, WRONG_KEY_LIMIT } from '../rate-window';
import { todayIn } from '../dates';
import { databaseDown } from '../sandbox/bellwether-api';
import { buildReports, parseReportAudience, reportingRange, reportingTimezone } from '../reports-query';
import type { SessionUser } from '../auth/current-user';
import { clientIp, findKey, ipAllowed, SCOPES, type KeyRow } from './keys';
import { RESOURCES, toJson, type Resource } from './resources';

/**
 * The read API, /api/v1 (Notes/public-api-2026-11-08/CONTRACT.md): a Bearer key, GET only, one
 * shape for every list (data, nextCursor, serverTime) and every error ({ error: { code, message } }).
 * The session cookie means nothing here, and a key means nothing anywhere else.
 */

export const RATE_LIMIT = 120;
export const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

type Failure = { status: number; code: string; message: string; fields?: { path: string; problem: string }[]; retryAfter?: number };
const fail = (status: number, code: string, message: string, extra: Partial<Failure> = {}): Failure => ({ status, code, message, ...extra });
const isFailure = (v: unknown): v is Failure => Boolean(v && typeof v === 'object' && 'code' in v && 'status' in v && 'message' in v);
const invalid = (path: string, problem: string) => fail(422, 'invalid_request', `${path}: ${problem}`, { fields: [{ path, problem }] });

// ---------------------------------------------------------------------------
// Rate limit: 120 a minute per key, in the database (V09: every process shares it)
// ---------------------------------------------------------------------------

async function take(keyId: string, now = new Date()): Promise<{ remaining: number; retryAfter?: number }> {
  const taken = await takeFromWindow(`read:${keyId}`, RATE_LIMIT, now);
  return taken.ok ? { remaining: RATE_LIMIT - taken.used } : { remaining: 0, retryAfter: taken.retryAfter };
}
export function resetReadApiLimits(): Promise<void> { return resetWindows(); }

/**
 * Q19: wrong or made-up keys, per caller address: past 20 in a minute the caller is answered 429
 * before any key is looked up. Only for a known address (API_TRUSTED_PROXY_HOPS set): with no
 * address every caller would share one count, and a stranger could lock real keys out.
 */
export const BAD_KEY_LIMIT = WRONG_KEY_LIMIT;
// V09: counted in the database, so every server process shares the count.
const badKeyWindow = (ip: string) => `read-fail:${bucketId(ip)}`;
async function badKeysSpent(ip: string | null): Promise<number | null> {
  return ip ? windowWait(badKeyWindow(ip), BAD_KEY_LIMIT) : null;
}
async function noteBadKey(ip: string | null): Promise<void> {
  if (ip) await takeFromWindow(badKeyWindow(ip), Number.MAX_SAFE_INTEGER);
}

// ---------------------------------------------------------------------------
// Cursors: base64url JSON of the last row's sort values
// ---------------------------------------------------------------------------

type Cursor = { t?: string; id: string };
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(raw: string, changedMode: boolean): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!c || typeof c.id !== 'string' || !c.id) return null;
    if (changedMode !== (typeof c.t === 'string')) return null;
    if (changedMode && Number.isNaN(new Date(c.t).getTime())) return null;
    return c;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type Answer = { status: number; body: unknown; rows?: number };

function listQuery(r: Resource, q: URLSearchParams): { where: Record<string, unknown>[]; orderBy: Record<string, 'asc'>[]; take: number; changedMode: boolean } | Failure {
  const known = new Set(['limit', 'cursor', 'updatedSince', ...Object.keys(r.filters)]);
  for (const name of q.keys()) if (!known.has(name)) return fail(422, 'unsupported_filter', `${r.path} has no filter “${name}”. See GET /api/v1 for the ones it has.`, { fields: [{ path: name, problem: 'Not a filter of this resource.' }] });
  const limitRaw = q.get('limit');
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return invalid('limit', `Give a whole number from 1 to ${MAX_LIMIT}.`);
  const where: Record<string, unknown>[] = [];
  for (const [name, f] of Object.entries(r.filters)) {
    const value = q.get(name) ?? r.defaults?.[name];
    if (value === undefined) continue;
    const w = f.where(value);
    if ('problem' in w) return invalid(name, String(w.problem));
    where.push(w);
  }
  const sinceRaw = q.get('updatedSince');
  const changedMode = sinceRaw !== null;
  if (changedMode) {
    const since = new Date(sinceRaw);
    if (!/^\d{4}-\d{2}-\d{2}/.test(sinceRaw) || Number.isNaN(since.getTime())) return invalid('updatedSince', 'Give an ISO 8601 time.');
    where.push({ [r.changed]: { gte: since } });
  }
  const cursorRaw = q.get('cursor');
  if (cursorRaw) {
    const c = decodeCursor(cursorRaw, changedMode);
    if (!c) return invalid('cursor', 'Send the nextCursor from the previous answer, with the same updatedSince.');
    where.push(changedMode ? { OR: [{ [r.changed]: { gt: new Date(c.t!) } }, { [r.changed]: new Date(c.t!), id: { gt: c.id } }] } : { id: { gt: c.id } });
  }
  const orderBy = changedMode ? [{ [r.changed]: 'asc' as const }, { id: 'asc' as const }] : [{ id: 'asc' as const }];
  return { where, orderBy, take: limit, changedMode };
}

async function list(r: Resource, q: URLSearchParams): Promise<Answer> {
  const query = listQuery(r, q);
  if (isFailure(query)) return failure(query);
  // Taken before the read, so anything committed while it runs is at or after it (B062).
  const serverTime = (await databaseNow()).toISOString();
  const rows = (await r.find({ where: query.where.length ? { AND: query.where } : {}, orderBy: query.orderBy, take: query.take + 1 })) as Record<string, unknown>[];
  const more = rows.length > query.take;
  const page = more ? rows.slice(0, query.take) : rows;
  const last = page[page.length - 1];
  const nextCursor = more && last ? encodeCursor(query.changedMode ? { t: (last[r.changed] as Date).toISOString(), id: String(last.id) } : { id: String(last.id) }) : null;
  return { status: 200, body: { data: toJson(page), nextCursor, serverTime }, rows: page.length };
}

async function one(r: Resource, id: string, q: URLSearchParams): Promise<Answer> {
  if ([...q.keys()].length) return failure(fail(422, 'unsupported_filter', 'One record takes no query parameters.'));
  const row = await r.one(id);
  return row ? { status: 200, body: { data: toJson(row) }, rows: 1 } : failure(fail(404, 'not_found', `No ${r.path} record with id ${id}.`));
}

/** The Reports section's figures for one period, read as an admin would (every pod, every rep). */
async function reports(q: URLSearchParams): Promise<Answer> {
  const known = new Set(['from', 'to', 'audience', 'podId', 'userId']);
  for (const name of q.keys()) if (!known.has(name)) return failure(fail(422, 'unsupported_filter', `reports has no parameter “${name}”.`));
  const audience = q.get('audience');
  if (audience !== null && !['all', 'crm', 'cold'].includes(audience)) return failure(invalid('audience', 'Give all, crm or cold.'));
  for (const name of ['from', 'to']) {
    const v = q.get(name);
    if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return failure(invalid(name, 'Give a date as YYYY-MM-DD.'));
  }
  const tz = reportingTimezone();
  const today = todayIn(tz);
  const range = reportingRange(q.get('from') ?? undefined, q.get('to') ?? undefined, today);
  if (range.error) return failure(invalid('from', range.error));
  const reader: SessionUser = { id: 'read-api', email: '', name: 'Read API', role: 'ADMIN', timezone: tz, twentyMemberId: null, dailyCap: null, podIds: [], pods: [] };
  const report = await buildReports(reader, today, { range, podId: q.get('podId'), foUserId: q.get('userId'), audience: parseReportAudience(audience) });
  return { status: 200, body: { data: toJson({ timezone: tz, ...report }) }, rows: 1 };
}

function discovery(key: KeyRow): Answer {
  const allowed = RESOURCES.filter((r) => key.scopes.includes(r.scope)).map((r) => ({
    name: r.path, path: `/api/v1/${r.path}`, scope: r.scope, updatedSince: true, changedField: r.changed,
    filters: Object.fromEntries(Object.entries(r.filters).map(([k, f]) => [k, f.describe])),
    ...(r.oneOnly ? { detailOnly: [r.oneOnly] } : {}),
  }));
  if (key.scopes.includes('reports')) allowed.push({ name: 'reports', path: '/api/v1/reports', scope: 'reports', updatedSince: false, changedField: '', filters: { from: 'YYYY-MM-DD (default 28 days ago)', to: 'YYYY-MM-DD (default today)', audience: 'all, crm or cold', podId: 'Pod id', userId: 'User id of the rep' } });
  return {
    status: 200,
    body: { app: 'cadence', version: '1', key: { name: key.name, scopes: key.scopes, expiresAt: key.expiresAt?.toISOString() ?? null }, scopes: SCOPES, resources: allowed },
    rows: allowed.length,
  };
}

function failure(f: Failure): Answer {
  return { status: f.status, body: { error: { code: f.code, message: f.message, ...(f.fields ? { fields: f.fields } : {}) } } };
}

/** Which resource a path names, and the record id when it names one. */
function route(path: string): { resource: Resource; id: string | null } | 'reports' | 'root' | null {
  if (!path) return 'root';
  if (path === 'reports') return 'reports';
  for (const r of RESOURCES) {
    if (path === r.path) return { resource: r, id: null };
    if (path.startsWith(`${r.path}/`)) {
      const id = path.slice(r.path.length + 1);
      if (id && !id.includes('/')) {
        // Q20: a broken % escape names no record (404), it does not break the server (500).
        try { return { resource: r, id: decodeURIComponent(id) }; } catch { return null; }
      }
    }
  }
  return null;
}

async function answer(req: Request, key: KeyRow, ip: string | null): Promise<Answer> {
  if (!ipAllowed(ip, key.allowedIps)) {
    return failure(fail(403, 'forbidden', ip ? `This key may not be used from ${ip}.` : 'This key only works from listed IP addresses, and Cadence cannot see the caller’s address (API_TRUSTED_PROXY_HOPS is 0).'));
  }
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/v1\/?/, '').replace(/\/+$/, '');
  const target = route(path);
  if (target === null) return failure(fail(404, 'not_found', `No resource at /api/v1/${path}. GET /api/v1 lists them.`));
  if (target === 'root') return discovery(key);
  const scope = target === 'reports' ? 'reports' : target.resource.scope;
  if (!key.scopes.includes(scope)) return failure(fail(403, 'forbidden', `This key does not have the “${scope}” scope.`));
  if (target === 'reports') return reports(url.searchParams);
  return target.id === null ? list(target.resource, url.searchParams) : one(target.resource, target.id, url.searchParams);
}

function respond(a: Answer, requestId: string, limit?: { remaining: number; retryAfter?: number }): NextResponse {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId };
  if (limit) {
    headers['x-ratelimit-limit'] = String(RATE_LIMIT);
    headers['x-ratelimit-remaining'] = String(limit.remaining);
    if (limit.retryAfter) headers['retry-after'] = String(limit.retryAfter);
  }
  return NextResponse.json(a.body, { status: a.status, headers });
}

export async function handleReadApi(req: Request): Promise<NextResponse> {
  const started = Date.now();
  const requestId = randomUUID();
  if (req.method !== 'GET') {
    const r = respond(failure(fail(405, 'method_not_allowed', 'The API is read only: GET is the only method.')), requestId);
    r.headers.set('allow', 'GET');
    return r;
  }
  let key: KeyRow | null = null;
  let a: Answer;
  let limit: { remaining: number; retryAfter?: number } | undefined;
  const ip = clientIp(req.headers, env().API_TRUSTED_PROXY_HOPS);
  try {
    const auth = req.headers.get('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? null;
    const wait = await badKeysSpent(ip);
    if (wait) return respond(failure(fail(429, 'rate_limited', `More than ${BAD_KEY_LIMIT} requests with a wrong key in a minute.`)), requestId, { remaining: 0, retryAfter: wait });
    key = await findKey(token);
    if (!key) {
      await noteBadKey(ip);
      return respond(failure(fail(401, 'unauthorized', 'Send Authorization: Bearer <key>, with a key that is live (not revoked or expired).')), requestId);
    }
    limit = await take(key.id);
    a = limit.retryAfter ? failure(fail(429, 'rate_limited', `More than ${RATE_LIMIT} requests in a minute.`)) : await answer(req, key, ip);
  } catch (err) {
    console.error('[read-api] request failed', { requestId, error: err instanceof Error ? err.message : String(err) });
    a = databaseDown(err) ? failure(fail(503, 'unavailable', 'Cadence cannot reach its database right now. Retry later.')) : failure(fail(500, 'internal', `Something went wrong in Cadence (request ${requestId}).`));
  }
  if (key) {
    const now = new Date();
    // The path only: query values can be personal data (an email to filter by), and the log keeps 90 days of it.
    const path = new URL(req.url).pathname.slice(0, 300);
    await Promise.all([
      prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now, lastUsedIp: ip } }),
      prisma.apiRequestLog.create({ data: { keyId: key.id, method: req.method, path, status: a.status, rows: a.rows ?? null, ip, ms: Date.now() - started } }),
    ]).catch((err) => console.error('[read-api] could not log the request', err instanceof Error ? err.message : String(err)));
  }
  return respond(a, requestId, limit);
}
