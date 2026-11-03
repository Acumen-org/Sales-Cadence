import { NextResponse } from 'next/server';
import { apiError, authorize, checkContacts, errorBody, MAX_BATCH, pushWithIdempotency, rateLimit, readJson, validateEnvelope, type ApiError } from './bellwether-api';
import { decodeCursor, iso, statusByIds, statusChangedSince } from './status';

/** HTTP for the four Bellwether endpoints: one place that turns every refusal into the contract's error body. */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function errorResponse(e: ApiError): NextResponse {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (e.retryAfter) headers['retry-after'] = String(e.retryAfter);
  return NextResponse.json(errorBody(e), { status: e.status, headers });
}

const ok = (body: unknown) => NextResponse.json(body, { status: 200, headers: JSON_HEADERS });
const isError = (v: unknown): v is ApiError => Boolean(v && typeof v === 'object' && 'code' in v && 'status' in v);

async function guarded(work: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await work();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[bellwether] request failed', message);
    if (/connect|ECONNREFUSED|database|timed out|P1001|P1008|P2024/i.test(message)) return errorResponse(apiError(503, 'unavailable', 'Cadence cannot reach its database right now. Retry later.'));
    return errorResponse(apiError(500, 'internal', 'Something went wrong in Cadence. Retry once with the same key, then stop and report it.'));
  }
}

export async function handlePing(req: Request): Promise<NextResponse> {
  return guarded(async () => {
    const denied = await authorize(req.headers.get('x-cadence-api-key'));
    if (denied) return errorResponse(denied);
    return ok({ ok: true, version: '1', sandboxEnabled: true, maxBatch: MAX_BATCH, serverTime: iso(new Date()) });
  });
}

export async function handlePush(req: Request): Promise<NextResponse> {
  return guarded(async () => {
    const key = req.headers.get('x-cadence-api-key');
    const denied = (await authorize(key)) ?? rateLimit('push', key ?? '');
    if (denied) return errorResponse(denied);
    const read = await readJson(req);
    if (isError(read)) return errorResponse(read);
    const idempotencyKey = req.headers.get('idempotency-key')?.trim() || null;
    const envelope = validateEnvelope(read.body, { idempotencyKey, requireKey: true });
    if (isError(envelope)) return errorResponse(envelope);
    const outcome = await pushWithIdempotency(envelope, read.raw, idempotencyKey!);
    return isError(outcome) ? errorResponse(outcome) : ok(outcome.body);
  });
}

export async function handleCheck(req: Request): Promise<NextResponse> {
  return guarded(async () => {
    const key = req.headers.get('x-cadence-api-key');
    // The check counts against the push limit (14.14).
    const denied = (await authorize(key)) ?? rateLimit('push', key ?? '');
    if (denied) return errorResponse(denied);
    const read = await readJson(req);
    if (isError(read)) return errorResponse(read);
    const envelope = validateEnvelope(read.body, { idempotencyKey: null, requireKey: false });
    if (isError(envelope)) return errorResponse(envelope);
    return ok(await checkContacts(envelope));
  });
}

export async function handleStatus(req: Request): Promise<NextResponse> {
  return guarded(async () => {
    const key = req.headers.get('x-cadence-api-key');
    const denied = (await authorize(key)) ?? rateLimit('status', key ?? '');
    if (denied) return errorResponse(denied);
    const read = await readJson(req);
    if (isError(read)) return errorResponse(read);
    const b = (read.body && typeof read.body === 'object' ? read.body : {}) as Record<string, unknown>;
    const hasIds = b.bellwetherContactIds !== undefined;
    const hasSince = b.changedSince !== undefined;
    if (hasIds === hasSince) return errorResponse(apiError(422, 'invalid_request', 'Send exactly one of bellwetherContactIds or changedSince.', { fields: [{ path: 'body', problem: 'Send exactly one of bellwetherContactIds or changedSince.' }] }));
    if (hasIds) {
      const ids = b.bellwetherContactIds;
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id || id.length > 200)) return errorResponse(apiError(422, 'invalid_request', 'bellwetherContactIds must be 1 to 500 ids.', { fields: [{ path: 'bellwetherContactIds', problem: 'Give 1 to 500 ids, each 1 to 200 characters.' }] }));
      if (ids.length > MAX_BATCH) return errorResponse(apiError(413, 'payload_too_large', `More than ${MAX_BATCH} ids in one status request.`));
      return ok({ serverTime: iso(new Date()), nextCursor: null, results: await statusByIds(ids as string[]) });
    }
    const since = typeof b.changedSince === 'string' ? new Date(b.changedSince) : null;
    if (!since || Number.isNaN(since.getTime())) return errorResponse(apiError(422, 'invalid_request', 'changedSince must be an ISO 8601 time.', { fields: [{ path: 'changedSince', problem: 'Give an ISO 8601 UTC time.' }] }));
    const limit = b.limit === undefined || b.limit === null ? MAX_BATCH : Number(b.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) return errorResponse(apiError(422, 'invalid_request', 'limit must be 1 to 500.', { fields: [{ path: 'limit', problem: 'Give a whole number from 1 to 500.' }] }));
    const cursor = decodeCursor(typeof b.cursor === 'string' ? b.cursor : null);
    if (cursor === 'invalid') return errorResponse(apiError(422, 'invalid_request', 'cursor is not one Cadence gave.', { fields: [{ path: 'cursor', problem: 'Send the nextCursor from the previous answer, or null.' }] }));
    const page = await statusChangedSince(since, cursor, limit);
    return ok({ serverTime: iso(new Date()), nextCursor: page.nextCursor, results: page.results });
  });
}
