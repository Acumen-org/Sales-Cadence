import { prisma } from './db';

/**
 * P01: the worker's heartbeat. Each worker pass stamps the time it started; a worker that died,
 * hangs inside a pass or never starts one stops stamping, and /api/health/worker (which Nomad
 * checks on the worker task) answers 503 once the stamp is older than WORKER_STALE_MS.
 */
export const WORKER_HEARTBEAT_KEY = 'workerHeartbeat';
/** Generous: a pass with a large CRM catch-up can take minutes, and a false alarm restarts the worker. */
export const WORKER_STALE_MS = 20 * 60_000;

export type WorkerHeartbeat = { at: string; pid?: number };

export async function beatWorker(now = new Date()) {
  const value: WorkerHeartbeat = { at: now.toISOString(), pid: process.pid };
  await prisma.setting.upsert({ where: { key: WORKER_HEARTBEAT_KEY }, create: { key: WORKER_HEARTBEAT_KEY, value }, update: { value } });
}

export async function workerHealth(now = new Date()): Promise<{ ok: boolean; lastBeat: string | null; ageSeconds: number | null }> {
  const row = await prisma.setting.findUnique({ where: { key: WORKER_HEARTBEAT_KEY } });
  const at = (row?.value as WorkerHeartbeat | null)?.at ?? null;
  const time = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(time)) return { ok: false, lastBeat: null, ageSeconds: null };
  const age = now.getTime() - time;
  return { ok: age <= WORKER_STALE_MS, lastBeat: at, ageSeconds: Math.round(age / 1000) };
}
