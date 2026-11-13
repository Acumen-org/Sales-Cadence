import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { ingestEvent, type IngestResult } from '@/lib/engine/ingest';
import { parseWebhookEvent, verifyWebhook } from '@/lib/twenty/webhook-auth';
import { noteMeetingsChangedInTwenty } from '@/lib/meetings/crm-check';
import { boundedText } from '@/lib/http-body';

export const runtime = 'nodejs';

/**
 * Twenty webhook receiver. Register this URL for message, messageParticipant, note, task,
 * opportunity and person (create/update/delete). Events are stored and deduped before
 * processing, so Twenty retries are harmless.
 */
/** Q05: the most a webhook body may be. Twenty sends one event (or a few) at a time. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const rawBody = await boundedText(req, MAX_BODY_BYTES);
  if (rawBody === null) return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 });
  const e = env();
  const auth = verifyWebhook({
    rawBody,
    headers: req.headers,
    queryToken: req.nextUrl.searchParams.get('token'),
    secret: e.TWENTY_WEBHOOK_SECRET,
    token: e.CADENCE_WEBHOOK_TOKEN,
  });
  if (!auth.ok) {
    console.warn(`[webhook] rejected: ${auth.reason}`);
    // Q22: the reason goes to the server log, not to whoever sent the request.
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const events = Array.isArray(payload) ? payload : [payload];
  const results: Array<IngestResult | { status: 'ignored'; result: string }> = [];
  for (const ev of events) {
    const parsed = parseWebhookEvent(ev);
    if (!parsed || !parsed.recordId) {
      results.push({ status: 'ignored', result: 'unparseable_event' });
      continue;
    }
    // A meeting or a meeting contact: the worker checks Twenty still holds what Cadence wrote.
    if (/^meeting/i.test(parsed.objectType)) {
      await noteMeetingsChangedInTwenty().catch(() => undefined);
      results.push({ status: 'ignored', result: 'meetings_checked_next_tick' });
      continue;
    }
    try {
      results.push(
        await ingestEvent({
          source: 'WEBHOOK',
          objectType: parsed.objectType,
          eventName: parsed.eventName,
          record: parsed.record,
          recordId: parsed.recordId,
          updatedAt: parsed.updatedAt,
        }),
      );
    } catch (err) {
      console.error('[webhook] ingest failed', err);
      // Q22: the error itself is in the server log; the sender learns only that this event failed.
      results.push({ status: 'error', result: 'failed' });
    }
  }
  return NextResponse.json({ ok: true, results });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: 'POST Twenty webhook payloads here.' });
}
