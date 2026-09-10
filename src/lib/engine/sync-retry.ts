import type { TwentyWrite } from '@prisma/client';
import { prisma } from '../db';
import { getTwentyClient, type TwentyClient } from '../twenty';
import { retryDelayMs } from './sync-out';

/**
 * The outbox. A write Twenty refused or never received sits in TwentyWrite as FAILED with the
 * exact payload; the worker replays it here once its backoff has passed, and an admin can replay
 * one immediately from Settings. Success marks the row OK and, for a note or mirrored task, stores
 * the Twenty id on the Cadence task the way the first attempt would have.
 */
/**
 * A claim lasts this long. A replay that died between claiming and finishing (process killed,
 * database gone) leaves the row RETRYING; once the lease has passed it is retryable again rather
 * than stuck forever.
 */
const CLAIM_LEASE_MS = 10 * 60_000;

export async function retryFailedWrites(opts: { now?: Date; limit?: number; ids?: string[]; ignoreBackoff?: boolean } = {}) {
  const now = opts.now ?? new Date();
  // FAILED and due, or RETRYING with an expired lease.
  const retryable = { OR: [{ status: 'FAILED' }, { status: 'RETRYING', nextAttemptAt: { lte: now } }] };
  const rows = await prisma.twentyWrite.findMany({
    where: opts.ids
      ? { id: { in: opts.ids }, ...retryable }
      : opts.ignoreBackoff
        ? retryable
        : { AND: [retryable, { OR: [{ status: 'RETRYING' }, { nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }] },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 25,
  });
  if (!rows.length) return { retried: 0, succeeded: 0, errors: [] as string[] };
  let client: TwentyClient;
  try {
    client = await getTwentyClient();
  } catch (err) {
    await postpone(rows, err, now);
    return { retried: rows.length, succeeded: 0, errors: [messageOf(err)] };
  }
  let succeeded = 0;
  let claimedCount = 0;
  const errors: string[] = [];
  for (const row of rows) {
    // Claim the row first: the worker tick and an admin's Retry can run at the same moment, and a
    // note written twice is worse than a note written late. The claim carries a lease (above).
    const claimed = await prisma.twentyWrite.updateMany({
      where: { id: row.id, OR: [{ status: 'FAILED' }, { status: 'RETRYING', nextAttemptAt: { lte: now } }] },
      data: { status: 'RETRYING', nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
    });
    if (!claimed.count) continue;
    claimedCount += 1;
    try {
      const twentyId = await replay(client, row);
      // Conditioned on the claim: a Discard made while this replay ran stands.
      await prisma.twentyWrite.updateMany({ where: { id: row.id, status: 'RETRYING' }, data: { status: 'OK', error: null, twentyId: twentyId ?? row.twentyId, nextAttemptAt: null, attempts: { increment: 1 } } });
      succeeded += 1;
    } catch (err) {
      errors.push(messageOf(err));
      await postpone([row], err, now);
    }
  }
  return { retried: claimedCount, succeeded, errors };
}

type NoteInput = Parameters<TwentyClient['createNote']>[0];
type TaskInput = Parameters<TwentyClient['createTask']>[0];
type TaskPatch = Parameters<TwentyClient['updateTask']>[1];

async function replay(client: TwentyClient, row: TwentyWrite): Promise<string | null> {
  const payload = row.payload as Record<string, unknown>;
  switch (row.operation) {
    case 'createNote': {
      const { id } = await client.createNote(payload as unknown as NoteInput);
      if (row.taskId) await prisma.task.updateMany({ where: { id: row.taskId, twentyNoteId: null }, data: { twentyNoteId: id } });
      return id;
    }
    case 'createTask': {
      // A mirrored task is only worth creating while the Cadence task is still open.
      if (row.taskId) {
        const task = await prisma.task.findUnique({ where: { id: row.taskId }, select: { state: true, twentyTaskId: true } });
        if (!task || task.state !== 'PENDING' || task.twentyTaskId) return null;
      }
      const { id } = await client.createTask(payload as unknown as TaskInput);
      if (row.taskId) await prisma.task.update({ where: { id: row.taskId }, data: { twentyTaskId: id } });
      return id;
    }
    case 'updateTask': {
      const { id, ...patch } = payload as { id: string } & Record<string, unknown>;
      await client.updateTask(id, patch as TaskPatch);
      return id;
    }
    case 'deleteTask': {
      const id = String(payload.id);
      await client.deleteTask(id);
      if (row.taskId) await prisma.task.updateMany({ where: { id: row.taskId, twentyTaskId: id }, data: { twentyTaskId: null } });
      return id;
    }
    default:
      throw new Error(`Cannot replay a ${row.operation} write`);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function postpone(rows: TwentyWrite[], err: unknown, now: Date) {
  const error = messageOf(err);
  for (const row of rows) {
    await prisma.twentyWrite.updateMany({ where: { id: row.id, status: { in: ['FAILED', 'RETRYING'] } }, data: { status: 'FAILED', attempts: { increment: 1 }, error, nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.attempts + 1)) } });
  }
}
