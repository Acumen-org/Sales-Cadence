import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/current-user';
import { applyEnrichmentChunk, enrichmentQueue, getEnrichmentBatch, parseEnrichmentUpload, previewEnrichment, reviewEnrichmentRows, suggestEnrichmentMapping, validateEnrichmentValue } from '@/lib/enrichment';
import { prisma } from '@/lib/db';
import { upsertCompanyCache, upsertPersonCache } from '@/lib/person-cache';
import { DryRunTwentyClient } from '@/lib/twenty';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const asUser = (user: User, podIds: string[]): SessionUser => ({ ...user, podIds, pods: podIds.map((id) => ({ id, name: id })) });

describe('enrichment parser and validation', () => {
  it('parses quoted multiline CSV, escaped quotes, tab files and flat JSON', () => {
    const csv = parseEnrichmentUpload('id,jobTitle,city\r\nperson-01,"VP, \"\"Operations\"\"","Chicago\nIllinois"');
    expect(csv.rows[0]).toEqual({ id: 'person-01', jobTitle: 'VP, "Operations"', city: 'Chicago\nIllinois' });
    expect(parseEnrichmentUpload('id\tphone\nperson-01\t+14155550123').rows[0].phone).toBe('+14155550123');
    expect(parseEnrichmentUpload('[{"id":"person-01","employees":250,"email":null}]').rows[0]).toEqual({ id: 'person-01', employees: '250', email: '' });
    expect(suggestEnrichmentMapping(['Twenty ID', 'Work Email', 'Unknown'], 'person')).toEqual({ 'Twenty ID': 'recordId', 'Work Email': 'email', Unknown: '' });
  });

  it('rejects malformed/ambiguous files and unsafe field values', () => {
    expect(() => parseEnrichmentUpload('id,email\nx,"not closed')).toThrow(/not closed/);
    expect(() => parseEnrichmentUpload('id,ID\nx,y')).toThrow(/unique/);
    expect(() => parseEnrichmentUpload('[{"id":"x","nested":{"x":1}}]')).toThrow(/nested/);
    expect(() => validateEnrichmentValue('email', 'not-an-email')).toThrow();
    expect(() => validateEnrichmentValue('phone', '4155550123')).toThrow(/international/);
    expect(() => validateEnrichmentValue('linkedinUrl', 'javascript:alert(1)')).toThrow();
    expect(() => validateEnrichmentValue('employees', '1.5')).toThrow();
    expect(validateEnrichmentValue('phone', '+1 (415) 555-0123')).toBe('+14155550123');
    expect(validateEnrichmentValue('aum', '$1,250,000.25')).toBe('1250000.25');
    expect(() => validateEnrichmentValue('aum', '1.2B')).toThrow();
  });
});

