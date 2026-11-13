import type { TwentyWrite } from '@prisma/client';
import { prisma } from '../db';
import { getTwentyClient, type TwentyClient } from '../twenty';
import { loadSyncTask, retryDelayMs, syncTaskCompleted } from './sync-out';
import { getSettings } from '../settings';

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
/**
 * N27: after this many attempts (about five days of back-off) a write is given up: GAVE_UP, kept with
 * its last error in Settings > Activity log, where an admin can still retry or discard it. A write the
 * replay cannot make at all is given up at once.
 */
export const MAX_WRITE_ATTEMPTS = 25;
class NotReplayable extends Error {}

export async function retryFailedWrites(opts: { now?: Date; limit?: number; ids?: string[]; ignoreBackoff?: boolean } = {}) {
  const now = opts.now ?? new Date();
  // FAILED and due, or RETRYING with an expired lease; a write given up only when an admin asks.
  const byAdmin = Boolean(opts.ids || opts.ignoreBackoff);
  const retryable = { OR: [{ status: 'FAILED' }, { status: 'RETRYING', nextAttemptAt: { lte: now } }, ...(byAdmin ? [{ status: 'GAVE_UP' }] : [])] };
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
    // Nothing was claimed yet: only rows still FAILED are postponed, never one another process holds.
    await postpone(rows, err, now, ['FAILED']);
    return { retried: rows.length, succeeded: 0, errors: [messageOf(err)] };
  }
  let succeeded = 0;
  let claimedCount = 0;
  const errors: string[] = [];
  for (const row of rows) {
    // Claim the row first: the worker tick and an admin's Retry can run at the same moment, and a
    // note written twice is worse than a note written late. The claim carries a lease (above).
    const claimed = await prisma.twentyWrite.updateMany({
      where: { id: row.id, ...retryable },
      data: { status: 'RETRYING', nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
    });
    if (!claimed.count) continue;
    claimedCount += 1;
    try {
      const twentyId = await replay(client, row);
      // Conditioned on the claim: a Discard made while this replay ran stands.
      const done = await prisma.twentyWrite.updateMany({ where: { id: row.id, status: 'RETRYING' }, data: { status: 'OK', error: null, twentyId: twentyId ?? row.twentyId, nextAttemptAt: null, attempts: { increment: 1 } } });
      if (done.count) succeeded += 1;
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
      // B099: a move's history note waiting here is dropped once the move is undone.
      if (typeof payload.cadenceMoveItemId === 'string') {
        const item = await prisma.sandboxMoveItem.findUnique({ where: { id: payload.cadenceMoveItemId }, select: { state: true } });
        if (!item || ['UNDOING', 'UNDONE', 'UNDO_PARTIAL'].includes(item.state)) return null;
      }
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
    case 'syncMeeting': {
      const { syncMeetingToCrm } = await import('../meetings/crm');
      return syncMeetingToCrm(String(payload.meetingId));
    }
    case 'deleteMeetingRecord': {
      const id = String(payload.id);
      const schema = await client.meetingSchema();
      if (schema) await client.deleteMeetingRecord(schema, id);
      return id;
    }
    case 'deleteNote': {
      const id = String(payload.id);
      await client.deleteNote(id);
      return id;
    }
    case 'setPersonDnd': {
      // An opt-out's Do not contact (D6), written again until Twenty takes it.
      const { id, dnd, reason } = payload as { id: string; dnd: boolean; reason?: string | null };
      await client.setPersonDnd(id, { dnd, reason: reason ?? null });
      return id;
    }
    case 'setPersonNextAction': {
      const { id, nextAction, nextActionDueDate } = payload as { id: string; nextAction: string | null; nextActionDueDate: string | null };
      await client.setPersonNextAction(id, { nextAction, nextActionDueDate });
      return id;
    }
    case 'deleteTask': {
      const id = String(payload.id);
      await client.deleteTask(id);
      if (row.taskId) await prisma.task.updateMany({ where: { id: row.taskId, twentyTaskId: id }, data: { twentyTaskId: null } });
      return id;
    }
    default:
      throw new NotReplayable(`Cannot replay a ${row.operation} write`);
  }
}

/** How long after a click its CRM writes may still be running (rate-limit waits) before the sweep looks. */
const UNWRITTEN_AFTER_MS = 15 * 60_000;
/** How far back the sweep looks: a restart is noticed within minutes, not days later. */
const UNWRITTEN_WITHIN_MS = 2 * 86_400_000;

/**
 * N09: the CRM writes a rep's click causes (completion note, mirrored task closed, opt-out's Do not
 * contact) run after the page has answered. A restart while they wait loses them without a trace,
 * so the worker looks for clicks that left no write at all (neither done nor queued) and makes them.
 */
export async function sweepUnwrittenSyncs(now = new Date(), limit = 25): Promise<{ tasks: number; optOuts: number }> {
  const out = { tasks: 0, optOuts: 0 };
  const client = await getTwentyClient();
  if (client.kind === 'dry-run') return out;
  const window = { gte: new Date(now.getTime() - UNWRITTEN_WITHIN_MS), lt: new Date(now.getTime() - UNWRITTEN_AFTER_MS) };
  const settings = await getSettings();
  const tasks = await prisma.task.findMany({
    where: { state: 'DONE', completedAt: window, enrollment: { personId: { not: null } }, OR: [{ twentyTaskId: { not: null } }, ...(settings.sync.writeCompletionNotes ? [{ twentyNoteId: null }] : [])] },
    select: { id: true, completedAt: true },
    orderBy: { completedAt: 'asc' },
    take: limit * 4,
  });
  for (const t of tasks) {
    if (out.tasks >= limit) break;
    if (await prisma.twentyWrite.findFirst({ where: { taskId: t.id, operation: { in: ['createNote', 'updateTask'] }, createdAt: { gte: t.completedAt! } }, select: { id: true } })) continue;
    const full = await loadSyncTask(t.id);
    if (!full) continue;
    await syncTaskCompleted(full);
    out.tasks += 1;
  }
  const optedOut = await prisma.personCache.findMany({ where: { optedOut: true, dnd: false, deletedAt: null, optedOutAt: window }, select: { id: true, optedOutAt: true }, take: limit });
  const { writeCrmDoNotContact } = await import('../outreach/transitions');
  for (const p of optedOut) {
    if (await prisma.twentyWrite.findFirst({ where: { twentyId: p.id, operation: 'setPersonDnd', createdAt: { gte: p.optedOutAt! } }, select: { id: true } })) continue;
    await writeCrmDoNotContact(p.id, { dnd: true });
    out.optOuts += 1;
  }
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function postpone(rows: TwentyWrite[], err: unknown, now: Date, statuses: string[] = ['FAILED', 'RETRYING']) {
  const error = messageOf(err);
  for (const row of rows) {
    const giveUp = err instanceof NotReplayable || row.attempts + 1 >= MAX_WRITE_ATTEMPTS;
    await prisma.twentyWrite.updateMany({
      where: { id: row.id, status: { in: statuses } },
      data: giveUp
        ? { status: 'GAVE_UP', attempts: { increment: 1 }, error: `Gave up after ${row.attempts + 1} attempt(s): ${error}`.slice(0, 2000), nextAttemptAt: null }
        : { status: 'FAILED', attempts: { increment: 1 }, error, nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.attempts + 1)) },
    });
  }
}
