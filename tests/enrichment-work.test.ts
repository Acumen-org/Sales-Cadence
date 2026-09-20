import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { upsertPersonCache } from '@/lib/person-cache';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { clearEnrichmentMarks, enrichmentQueue, enrichmentScorecard, filterEnrichmentQueue, groupByAccount, markEnrichmentGaps, mappingSignature, rememberedMapping, rememberMapping, snapshotScorecard } from '@/lib/enrichment-work';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const asUser = (user: User, podIds: string[]): SessionUser => ({ ...user, podIds, pods: podIds.map((id) => ({ id, name: id })) });

/**
 * Enrichment as work: every filter narrows the queue by a fact on the record, the scorecard's
 * percentages are the same "missing" the queue uses, a "not found" mark hides a gap only while the
 * field stays empty, and a file shaped like one seen before maps itself.
 */
describe('enrichment work surface', () => {
  let basics: Basics;
  let admin: SessionUser;
  let leader: SessionUser;
  const mock = getMockTwentyClient();
  const person = (n: number) => mock.people[n - 1];

  beforeEach(async () => {
    await resetDb();
    basics = await seedBasics();
    admin = asUser(basics.users.ria, []);
    leader = { ...asUser(basics.users.alisa, [basics.pods.Alisa.id]), role: 'SALES_LEADER' };
    // Three people with gaps, on different facts: pod, owner, tier, product, tag, campaign.
    await upsertPersonCache({ ...person(1), email: null, tier: 'LEVEL_1', productInterest: ['PHH'], tags: ['MIP'] });
    await upsertPersonCache({ ...person(2), phone: null, jobTitle: null, tier: 'LEVEL_4', productInterest: [], tags: ['TO_CALL_LIST'] });
    await upsertPersonCache({ ...person(20), linkedinUrl: null, tier: 'LEVEL_2', contactType: ['PARTNER'] });
  });

  it('scorecard totals open all matching records, including complete people and accounts', async () => {
    await prisma.personCache.update({ where: { id: person(1).id }, data: { firstName: 'Complete', lastName: 'Person', email: 'complete@example.org', phone: '+13125550123', linkedinUrl: 'https://linkedin.com/in/complete', jobTitle: 'Director', badEmail: false, badPhone: false, emailMissing: false, phoneMissing: false, tags: [] } });
    const queue = await enrichmentQueue(admin, true);
    const scorecard = await enrichmentScorecard(admin);
    for (const [groups, entity] of [[scorecard.contacts, 'person'], [scorecard.accounts, 'company']] as const) {
      const pool = queue.filter(row => row.entity === entity);
      for (const group of groups) {
        const result = filterEnrichmentQueue(pool, { includeComplete: true, ...(group.kind === 'pod' ? { pod: group.id } : group.kind === 'fo' ? { fo: group.id } : {}) });
        expect(result.length, `${entity} ${group.kind} ${group.name}`).toBe(group.total);
      }
    }
    expect(filterEnrichmentQueue(queue, { includeComplete: true }).find(row => row.id === person(1).id)?.gaps).toEqual([]);
    expect(filterEnrichmentQueue(queue).find(row => row.id === person(1).id)).toBeUndefined();
  });

  it('city alone does not satisfy an address gap, but a CRM street address does', async () => {
    const id = person(1).companyId!;
    await prisma.companyCache.update({ where: { id }, data: { city: 'Chicago', raw: { address: { addressCity: 'Chicago' } } } });
    expect((await enrichmentQueue(admin)).find(row => row.entity === 'company' && row.id === id)?.gaps.some(gap => gap.field === 'address')).toBe(true);
    await prisma.companyCache.update({ where: { id }, data: { raw: { address: { addressCity: 'Chicago', addressStreet1: '123 Main Street' } } } });
    expect((await enrichmentQueue(admin)).find(row => row.entity === 'company' && row.id === id)?.gaps.some(gap => gap.field === 'address')).not.toBe(true);
  });

  it('narrows by every filter on the record and sorts by name, account, gaps and sync time', async () => {
    const queue = (await enrichmentQueue(admin)).filter((i) => i.entity === 'person');
    const ids = (items: { id: string }[]) => items.map((i) => i.id);
    expect(ids(filterEnrichmentQueue(queue, { pod: person(1).podOwner! }))).toEqual(expect.arrayContaining([person(1).id, person(2).id]));
    expect(ids(filterEnrichmentQueue(queue, { pod: person(20).podOwner! }))).not.toContain(person(1).id);
    expect(ids(filterEnrichmentQueue(queue, { fo: person(1).ownerMemberId! }))).toContain(person(1).id);
    expect(ids(filterEnrichmentQueue(queue, { tier: 'LEVEL_4' }))).toEqual([person(2).id]);
    expect(ids(filterEnrichmentQueue(queue, { type: 'PARTNER' }))).toEqual([person(20).id]);
    expect(ids(filterEnrichmentQueue(queue, { product: 'PHH' }))).toContain(person(1).id);
    expect(ids(filterEnrichmentQueue(queue, { product: 'PHH' }))).not.toContain(person(2).id);
    expect(ids(filterEnrichmentQueue(queue, { tag: 'TO_CALL_LIST' }))).toEqual([person(2).id]);
    expect(ids(filterEnrichmentQueue(queue, { account: person(20).companyId! }))).toContain(person(20).id);
    expect(ids(filterEnrichmentQueue(queue, { account: person(20).companyId! }))).not.toContain(person(1).id);
    expect(ids(filterEnrichmentQueue(queue, { fields: ['jobTitle'] }))).toEqual([person(2).id]);
    expect(ids(filterEnrichmentQueue(queue, { fields: ['email', 'linkedinUrl'] })).sort()).toEqual([person(1).id, person(20).id].sort());
    // Priority: person 2 lacks phone (critical); a record with only a job title missing is "useful".
    await upsertPersonCache({ ...person(3), jobTitle: null });
    const again = (await enrichmentQueue(admin)).filter((i) => i.entity === 'person');
    expect(ids(filterEnrichmentQueue(again, { priority: 'useful' }))).toEqual([person(3).id]);
    expect(ids(filterEnrichmentQueue(again, { priority: 'critical' }))).not.toContain(person(3).id);
    // In a campaign: scheduled in an upcoming campaign counts, before it starts.
    await prisma.campaign.create({ data: { name: 'Autumn', sequenceId: basics.sequence.id, podId: basics.pods.Alisa.id, createdById: basics.users.ria.id, status: 'SCHEDULED', startDate: '2026-10-05', personIds: [person(1).id] } });
    const withCampaign = (await enrichmentQueue(admin)).filter((i) => i.entity === 'person');
    expect(ids(filterEnrichmentQueue(withCampaign, { campaign: 'any' }))).toEqual([person(1).id]);
    expect(ids(filterEnrichmentQueue(withCampaign, { campaign: 'none' }))).not.toContain(person(1).id);
    expect(ids(filterEnrichmentQueue(withCampaign, { q: person(2).lastName }))).toEqual([person(2).id]);
    // Sorts.
    const byGaps = filterEnrichmentQueue(again, { sort: 'gaps' });
    expect(byGaps[0].id).toBe(person(2).id);
    const byName = filterEnrichmentQueue(again, { sort: 'name' }).map((i) => i.label);
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b)));
    const byAccount = filterEnrichmentQueue(again, { sort: 'company' }).map((i) => i.company ?? '');
    expect(byAccount).toEqual([...byAccount].sort((a, b) => a.localeCompare(b)));
    await prisma.personCache.update({ where: { id: person(2).id }, data: { syncedAt: new Date('2020-01-01') } });
    const bySync = filterEnrichmentQueue((await enrichmentQueue(admin)).filter((i) => i.entity === 'person'), { sort: 'synced' });
    expect(bySync[bySync.length - 1].id).toBe(person(2).id);
  });

  it('proposes the account whose website matches an unlinked email, as a fact', async () => {
    await upsertPersonCache({ ...person(4), companyId: null, companyName: null });
    const item = (await enrichmentQueue(admin)).find((i) => i.id === person(4).id)!;
    const gap = item.gaps.find((g) => g.field === 'companyId')!;
    expect(gap.suggestion).toEqual({ id: person(4).companyId, name: person(4).companyName });
  });

  it('folds the queue under the account with the account gaps beside the people', async () => {
    const groups = groupByAccount(filterEnrichmentQueue(await enrichmentQueue(admin), {}));
    const g = groups.find((x) => x.companyId === person(1).companyId)!;
    expect(g.contacts).toBe(2);
    expect(g.contactGaps).toBe(3);
    expect(g.accountGaps.map((x) => x.field)).toEqual(expect.arrayContaining(['linkedinUrl', 'aum']));
    expect(g.records.filter((r) => r.entity === 'person').map((r) => r.id).sort()).toEqual([person(1).id, person(2).id].sort());
    expect(g.fields[0].count).toBeGreaterThanOrEqual(1);
    // Ordered by how much is missing, most first.
    expect(groups[0].accountGaps.length + groups[0].contactGaps).toBeGreaterThanOrEqual(groups[groups.length - 1].accountGaps.length + groups[groups.length - 1].contactGaps);
  });

  it('marks a gap not found, hides it while the value stays empty, and reopens it when it empties again', async () => {
    const open = () => enrichmentQueue(admin).then((q) => q.find((i) => i.id === person(1).id));
    expect((await open())?.gaps.some((g) => g.field === 'email')).toBe(true);
    await markEnrichmentGaps(admin, { entity: 'person', ids: [person(1).id], fields: ['email'] }, { kind: 'not_found' });
    const item = await open();
    expect(item?.gaps.some((g) => g.field === 'email')).toBe(false);
    expect(item?.hidden.map((g) => g.field)).toEqual(['email']);
    expect(filterEnrichmentQueue([item!], { notFound: true })[0].gaps.map((g) => g.field)).toEqual(['email']);
    // Twenty fills it: the gap is gone and the mark with it.
    await upsertPersonCache({ ...person(1), email: 'nina@found.example' });
    // Nothing else is missing on the record, so it leaves the queue altogether.
    expect(await open()).toBeUndefined();
    expect(await prisma.enrichmentMark.count()).toBe(0);
    // It empties again: straight back into the queue, nothing hides it.
    await upsertPersonCache({ ...person(1), email: null });
    expect((await open())?.gaps.some((g) => g.field === 'email')).toBe(true);
    // Reopening by hand works too.
    await markEnrichmentGaps(admin, { entity: 'person', ids: [person(1).id], fields: null }, { kind: 'not_found' });
    expect((await open())?.gaps).toEqual([]);
    await clearEnrichmentMarks(admin, { entity: 'person', ids: [person(1).id], fields: null }, 'not_found');
    expect((await open())?.gaps.length).toBeGreaterThan(0);
  });

  it('assigns research to a person, shows it on the gap, and keeps a leader inside their pods', async () => {
    await markEnrichmentGaps(leader, { entity: 'person', ids: [person(1).id], fields: null }, { kind: 'assigned', assigneeId: basics.users.karson.id });
    const item = (await enrichmentQueue(admin)).find((i) => i.id === person(1).id)!;
    expect(item.gaps.every((g) => g.mark?.kind === 'assigned' && g.mark.assigneeName === basics.users.karson.name)).toBe(true);
    // Person 20 is in another pod: a leader cannot mark it.
    await expect(markEnrichmentGaps(leader, { entity: 'person', ids: [person(20).id], fields: null }, { kind: 'not_found' })).rejects.toThrow(/pods/);
    await expect(markEnrichmentGaps(asUser(basics.users.karson, [basics.pods.Alisa.id]), { entity: 'person', ids: [person(1).id], fields: null }, { kind: 'not_found' })).rejects.toThrow();
    await clearEnrichmentMarks(leader, { entity: 'person', ids: [person(1).id], fields: null }, 'assigned');
    expect((await enrichmentQueue(admin)).find((i) => i.id === person(1).id)!.gaps.some((g) => g.mark)).toBe(false);
  });

  it('scores completeness per field for everyone, each pod and each FO, against the snapshot', async () => {
    const card = await enrichmentScorecard(admin, new Date('2026-09-18T12:00:00Z'));
    const everyone = card.contacts.find((g) => g.kind === 'all')!;
    const total = await prisma.personCache.count({ where: { deletedAt: null } });
    expect(everyone.total).toBe(total);
    const email = everyone.cells.find((c) => c.field === 'email')!;
    expect(email.filled).toBe(total - 1);
    const phone = everyone.cells.find((c) => c.field === 'phone')!;
    expect(phone.filled).toBe(total - 1);
    const pod = card.contacts.find((g) => g.kind === 'pod' && g.id === person(1).podOwner)!;
    expect(pod.cells.find((c) => c.field === 'email')!.filled).toBe(pod.total - 1);
    const fo = card.contacts.find((g) => g.kind === 'fo' && g.id === person(1).ownerMemberId)!;
    expect(fo.name).toBe(basics.users.alisa.name);
    // Accounts: no mock company has AUM or LinkedIn.
    const accounts = card.accounts.find((g) => g.kind === 'all')!;
    expect(accounts.cells.find((c) => c.field === 'aum')!.filled).toBe(0);
    expect(accounts.cells.find((c) => c.field === 'domain')!.filled).toBe(accounts.total);
    // The first look writes today's snapshot; a week later, today's numbers sit beside it.
    expect(await prisma.enrichmentSnapshot.count({ where: { day: '2026-09-18' } })).toBeGreaterThan(0);
    await upsertPersonCache({ ...person(1), email: 'nina@found.example' });
    const later = await enrichmentScorecard(admin, new Date('2026-09-25T12:00:00Z'));
    expect(later.since).toBe('2026-09-18');
    const cell = later.contacts.find((g) => g.kind === 'all')!.cells.find((c) => c.field === 'email')!;
    expect(cell.filled).toBe(total);
    expect(cell.previous).toEqual({ filled: total - 1, total });
    // The nightly write replaces a day's rows rather than adding to them.
    const first = await snapshotScorecard(new Date('2026-09-25T20:00:00Z'));
    const second = await snapshotScorecard(new Date('2026-09-25T21:00:00Z'));
    expect(second.rows).toBe(first.rows);
    expect(await prisma.enrichmentSnapshot.count({ where: { day: '2026-09-25' } })).toBe(first.rows);
  });

  it('remembers a mapping by header signature and applies it to the same file shape', async () => {
    expect(mappingSignature('person', ['Twenty ID', 'Work Email'])).toBe(mappingSignature('person', ['work_email', 'twenty id']));
    expect(mappingSignature('person', ['Twenty ID'])).not.toBe(mappingSignature('company', ['Twenty ID']));
    expect(await rememberedMapping('person', ['Twenty ID', 'Work Email'])).toBeNull();
    await rememberMapping('person', ['Twenty ID', 'Work Email', 'Notes'], { 'Twenty ID': 'recordId', 'Work Email': 'email', Notes: '' }, 'Clay export.csv');
    const back = await rememberedMapping('person', ['work_email', 'Notes', 'twenty id']);
    expect(back).toEqual({ name: 'Clay export.csv', mapping: { work_email: 'email', Notes: '', 'twenty id': 'recordId' } });
    expect(await rememberedMapping('company', ['Twenty ID', 'Work Email', 'Notes'])).toBeNull();
    await rememberMapping('person', ['Twenty ID', 'Work Email', 'Notes'], { 'Twenty ID': 'recordId', 'Work Email': 'matchEmail', Notes: 'jobTitle' }, 'Second run.csv');
    expect((await rememberedMapping('person', ['Twenty ID', 'Work Email', 'Notes']))?.mapping.Notes).toBe('jobTitle');
  });
});
