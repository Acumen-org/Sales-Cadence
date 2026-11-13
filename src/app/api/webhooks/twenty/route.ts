import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { ingestEvent, type IngestResult } from '@/lib/engine/ingest';
import { parseWebhookEvent, verifyWebhook } from '@/lib/twenty/webhook-auth';
import { noteMeetingsChangedInTwenty, ownMeetingEcho } from '@/lib/meetings/crm-check';
import { afterResponse } from '@/lib/engine/sync-out';

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
  // N22: events are stored before the answer and processed after it, so Twenty never waits on
  // Cadence's own CRM reads; one cut off by a restart is processed by the worker's sweep (N03).
  const runs: Array<() => Promise<IngestResult>> = [];
  for (const ev of events) {
    const parsed = parseWebhookEvent(ev);
    if (!parsed || !parsed.recordId) {
      results.push({ status: 'ignored', result: 'unparseable_event' });
      continue;
    }
    // A meeting or a meeting contact: the worker checks Twenty still holds what Cadence wrote.
    if (/^meeting/i.test(parsed.objectType)) {
      if (await ownMeetingEcho(parsed.recordId, parsed.record).catch(() => false)) {
        results.push({ status: 'ignored', result: 'meeting_own_write' });
        continue;
      }
      await noteMeetingsChangedInTwenty().catch(() => undefined);
      results.push({ status: 'ignored', result: 'meetings_checked_next_tick' });
      continue;
    }
    try {
      const { run, ...stored } = await ingestEvent({
        source: 'WEBHOOK',
        objectType: parsed.objectType,
        eventName: parsed.eventName,
        record: parsed.record,
        recordId: parsed.recordId,
        updatedAt: parsed.updatedAt,
      }, undefined, { defer: true });
      if (run) runs.push(run);
      results.push(stored);
    } catch (err) {
      console.error('[webhook] ingest failed', err);
      results.push({ status: 'error', result: err instanceof Error ? err.message : String(err) });
    }
  }
  if (runs.length) await afterResponse(async () => { for (const run of runs) await run(); });
  return NextResponse.json({ ok: true, auth: auth.method, results });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: 'POST Twenty webhook payloads here.' });
}
