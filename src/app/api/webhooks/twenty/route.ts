import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { ingestEvent, type IngestResult } from '@/lib/engine/ingest';
import { parseWebhookEvent, verifyWebhook } from '@/lib/twenty/webhook-auth';

export const runtime = 'nodejs';

/**
 * Twenty webhook receiver. Register this URL for message, messageParticipant, note, task,
 * opportunity and person (create/update/delete). Events are stored and deduped before
 * processing, so Twenty retries are harmless.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
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
    return NextResponse.json({ ok: false, error: auth.reason }, { status: 401 });
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
      results.push({ status: 'error', result: err instanceof Error ? err.message : String(err) });
    }
  }
  return NextResponse.json({ ok: true, auth: auth.method, results });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: 'POST Twenty webhook payloads here.' });
}
