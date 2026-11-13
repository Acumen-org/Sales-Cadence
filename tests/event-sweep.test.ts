import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { dedupeKeyFor, ingestEvent, sweepUnprocessedEvents } from '@/lib/engine/ingest';
import { resetDb } from './helpers/db';

describe('N03: events saved but never processed', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('are swept and processed after a restart, and a later sighting is no longer a duplicate', async () => {
    const now = new Date();
    const stuck = await prisma.activityEvent.create({
      data: { source: 'WEBHOOK', objectType: 'note', eventName: 'note.deleted', externalId: 'n-stuck', dedupeKey: dedupeKeyFor('note', 'n-stuck', null, 'note.deleted'), payload: { id: 'n-stuck' }, receivedAt: new Date(now.getTime() - 20 * 60_000) },
    });
    // a row saved a moment ago is still being processed: left alone
    await prisma.activityEvent.create({
      data: { source: 'WEBHOOK', objectType: 'note', eventName: 'note.deleted', externalId: 'n-busy', dedupeKey: dedupeKeyFor('note', 'n-busy', null, 'note.deleted'), payload: { id: 'n-busy' } },
    });
    expect(await sweepUnprocessedEvents(now)).toBe(1);
    expect((await prisma.activityEvent.findUniqueOrThrow({ where: { id: stuck.id } })).result).toBe('ignored_deleted');
    expect((await prisma.activityEvent.findFirstOrThrow({ where: { externalId: 'n-busy' } })).result).toBeNull();

    // the same record seen again through the webhook also recovers a row cut off part-way
    const other = await prisma.activityEvent.create({
      data: { source: 'WEBHOOK', objectType: 'note', eventName: 'note.deleted', externalId: 'n-again', dedupeKey: dedupeKeyFor('note', 'n-again', null, 'note.deleted'), payload: { id: 'n-again' }, receivedAt: new Date(now.getTime() - 20 * 60_000) },
    });
    const again = await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.deleted', record: { id: 'n-again' }, recordId: 'n-again' });
    expect(again.status).not.toBe('duplicate');
    expect((await prisma.activityEvent.findUniqueOrThrow({ where: { id: other.id } })).result).toBe('ignored_deleted');
  });
});
