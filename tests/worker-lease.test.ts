import { beforeEach, describe, expect, it } from 'vitest';
import { LEASE_MS, releaseWorkerLease, takeWorkerLease } from '@/lib/worker-lease';
import { resetDb } from './helpers/db';

describe('T19: only one worker runs at a time', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('refuses a second worker until the first gives the lease back or it runs out', async () => {
    const now = new Date();
    expect(await takeWorkerLease('a', now)).toBe(true);
    expect(await takeWorkerLease('b', now)).toBe(false);
    expect(await takeWorkerLease('a', new Date(now.getTime() + 30_000))).toBe(true);
    await releaseWorkerLease('b');
    expect(await takeWorkerLease('b', now)).toBe(false);
    await releaseWorkerLease('a');
    expect(await takeWorkerLease('b', now)).toBe(true);
    expect(await takeWorkerLease('a', new Date(now.getTime() + LEASE_MS - 1000))).toBe(false);
    expect(await takeWorkerLease('a', new Date(now.getTime() + LEASE_MS + 1000))).toBe(true);
  });
});
