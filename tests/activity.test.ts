import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { activityByUser, listActivity, parseActivityCursor } from '@/lib/activity-query';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const at = (iso: string) => new Date(iso);

/** logAudit stamps `now`, so the feed's ordering is tested with explicit timestamps here. */
async function audit(row: { entityType: string; entityId: string; action: string; actorId?: string; actorLabel: string; createdAt: string; details?: object }) {
  await prisma.auditLog.create({
    data: {
      entityType: row.entityType,
      entityId: row.entityId,
      action: row.action,
      actorType: row.actorId ? 'USER' : 'SYSTEM',
      actorId: row.actorId ?? null,
      actorLabel: row.actorLabel,
      details: row.details,
      createdAt: at(row.createdAt),
    },
  });
}

describe('activity feed', () => {
  let b: Basics;

  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();

    // Outreach work: two touches and a person edit.
    await prisma.touch.createMany({
      data: [
        { personId: 'person-01', channel: 'EMAIL', direction: 'OUTBOUND', occurredAt: at('2026-09-08T09:00:00Z'), summary: 'Email 1 sent to Nina Halvorsen', externalId: 'note:1', actorUserId: b.users.alisa.id, actorLabel: 'Alisa Marsh' },
        { personId: 'person-01', channel: 'EMAIL', direction: 'INBOUND', occurredAt: at('2026-09-08T11:00:00Z'), summary: 'Reply from Nina Halvorsen', externalId: 'message:1', actorLabel: 'Twenty' },
      ],
    });
    await audit({ entityType: 'person', entityId: 'person-01', action: 'updated', actorId: b.users.alisa.id, actorLabel: 'Alisa Marsh', details: { field: 'phone' }, createdAt: '2026-09-08T10:00:00Z' });

    // Administration, which must never appear in the feed.
    await audit({ entityType: 'settings', entityId: 'rules', action: 'updated', actorId: b.users.alisa.id, actorLabel: 'Alisa Marsh', createdAt: '2026-09-08T12:00:00Z' });
    await audit({ entityType: 'user', entityId: b.users.karson.id, action: 'created', actorId: b.users.alisa.id, actorLabel: 'Alisa Marsh', createdAt: '2026-09-08T12:01:00Z' });
    await audit({ entityType: 'pod', entityId: b.pods.Alisa.id, action: 'renamed', actorLabel: 'cadence-worker', createdAt: '2026-09-08T12:02:00Z' });
    await audit({ entityType: 'user', entityId: b.users.alisa.id, action: 'login', actorId: b.users.alisa.id, actorLabel: 'Alisa Marsh', createdAt: '2026-09-08T12:03:00Z' });
  });

  it('merges touches and audit rows, newest first', async () => {
    const page = await listActivity({ limit: 20 });
    expect(page.items.map((i) => i.at.toISOString())).toEqual([
      '2026-09-08T11:00:00.000Z',
      '2026-09-08T10:00:00.000Z',
      '2026-09-08T09:00:00.000Z',
    ]);
    expect(page.items.map((i) => i.kind)).toEqual(['touch', 'person', 'touch']);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('excludes administration: settings, users, pods and logins', async () => {
    const page = await listActivity({ limit: 50 });
    const titles = page.items.map((i) => `${i.kind}:${i.title}`).join(' | ');
    expect(titles).not.toMatch(/settings|login/i);
    expect(page.items).toHaveLength(3);
  });

  it('names who did it and who it was about, in plain language', async () => {
    const [reply, edit, sent] = (await listActivity({ limit: 20 })).items;
    expect(reply).toMatchObject({ tone: 'in', detail: 'Inbound', subjectName: 'Nina Halvorsen', actorName: 'Twenty' });
    expect(sent).toMatchObject({ tone: 'out', actorName: 'Alisa Marsh', subjectHref: '/people/person-01' });
    expect(edit.actorName).toBe('Alisa Marsh');
    // No raw JSON leaks into the feed.
    expect(edit.title + (edit.detail ?? '')).not.toMatch(/[{}"]/);
  });

  it('filters by actor and by kind', async () => {
    const byActor = await listActivity({ actorId: b.users.alisa.id, limit: 20 });
    expect(byActor.items.map((i) => i.kind)).toEqual(['person', 'touch']);
    const onlyTouches = await listActivity({ kinds: ['touch'], limit: 20 });
    expect(onlyTouches.items.every((i) => i.kind === 'touch')).toBe(true);
    const onlyMeetings = await listActivity({ kinds: ['meeting'], limit: 20 });
    expect(onlyMeetings.items).toEqual([]);
  });

  it('searches across the summary, the person and the company', async () => {
    expect((await listActivity({ q: 'halvorsen', limit: 20 })).items.length).toBeGreaterThan(0);
    expect((await listActivity({ q: 'Reply from', limit: 20 })).items.map((i) => i.kind)).toEqual(['touch']);
    expect((await listActivity({ q: 'no such thing', limit: 20 })).items).toEqual([]);
  });

  it('pages without losing rows that share a timestamp', async () => {
    // Five touches on the same instant: the worst case for a timestamp-only cursor.
    const same = '2026-09-07T08:00:00Z';
    await prisma.touch.createMany({
      data: [1, 2, 3, 4, 5].map((n) => ({
        personId: 'person-02',
        channel: 'CALL' as const,
        direction: 'OUTBOUND' as const,
        occurredAt: at(same),
        summary: `Call attempt ${n}`,
        externalId: `same:${n}`,
        actorUserId: b.users.karson.id,
      })),
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page: Awaited<ReturnType<typeof listActivity>> = await listActivity({ limit: 2, before: cursor });
      seen.push(...page.items.map((x) => x.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen).toHaveLength(8); // 3 from the first block + 5 sharing an instant
  });

  it('reads a cursor with or without the id part', () => {
    expect(parseActivityCursor(null)).toEqual({ at: null, afterId: null });
    expect(parseActivityCursor('2026-09-08T09:00:00.000Z|t:abc')).toEqual({ at: at('2026-09-08T09:00:00.000Z'), afterId: 't:abc' });
    expect(parseActivityCursor('2026-09-08T09:00:00.000Z')).toEqual({ at: at('2026-09-08T09:00:00.000Z'), afterId: null });
    expect(parseActivityCursor('nonsense')).toEqual({ at: null, afterId: null });
  });

  it('counts activity per person for the strip', async () => {
    const rows = await activityByUser(at('2026-09-01T00:00:00Z'));
    const alisa = rows.find((r) => r.id === b.users.alisa.id)!;
    expect(alisa.touches).toBe(1);
    const karson = rows.find((r) => r.id === b.users.karson.id)!;
    expect(karson.touches).toBe(5);
    // Only people with something to show.
    expect(rows.some((r) => r.id === b.users.leigh.id)).toBe(false);
  });
});
