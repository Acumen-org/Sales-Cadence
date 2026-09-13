import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { syncContinuously, type ContinuousSyncState } from '@/lib/continuous-sync';
import { refreshPersonCache } from '@/lib/person-cache';
import { MockTwentyClient } from '@/lib/twenty/mock-client';
import { DEMO_PEOPLE } from '@/lib/twenty/demo-fixtures';
import { resetDb } from './helpers/db';

/** A workspace where one object type cannot be read: the API key lacks the permission, say. */
class PartlyBrokenTwenty extends MockTwentyClient {
  broken = new Set<'listMessages' | 'listPeople' | 'listCompanies' | 'listNotes'>();
  private refuse(name: string): never {
    throw new Error(`Twenty GraphQL error: Forbidden (${name})`);
  }
  override listMessages: MockTwentyClient['listMessages'] = (o) => (this.broken.has('listMessages') ? this.refuse('messages') : super.listMessages(o));
  override listNotes: MockTwentyClient['listNotes'] = (o) => (this.broken.has('listNotes') ? this.refuse('notes') : super.listNotes(o));
  override listPeople: MockTwentyClient['listPeople'] = (o) => (this.broken.has('listPeople') ? this.refuse('people') : super.listPeople(o));
  override listCompanies: MockTwentyClient['listCompanies'] = (o) => (this.broken.has('listCompanies') ? this.refuse('companies') : super.listCompanies(o));
}

const state = async () => (await prisma.setting.findUnique({ where: { key: 'continuousSync' } }))?.value as ContinuousSyncState;

describe('continuous sync survives a failing stage', () => {
  beforeEach(async () => {
    await resetDb();
  });
  it('recovers notes missed during a two-hour outage instead of advancing past them', async () => {
    const client = new PartlyBrokenTwenty(); client.reset('demo');
    client.addNote({ id: 'outage-note', title: 'Recovery test', personIds: [], createdAt: '2026-09-11T09:55:00Z', updatedAt: '2026-09-11T09:55:00Z' });
    client.broken.add('listNotes');
    await syncContinuously(new Date('2026-09-11T10:00:00Z'), client);
    await syncContinuously(new Date('2026-09-11T11:00:00Z'), client);
    client.broken.clear();
    await syncContinuously(new Date('2026-09-11T12:00:00Z'), client);
    expect(await prisma.activityEvent.count({ where: { externalId: 'outage-note' } })).toBe(1);
  });

  it('caches people and moves the watermark when messages cannot be read, and says so', async () => {
    const client = new PartlyBrokenTwenty();
    client.reset('demo');
    client.broken.add('listMessages');
    const now = new Date('2026-09-11T10:00:00Z');
    const result = await syncContinuously(now, client);
    expect(result.stageErrors.messages).toMatch(/Forbidden/);
    expect(await prisma.personCache.count({ where: { deletedAt: null } })).toBe(DEMO_PEOPLE.length);
    const s = await state();
    expect(s.watermark).toBe(now.toISOString());
    expect(s.lastSuccess).toBe(now.toISOString());
    expect(s.lastFullRefresh).toBe(now.toISOString());
    expect(s.stageErrors?.messages).toMatch(/Forbidden/);
    expect(s.lastError).toBe('messages did not finish');
    // the next pass, with messages readable again, is clean
    client.broken.clear();
    const later = new Date('2026-09-11T10:01:00Z');
    await syncContinuously(later, client);
    const s2 = await state();
    expect(s2.lastError).toBeNull();
    expect(s2.stageErrors).toEqual({});
    expect(s2.watermark).toBe(later.toISOString());
  });

  it('a people listing that fails keeps the watermark and records the reason', async () => {
    const client = new PartlyBrokenTwenty();
    client.reset('demo');
    client.broken.add('listPeople');
    await expect(syncContinuously(new Date('2026-09-11T10:00:00Z'), client)).rejects.toThrow(/People could not be listed/);
    const s = await state();
    expect(s.watermark).toBeNull();
    expect(s.lastError).toMatch(/Forbidden \(people\)/);
    // companies were still cached: the failure of one stage did not stop the other
    expect(await prisma.companyCache.count()).toBeGreaterThan(0);
  });

  it('a full refresh marks people Twenty no longer returns as deleted', async () => {
    const client = new MockTwentyClient();
    client.reset('demo');
    await refreshPersonCache(client);
    expect(await prisma.personCache.count({ where: { deletedAt: null } })).toBe(DEMO_PEOPLE.length);
    // the CRM loses a person without telling anybody (a merge, a hard delete, a missed webhook)
    const gone = client.people[0].id;
    client.people = client.people.filter((p) => p.id !== gone);
    const stats = await refreshPersonCache(client);
    expect(stats.removed).toBe(1);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: gone } })).deletedAt).not.toBeNull();
    expect(await prisma.personCache.count({ where: { deletedAt: null } })).toBe(DEMO_PEOPLE.length - 1);
    // a change scan never does this: it has not seen everyone
    const partial = await refreshPersonCache(client, { since: new Date().toISOString() });
    expect(partial.removed).toBe(0);
  });

  it('a company listing that fails is one stage error, and the people are still cached', async () => {
    const client = new PartlyBrokenTwenty();
    client.reset('demo');
    client.broken.add('listCompanies');
    const stats = await refreshPersonCache(client);
    expect(stats.people).toBe(DEMO_PEOPLE.length);
    expect(stats.stageErrors.companies).toMatch(/Forbidden/);
    expect(stats.stageErrors.people).toBeUndefined();
    expect(stats.removed).toBe(0); // no company was marked deleted on the strength of a failed listing
  });
});
