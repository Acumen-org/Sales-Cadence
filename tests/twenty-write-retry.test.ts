import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { retryFailedWrites } from '@/lib/engine/sync-retry';
import { retryDelayMs } from '@/lib/engine/sync-out';
import { resetDb, seedBasics } from './helpers/db';

/**
 * A note or mirrored task that Twenty did not accept used to become an audit row and nothing
 * else: an outage lost the CRM record for every touch worked during it. The write now waits in
 * the outbox and is replayed.
 */

const note = (personId: string) => ({ title: '[Cadence] Email 1 sent by Karson', bodyMarkdown: 'Email 1 completed in Cadence.', personId, companyId: null });

describe('writes Twenty did not receive are kept and replayed', () => {
  beforeAll(async () => {
    await resetDb();
    await seedBasics();
  });

  it('backs off from a minute, doubling, to six hours at most', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(4)).toBe(480_000);
    expect(retryDelayMs(30)).toBe(6 * 3600_000);
  });

  it('replays a failed note, marks it OK and keeps the Twenty id', async () => {
    const row = await prisma.twentyWrite.create({
      data: { operation: 'createNote', objectType: 'note', payload: note('person-01'), status: 'FAILED', error: 'ECONNREFUSED', attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const result = await retryFailedWrites();
    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
    const after = await prisma.twentyWrite.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('OK');
    expect(after.error).toBeNull();
    expect(after.twentyId).toBeTruthy();
    expect(after.attempts).toBe(2);
  });

  it('waits for a row whose time has not come, and postpones one that fails again', async () => {
    const later = await prisma.twentyWrite.create({
      data: { operation: 'createNote', objectType: 'note', payload: note('person-02'), status: 'FAILED', attempts: 1, nextAttemptAt: new Date(Date.now() + 3600_000) },
    });
    const broken = await prisma.twentyWrite.create({
      data: { operation: 'renameWorkspace', objectType: 'task', payload: {}, status: 'FAILED', attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const result = await retryFailedWrites();
    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(0);
    const brokenAfter = await prisma.twentyWrite.findUniqueOrThrow({ where: { id: broken.id } });
    expect(brokenAfter.status).toBe('FAILED');
    expect(brokenAfter.attempts).toBe(2);
    expect(brokenAfter.error).toMatch(/Cannot replay/);
    expect(brokenAfter.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await prisma.twentyWrite.findUniqueOrThrow({ where: { id: later.id } })).attempts).toBe(1);

    // "Retry all now" ignores the backoff for every waiting row, and a row that fails again is
    // postponed from the real clock, never from a fake one.
    const forced = await retryFailedWrites({ ignoreBackoff: true });
    expect(forced.retried).toBe(2);
    expect(forced.succeeded).toBe(1);
    expect((await prisma.twentyWrite.findUniqueOrThrow({ where: { id: later.id } })).status).toBe('OK');
    const stillBroken = await prisma.twentyWrite.findUniqueOrThrow({ where: { id: broken.id } });
    expect(stillBroken.status).toBe('FAILED');
    expect(stillBroken.attempts).toBe(3);
    expect(stillBroken.nextAttemptAt!.getTime()).toBeLessThan(Date.now() + 7 * 3600_000);
  });

  it('retries a claim whose process died, and leaves a live claim alone', async () => {
    await prisma.twentyWrite.updateMany({ where: { status: 'FAILED' }, data: { status: 'DISCARDED' } });
    // A replay claimed the row and never finished: its lease has passed.
    const stale = await prisma.twentyWrite.create({
      data: { operation: 'createNote', objectType: 'note', payload: note('person-03'), status: 'RETRYING', attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) },
    });
    // Another replay holds this one right now.
    const live = await prisma.twentyWrite.create({
      data: { operation: 'createNote', objectType: 'note', payload: note('person-04'), status: 'RETRYING', attempts: 1, nextAttemptAt: new Date(Date.now() + 5 * 60_000) },
    });
    const result = await retryFailedWrites({ ignoreBackoff: true });
    expect(result.retried).toBe(1);
    expect((await prisma.twentyWrite.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('OK');
    expect((await prisma.twentyWrite.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('RETRYING');
    // Asked for by id while the lease holds, it is still left alone.
    expect((await retryFailedWrites({ ids: [live.id] })).retried).toBe(0);
  });
});