describe('durable enrichment imports', () => {
  let basics: Basics;
  let admin: SessionUser;
  let leader: SessionUser;
  let junior: SessionUser;
  const mock = getMockTwentyClient();

  beforeEach(async () => {
    await resetDb();
    basics = await seedBasics();
    admin = asUser(basics.users.ria, []);
    leader = { ...asUser(basics.users.alisa, [basics.pods.Alisa.id]), role: 'SALES_LEADER' };
    junior = asUser(basics.users.karson, [basics.pods.Alisa.id]);
    for (const company of mock.companies) await upsertCompanyCache(company);
  });

  it('fills a missing email in the mock CRM and cache, records the write, and never applies twice', async () => {
    await upsertPersonCache(mock.updatePerson('person-01', { email: null }));
    const id = await previewEnrichment(admin, 'person', 'Email enrichment', 'id,email\nperson-01,new@example.com', { id: 'recordId', email: 'email' });
    expect((await getEnrichmentBatch(admin, id))!.rows[0].status).toBe('READY');
    expect(await applyEnrichmentChunk(admin, id, mock)).toMatchObject({ applied: 1, remaining: 0, failed: 0 });
    expect((await mock.getPerson('person-01'))?.email).toBe('new@example.com');
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } })).email).toBe('new@example.com');
    expect((await getEnrichmentBatch(admin, id))!.rows[0].status).toBe('APPLIED');
    await applyEnrichmentChunk(admin, id, mock);
    expect(mock.writes.filter((write) => write.op === 'enrichPerson')).toHaveLength(1);
    expect(await prisma.twentyWrite.count({ where: { operation: 'enrichPerson', dryRun: false } })).toBe(1);
  });

  it('requires explicit approval for replacements and catches CRM edits after preview', async () => {
    const id = await previewEnrichment(admin, 'person', 'Title update', 'id,title\nperson-01,New title', { id: 'recordId', title: 'jobTitle' });
    const row = (await getEnrichmentBatch(admin, id))!.rows[0];
    expect(row.status).toBe('CONFLICT');
    expect((await applyEnrichmentChunk(admin, id, mock)).applied).toBe(0);
    await reviewEnrichmentRows(admin, id, [row.id], 'approve');
    mock.updatePerson('person-01', { jobTitle: 'Edited in Twenty after preview' });
    await applyEnrichmentChunk(admin, id, mock);
    expect((await getEnrichmentBatch(admin, id))!.rows[0]).toMatchObject({ status: 'CONFLICT', original: { jobTitle: 'Edited in Twenty after preview' } });
    expect(mock.writes).toHaveLength(0);
    await reviewEnrichmentRows(admin, id, [row.id], 'approve');
    await applyEnrichmentChunk(admin, id, mock);
    expect((await mock.getPerson('person-01'))?.jobTitle).toBe('New title');
  });

  it('refuses duplicate rows, ambiguous identity matches and records outside a leader’s pod', async () => {
    const duplicates = await previewEnrichment(admin, 'person', 'Duplicates', 'id,city\nperson-01,Paris\nperson-01,London', { id: 'recordId', city: 'city' });
    expect((await getEnrichmentBatch(admin, duplicates))!.rows.every((row) => row.status === 'INVALID')).toBe(true);
    const original = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } });
    await prisma.personCache.update({ where: { id: 'person-02' }, data: { email: original.email } });
    const ambiguous = await previewEnrichment(admin, 'person', 'Ambiguous', `email,city\n${original.email},Chicago`, { email: 'matchEmail', city: 'city' });
    expect((await getEnrichmentBatch(admin, ambiguous))!.rows[0]).toMatchObject({ status: 'INVALID', recordId: null });
    await upsertPersonCache(mock.updatePerson('person-03', { podOwner: 'LEIGH', ownerMemberId: basics.users.leigh.twentyMemberId }));
    const outside = await previewEnrichment(leader, 'person', 'Outside pod', 'id,city\nperson-03,Paris', { id: 'recordId', city: 'city' });
    expect((await getEnrichmentBatch(leader, outside))!.rows[0].status).toBe('INVALID');
    await expect(previewEnrichment(junior, 'person', 'Blocked', 'id,email\nperson-01,new@example.com', { id: 'recordId', email: 'email' })).rejects.toThrow(/pod leader/);
  });

  it('keeps dry runs separate from applied writes and leaves the underlying CRM unchanged', async () => {
    await upsertPersonCache(mock.updatePerson('person-01', { email: null }));
    const id = await previewEnrichment(admin, 'person', 'Dry run', 'id,email\nperson-01,simulation@example.com', { id: 'recordId', email: 'email' });
    await applyEnrichmentChunk(admin, id, new DryRunTwentyClient(mock));
    expect((await getEnrichmentBatch(admin, id))!.rows[0]).toMatchObject({ status: 'DRY_RUN', appliedAt: null });
    expect((await mock.getPerson('person-01'))?.email).toBeNull();
    expect(mock.writes).toHaveLength(0);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } })).email).toBeNull();
  });

  it('persists failures and supports retrying only unfinished rows', async () => {
    await upsertPersonCache(mock.updatePerson('person-01', { email: null }));
    const id = await previewEnrichment(admin, 'person', 'Retry', 'id,email\nperson-01,retry@example.com', { id: 'recordId', email: 'email' });
    mock.failNext = new Error('Twenty unavailable');
    expect((await applyEnrichmentChunk(admin, id, mock)).failed).toBe(1);
    const row = (await getEnrichmentBatch(admin, id))!.rows[0];
    expect(row).toMatchObject({ status: 'FAILED', error: 'Twenty unavailable' });
    await reviewEnrichmentRows(admin, id, [row.id], 'retry');
    expect((await applyEnrichmentChunk(admin, id, mock)).applied).toBe(1);
    expect((await getEnrichmentBatch(admin, id))!.rows[0].status).toBe('APPLIED');
  });

  it('includes missing AUM in the queue and persists verified account enrichment', async () => {
    const company = mock.companies[0];
    const before = await enrichmentQueue(admin);
    expect(before.find((item) => item.id === company.id)?.gaps.some((gap) => gap.field === 'aum')).toBe(true);
    const id = await previewEnrichment(admin, 'company', 'Account enrichment', JSON.stringify([{ id: company.id, aum: '1250000.25' }]), { id: 'recordId', aum: 'aum' });
    expect((await applyEnrichmentChunk(admin, id, mock)).applied).toBe(1);
    expect((await prisma.companyCache.findUniqueOrThrow({ where: { id: company.id } })).aum?.toString()).toBe('1250000.25');
    expect((await enrichmentQueue(admin)).find((item) => item.id === company.id)?.gaps.some((gap) => gap.field === 'aum')).toBe(false);
  });

  it('ignores blank cells rather than erasing existing fields', async () => {
    const before = await mock.getPerson('person-01');
    const id = await previewEnrichment(admin, 'person', 'Blank cells', 'id,email,phone\nperson-01,,', { id: 'recordId', email: 'email', phone: 'phone' });
    expect((await getEnrichmentBatch(admin, id))!.rows[0].status).toBe('NO_CHANGE');
    await applyEnrichmentChunk(admin, id, mock);
    expect((await mock.getPerson('person-01'))?.email).toBe(before?.email);
    expect(mock.writes).toHaveLength(0);
  });
});
