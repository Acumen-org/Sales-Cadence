import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookAuthInput = {
  rawBody: string;
  headers: { get(name: string): string | null };
  /** Query string token (?token=...) if present. */
  queryToken: string | null;
  secret: string | null | undefined;
  token: string | null | undefined;
};

export type WebhookAuthResult = { ok: true; method: 'signature' | 'token' | 'open' } | { ok: false; reason: string };

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}:${body}`).digest('hex');
}

/**
 * Verify a Twenty webhook. If a secret is configured, the request must carry a valid
 * HMAC-SHA256 signature (`X-Twenty-Webhook-Signature` over `${timestamp}:${body}`, timestamp
 * from `X-Twenty-Webhook-Timestamp`; a plain HMAC of the body is accepted too). If a shared
 * token is configured, `?token=` must match. With neither configured the endpoint is open,
 * which is only acceptable on a private network.
 */
export function verifyWebhook(input: WebhookAuthInput): WebhookAuthResult {
  const secret = input.secret?.trim();
  const token = input.token?.trim();
  if (secret) {
    const signature = (input.headers.get('x-twenty-webhook-signature') ?? input.headers.get('x-webhook-signature') ?? '').trim();
    if (!signature) return { ok: false, reason: 'missing signature' };
    const timestamp = (input.headers.get('x-twenty-webhook-timestamp') ?? '').trim();
    const candidates = [
      timestamp ? signWebhook(secret, timestamp, input.rawBody) : null,
      createHmac('sha256', secret).update(input.rawBody).digest('hex'),
    ].filter((c): c is string => Boolean(c));
    const provided = signature.replace(/^sha256=/, '');
    if (!candidates.some((c) => safeEqual(c, provided))) return { ok: false, reason: 'invalid signature' };
    if (token && !(input.queryToken && safeEqual(token, input.queryToken))) return { ok: false, reason: 'invalid token' };
    return { ok: true, method: 'signature' };
  }
  if (token) {
    if (!input.queryToken || !safeEqual(token, input.queryToken)) return { ok: false, reason: 'invalid token' };
    return { ok: true, method: 'token' };
  }
  // No secret and no token is fine on a laptop and a liability in production: anyone who finds the
  // URL could post forged replies and opt-outs. Refuse unless the operator opts in explicitly.
  if (process.env.NODE_ENV === 'production' && process.env.CADENCE_WEBHOOK_OPEN !== '1') {
    return { ok: false, reason: 'webhook has no secret or token; set TWENTY_WEBHOOK_SECRET or CADENCE_WEBHOOK_TOKEN (or CADENCE_WEBHOOK_OPEN=1 to accept unsigned events)' };
  }
  return { ok: true, method: 'open' };
}

export type ParsedWebhookEvent = {
  objectType: string;
  eventName: string;
  record: Record<string, unknown>;
  recordId: string | null;
  updatedAt: string | null;
};

/**
 * Twenty payload shapes vary a little between versions:
 * `{ eventName: 'person.updated', objectMetadata: { nameSingular }, record: {...}, updatedFields }`
 * or older `{ eventType, ... }`. Be lenient and never throw.
 */
export function parseWebhookEvent(payload: unknown): ParsedWebhookEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const eventName = String(p.eventName ?? p.eventType ?? p.event ?? '').trim();
  const meta = (p.objectMetadata && typeof p.objectMetadata === 'object' ? (p.objectMetadata as Record<string, unknown>) : {}) as Record<string, unknown>;
  let objectType = typeof meta.nameSingular === 'string' ? meta.nameSingular : '';
  if (!objectType && eventName.includes('.')) objectType = eventName.split('.')[0];
  const record = (p.record && typeof p.record === 'object' ? p.record : p.data && typeof p.data === 'object' ? p.data : null) as Record<string, unknown> | null;
  if (!objectType || !record) return null;
  const recordId = typeof record.id === 'string' ? record.id : record.id != null ? String(record.id) : null;
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : typeof p.eventDate === 'string' ? p.eventDate : null;
  const action = eventName.includes('.') ? eventName.split('.').slice(1).join('.') : eventName || 'updated';
  return { objectType, eventName: `${objectType}.${action}`, record, recordId, updatedAt };
}
