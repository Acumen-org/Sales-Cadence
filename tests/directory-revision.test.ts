import { personToCacheData } from '@/lib/person-cache';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { beforeEach, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { listAccounts } from '@/lib/accounts-query';
import { filterEnrichmentQueue, type EnrichmentQueueItem } from '@/lib/enrichment-work';
import { queueItem } from './helpers/enrichment';
import { tagFilter, tagTone } from '@/lib/crm-tags';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';
let basics: Basics;
beforeEach(async () => { await resetDb(); basics = await seedBasics(); });
it('pod matching keeps everyone at shared accounts and all account associations', async () => {
  await prisma.companyCache.createMany({ data: [{ id: 'shared', name: 'Shared', sortName: 'shared' }, { id: 'single', name: 'Single', sortName: 'single' }] });
  await prisma.personCache.createMany({ data: [
    { id: 'matching', firstName: 'Matching', companyId: 'shared', podOwner: 'ALISA', ownerMemberId: 'wm-alisa', productInterest: ['P1'] },
    { id: 'other-pod', firstName: 'Other', companyId: 'shared', podOwner: 'LEIGH', ownerMemberId: 'wm-leigh', productInterest: ['P2'] },
    { id: 'single-person', firstName: 'Single', companyId: 'single', podOwner: 'ALISA' },
    { id: 'no-account', firstName: 'Unlinked', podOwner: 'ALISA' },
    { id: 'deleted-person', firstName: 'Deleted', companyId: 'shared', podOwner: 'ALISA', deletedAt: new Date() },
  ] });
  const user: SessionUser = { ...basics.users.ria, pods: [], podIds: [] };
  const result = await listAccounts(user, { pod: 'ALISA', q: 'Shared' });
  expect(result.total).toBe(1);
  expect(result.people).toBe(2);
  expect(result.rows[0]).toMatchObject({ people: 2, pods: [basics.pods.Alisa.name, basics.pods.Leigh.name].sort(), fos: [basics.users.alisa.name, basics.users.leigh.name].sort(), products: ['P1', 'P2'] });
  for (const sort of ['name', 'people', 'replied', 'inSequence', 'lastTouch'] as const) {
    const asc = await listAccounts(user, { sort, dir: 'asc' });
    const desc = await listAccounts(user, { sort, dir: 'desc' });
    expect(asc.total).toBe(desc.total);
    expect(asc.people).toBe(desc.people);
    if (sort === 'people') {
      expect(asc.rows.map(row => row.people)).toEqual(asc.rows.map(row => row.people).sort((a, b) => a - b));
      expect(desc.rows.map(row => row.people)).toEqual(desc.rows.map(row => row.people).sort((a, b) => b - a));
    }
  }
});
it('tag colours are deterministic and existing fields use their existing filter', () => {
  expect(tagFilter('PROSPECT')).toEqual({ key: 'type', value: 'PROSPECT' });
  expect(tagFilter('MONTHLY')).toEqual({ key: 'listCategory', value: 'MONTHLY' });
  expect(tagFilter('SPECIAL_EVENT')).toEqual({ key: 'tag', value: 'SPECIAL_EVENT' });
  expect(tagTone('SPECIAL_EVENT')).toBe(tagTone('SPECIAL_EVENT'));
  expect(tagTone('MISSING_EMAIL')).toBe('amber');
});
it('enrichment reverses every supported sort without changing membership', () => {
  const items: EnrichmentQueueItem[] = ['Alpha', 'Beta', 'Gamma'].map((label, i) => queueItem({ id: label, label, company: label, syncedAt: new Date(2026, 0, i + 1), gaps: Array.from({ length: i + 1 }, () => ({ field: 'email', label: 'Email', priority: 'critical' as const })) }));
  for (const sort of ['name', 'company', 'gaps', 'synced']) {
    expect(filterEnrichmentQueue(items, { sort, dir: 'desc' }).map(row => row.id)).toEqual(filterEnrichmentQueue(items, { sort, dir: 'asc' }).map(row => row.id).reverse());
  }
});

it('unnamed accounts reverse their displayed domain fallback with name direction', async () => {
  await prisma.companyCache.createMany({ data: [
    { id: 'domain-a', name: '', domain: 'alpha.example' },
    { id: 'domain-z', name: '', domain: 'zulu.example' },
  ] });
  const user: SessionUser = { ...basics.users.ria, pods: [], podIds: [] };
  for (const dir of ['asc', 'desc'] as const) {
    const result = await listAccounts(user, { sort: 'name', dir });
    expect(result.rows.filter(row => row.id.startsWith('domain-')).map(row => row.id)).toEqual(dir === 'asc' ? ['domain-a', 'domain-z'] : ['domain-z', 'domain-a']);
  }
});

it('person cache orders by the visible first-name-first label in both directions', async () => {
  const person = (await getMockTwentyClient().getPerson('person-01'))!;
  for (const [id, firstName, lastName] of [['name-a', 'Aaron', 'Zulu'], ['name-z', 'Zoe', 'Alpha']]) {
    await prisma.personCache.create({ data: personToCacheData({ ...person, id, firstName, lastName }) });
  }
  for (const dir of ['asc', 'desc'] as const) {
    const rows = await prisma.personCache.findMany({ where: { id: { in: ['name-a', 'name-z'] } }, orderBy: { sortName: dir } });
    expect(rows.map(row => row.id)).toEqual(dir === 'asc' ? ['name-a', 'name-z'] : ['name-z', 'name-a']);
  }
});
