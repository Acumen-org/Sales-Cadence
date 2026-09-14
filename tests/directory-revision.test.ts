import { beforeEach, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { listAccounts } from '@/lib/accounts-query';
import { filterEnrichmentQueue, type EnrichmentQueueItem } from '@/lib/enrichment';
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
  const items: EnrichmentQueueItem[] = ['Alpha', 'Beta', 'Gamma'].map((label, i) => ({ id: label, label, company: label, entity: 'person', href: '/', gaps: Array.from({ length: i + 1 }, () => ({ field: 'email', label: 'Email', priority: 'critical' })) }));
  for (const sort of ['name', 'company', 'gaps']) {
    expect(filterEnrichmentQueue(items, '', [], sort, 'desc').map(row => row.id)).toEqual(filterEnrichmentQueue(items, '', [], sort, 'asc').map(row => row.id).reverse());
  }
});
