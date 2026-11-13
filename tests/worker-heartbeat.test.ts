import { beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/health/worker/route';
import { beatWorker, workerHealth, WORKER_STALE_MS } from '@/lib/worker-heartbeat';
import { resetDb } from './helpers/db';

describe('P01: the worker health check', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('fails until the worker has beaten, and again once the beat is stale', async () => {
    expect((await GET()).status).toBe(503);
    const now = new Date();
    await beatWorker(now);
    expect((await GET()).status).toBe(200);
    expect((await workerHealth(new Date(now.getTime() + WORKER_STALE_MS + 60_000))).ok).toBe(false);
  });
});
