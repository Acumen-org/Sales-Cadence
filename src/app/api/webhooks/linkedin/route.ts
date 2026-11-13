import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { storeEvents } from '@/lib/linkedin/events';
import { validSignature } from '@/lib/linkedin/webhook';

export const runtime = 'nodejs';

/**
 * LinkedIn Console webhook: subscribe it to invitation.sent, invitation.withdrawn, connection.accepted,
 * message.sent and message.received. Events are only kept here (each once, by its sequence number); the
 * worker processes them in order within a minute, so a retry or the same event from the feed is harmless.
 */
export async function POST(req: NextRequest) {
  const secret = env().LINKEDIN_CONSOLE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'integration_disabled' }, { status: 503 });
  const rawBody = await req.text();
  if (!validSignature(rawBody, req.headers.get('x-linkedin-console-signature'), secret)) {
    console.warn('[linkedin webhook] rejected: bad signature');
    return NextResponse.json({ ok: false, error: 'bad signature' }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  // One event, a list, or the delivery envelope { event, data, at } with the event in `data`.
  const list = Array.isArray(payload) ? payload : [payload];
  const events = list.map((p) => (p && typeof p === 'object' && 'data' in p && !('seq' in p) && (p as { data?: { seq?: unknown } }).data?.seq !== undefined ? (p as { data: unknown }).data : p));
  const r = await storeEvents(events, 'webhook');
  return NextResponse.json({ ok: true, stored: r.stored, duplicates: r.duplicates, invalid: r.invalid });
}
