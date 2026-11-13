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
    // N27: an operation the replay does not know can never succeed: given up, not postponed for ever.
    expect(brokenAfter.status).toBe('GAVE_UP');
    expect(brokenAfter.attempts).toBe(2);
    expect(brokenAfter.error).toMatch(/Cannot replay/);
    expect(brokenAfter.nextAttemptAt).toBeNull();
    expect((await prisma.twentyWrite.findUniqueOrThrow({ where: { id: later.id } })).attempts).toBe(1);

    // "Retry all now" ignores the backoff for every waiting row, and a row that fails again is
    // postponed from the real clock, never from a fake one.
    const forced = await retryFailedWrites({ ignoreBackoff: true });
    expect(forced.retried).toBe(2);
    expect(forced.succeeded).toBe(1);
    expect((await prisma.twentyWrite.findUniqueOrThrow({ where: { id: later.id } })).status).toBe('OK');
    const stillBroken = await prisma.twentyWrite.findUniqueOrThrow({ where: { id: broken.id } });
    expect(stillBroken.status).toBe('GAVE_UP');
    expect(stillBroken.attempts).toBe(3);
  });

  it('retries a claim whose process died, and leaves a live claim alone', async () => {
    await prisma.twentyWrite.updateMany({ where: { status: { in: ['FAILED', 'GAVE_UP'] } }, data: { status: 'DISCARDED' } });
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

describe('N09: CRM writes a restart cut off after the click are made later', () => {
  it('a completed step with no note and no queued write gets its note; an opt-out gets its Do not contact', async () => {
    await resetDb();
    const b = await seedBasics();
    const { enrollPeople } = await import('@/lib/engine/enrollment');
    const { SYSTEM_ACTOR } = await import('@/lib/audit');
    const { sweepUnwrittenSyncs } = await import('@/lib/engine/sync-retry');
    const now = new Date();
    await enrollPeople({ personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: now.toISOString().slice(0, 10), assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, { now });
    const task = await prisma.task.findFirstOrThrow({ where: { enrollment: { personId: 'person-01' }, state: 'PENDING' } });
    // Done, but the process stopped before the after-response write ran.
    await prisma.task.update({ where: { id: task.id }, data: { state: 'DONE', completedAt: new Date(now.getTime() - 30 * 60_000), twentyTaskId: null } });
    await prisma.personCache.update({ where: { id: 'person-02' }, data: { optedOut: true, optedOutAt: new Date(now.getTime() - 30 * 60_000), dnd: false } });

    expect(await sweepUnwrittenSyncs(now)).toEqual({ tasks: 1, optOuts: 1 });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).twentyNoteId).toBeTruthy();
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-02' } })).dnd).toBe(true);
    // once written, never again
    expect(await sweepUnwrittenSyncs(now)).toEqual({ tasks: 0, optOuts: 0 });
  });
});

describe('N27: a write that can never succeed is given up, not retried for ever', () => {
  it('an operation the replay does not know is given up at once; the attempt limit gives up the rest', async () => {
    await resetDb();
    await seedBasics();
    const { MAX_WRITE_ATTEMPTS } = await import('@/lib/engine/sync-retry');
    const unknown = await prisma.twentyWrite.create({ data: { operation: 'mysteryOp', objectType: 'note', payload: {}, status: 'FAILED', attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) } });
    const tired = await prisma.twentyWrite.create({ data: { operation: 'updateTask', objectType: 'task', payload: { id: 'no-such-task', status: 'DONE' }, status: 'FAILED', attempts: MAX_WRITE_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000) } });
    const { getMockTwentyClient } = await import('@/lib/twenty/mock-client');
    const mock = getMockTwentyClient();
    const update = mock.updateTask;
    mock.updateTask = async () => { throw new Error('Task not found'); };
    try {
      await retryFailedWrites();
    } finally {
      mock.updateTask = update;
    }
    expect((await prisma.twentyWrite.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe('GAVE_UP');
    expect(await prisma.twentyWrite.findUniqueOrThrow({ where: { id: tired.id } })).toMatchObject({ status: 'GAVE_UP', nextAttemptAt: null });
    // the worker leaves them alone; an admin can still retry one
    expect((await retryFailedWrites()).retried).toBe(0);
    expect((await retryFailedWrites({ ids: [unknown.id] })).retried).toBe(1);
  });
});

describe('N31: a write the CRM refused is queued even when the audit line cannot be written', () => {
  it('keeps the outbox row', async () => {
    const { vi } = await import('vitest');
    await resetDb();
    const b = await seedBasics();
    const { enrollPeople } = await import('@/lib/engine/enrollment');
    const { SYSTEM_ACTOR } = await import('@/lib/audit');
    const { loadSyncTask, syncTaskCompleted } = await import('@/lib/engine/sync-out');
    const { getMockTwentyClient } = await import('@/lib/twenty/mock-client');
    const now = new Date();
    await enrollPeople({ personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: now.toISOString().slice(0, 10), assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, { now });
    const task = await prisma.task.findFirstOrThrow({ where: { enrollment: { personId: 'person-01' }, state: 'PENDING' } });
    await prisma.task.update({ where: { id: task.id }, data: { state: 'DONE', completedAt: now, twentyTaskId: null } });
    getMockTwentyClient().failNext = new Error('Twenty is down');
    const audit = vi.spyOn(prisma.auditLog, 'create').mockRejectedValue(new Error('audit table locked'));
    try {
      await syncTaskCompleted((await loadSyncTask(task.id))!);
    } finally {
      audit.mockRestore();
    }
    expect(await prisma.twentyWrite.count({ where: { taskId: task.id, operation: 'createNote', status: 'FAILED' } })).toBe(1);
  });
});
