import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { workerHealth } from '@/lib/worker-heartbeat';

/**
 * The web task's own health: 200 while the database answers (local start-up and e2e wait on it,
 * with no worker running). P01: the body also says whether the worker is alive; Nomad checks the
 * worker itself on /api/health/worker, which fails when it is stale.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const worker = await workerHealth().catch(() => null);
    return NextResponse.json({ ok: true, db: 'up', worker: worker ? (worker.ok ? 'up' : 'stale') : 'unknown', workerLastBeat: worker?.lastBeat ?? null });
  } catch {
    return NextResponse.json({ ok: false, db: 'down' }, { status: 503 });
  }
}
