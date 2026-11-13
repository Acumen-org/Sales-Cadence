import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { syncContinuously, type ContinuousSyncState } from '@/lib/continuous-sync';
import { refreshPersonCache } from '@/lib/person-cache';
import { MockTwentyClient } from '@/lib/twenty/mock-client';
import { resetDb, seedBasics } from './helpers/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { OCCUPYING_STATUSES, enrollPeople } from '@/lib/engine/enrollment';

/** Full listings of people come two to a page, can fail once at a cursor, or end early. */
class PagedTwenty extends MockTwentyClient {
  fullCalls: Array<string | null> = [];
  failAt: string | null | undefined = undefined;
  truncateAfterFirstPage = false;
  override listPeople: MockTwentyClient['listPeople'] = async (o) => {
    const full = o?.includeDeleted && !o.updatedSince && !o.deletedSince && !o.ids;
    if (!full) return super.listPeople(o);
    this.fullCalls.push(o?.after ?? null);
    if (this.failAt !== undefined && (o?.after ?? null) === this.failAt) {
      this.failAt = undefined;
      throw new Error('The CRM is unreachable: timeout');
    }
    const page = await super.listPeople({ ...o, limit: 2 });
    // Twenty has ended a listing early without an error (530 of 8,369 people).
    return this.truncateAfterFirstPage ? { ...page, hasNextPage: false, endCursor: null } : page;
  };
}

const state = async () => (await prisma.setting.findUnique({ where: { key: 'continuousSync' } }))?.value as ContinuousSyncState;

describe('the full re-read of the CRM (N01, N04)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('N01: a full listing that fails part-way resumes where it stopped, after a back-off', async () => {
    const client = new PagedTwenty();
    client.reset('demo');
    const t0 = new Date('2026-09-11T10:00:00Z');
    await syncContinuously(t0, client);
    expect((await state()).lastFullRefresh).toBe(t0.toISOString());

    const due = new Date(t0.getTime() + 25 * 3600_000);
    client.failAt = '4';
    client.fullCalls = [];
    await syncContinuously(due, client);
    let s = await state();
    expect(client.fullCalls).toEqual([null, '2', '4']);
    expect(s.fullRefreshProgress?.peopleAfter).toBe('4');
    expect(s.fullRefreshFailures).toBe(1);
    expect(s.lastFullRefresh).toBe(t0.toISOString());

    // one minute later the back-off holds: no full listing at all
    client.fullCalls = [];
    await syncContinuously(new Date(due.getTime() + 60_000), client);
    expect(client.fullCalls).toEqual([]);

    // after the back-off it carries on from page three, not page one
    const later = new Date(due.getTime() + 6 * 60_000);
    await syncContinuously(later, client);
    s = await state();
    expect(client.fullCalls[0]).toBe('4');
    expect(s.lastFullRefresh).toBe(later.toISOString());
    expect(s.fullRefreshProgress).toBeNull();
    expect(s.fullRefreshFailures).toBe(0);
  });

  it('N01: a full listing larger than the page budget is spread over several calls', async () => {
    const client = new PagedTwenty();
    client.reset('demo');
    const first = await refreshPersonCache(client, { pageBudget: 1 });
    expect(first.progress).toMatchObject({ peopleDone: false, peopleAfter: '2' });
    const second = await refreshPersonCache(client, { pageBudget: 1, resume: first.progress });
    expect(client.fullCalls).toEqual([null, '2']);
    expect(second.progress?.peopleAfter).toBe('4');
  });

  it('N04: a listing cut short marks nobody deleted, and a later full read restores a swept person', async () => {
    const client = new PagedTwenty();
    client.reset('demo');
    await refreshPersonCache(client);
    const live = await prisma.personCache.count({ where: { deletedAt: null } });

    client.truncateAfterFirstPage = true;
    const cut = await refreshPersonCache(client);
    expect(cut.removed).toBe(0);
    expect(cut.removalSkipped).toMatch(/returned \d+ of the \d+ people/);
    expect(await prisma.personCache.count({ where: { deletedAt: null } })).toBe(live);

    // a person missing from a complete listing is marked deleted ...
    client.truncateAfterFirstPage = false;
    const hidden = client.people.find((p) => !p.deletedAt)!;
    client.people = client.people.filter((p) => p.id !== hidden.id);
    expect((await refreshPersonCache(client)).removed).toBe(1);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: hidden.id } })).deletedAt).not.toBeNull();
    // ... and comes back when Twenty returns them again (restored from the bin, say), unedited
    client.people.push(hidden);
    await refreshPersonCache(client);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: hidden.id } })).deletedAt).toBeNull();
  });

  it('N07: a person a complete listing no longer returns leaves their sequence', async () => {
    const b = await seedBasics();
    const client = new PagedTwenty();
    client.reset();
    await refreshPersonCache(client);
    await enrollPeople({ personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, { now: new Date('2026-09-06T10:00:00Z') });
    client.people = client.people.filter((p) => p.id !== 'person-01');
    expect((await refreshPersonCache(client)).removed).toBe(1);
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-01' } });
    expect(OCCUPYING_STATUSES).not.toContain(e.status);
    expect(await prisma.task.count({ where: { enrollmentId: e.id, state: 'PENDING' } })).toBe(0);
  });
});
