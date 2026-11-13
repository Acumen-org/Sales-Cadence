import { NextResponse } from 'next/server';
import { workerHealth } from '@/lib/worker-heartbeat';

export const dynamic = 'force-dynamic';

/**
 * P01: Nomad's check on the worker task. 503 when the worker has not started a pass for
 * WORKER_STALE_MS (dead, hung, or never started), so Nomad restarts it and the deploy notices.
 */
export async function GET() {
  try {
    const health = await workerHealth();
    return NextResponse.json({ ok: health.ok, worker: health.ok ? 'up' : 'stale', lastBeat: health.lastBeat, ageSeconds: health.ageSeconds }, { status: health.ok ? 200 : 503 });
  } catch {
    return NextResponse.json({ ok: false, db: 'down' }, { status: 503 });
  }
}
