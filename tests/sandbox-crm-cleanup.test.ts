import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';
import { invalidateSettingsCache, saveSettingsSection, getSettings } from '@/lib/settings';
import { blankPerson, getMockTwentyClient } from '@/lib/twenty/mock-client';
import { upsertPersonCache } from '@/lib/person-cache';
import type { TwentyPerson } from '@/lib/twenty/types';
import { cleanupCounts, cleanupSandboxCrmPeople, DRY_RUN_ACTION, KEPT_ACTION, REMOVED_ACTION, SYNC_MARGIN_MS } from '@/lib/sandbox/crm-cleanup';
import { crmMatch } from '@/lib/sandbox/dedupe';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/** Plan 8.9: the people Twenty's mail and calendar sync creates for sandbox contacts. */

const HOUR_AGO = () => new Date(Date.now() - 3_600_000);
let seq = 0;

/** A person as Twenty's sync creates it now, cached as Cadence's sync would. */
async function autoPerson(email: string | null, over: Partial<TwentyPerson> = {}): Promise<TwentyPerson> {
  const now = new Date().toISOString();
  const person: TwentyPerson = { ...blankPerson(`person-auto-${++seq}`, now), firstName: 'Sam', lastName: 'Auto', email, createdBySource: 'EMAIL', createdByName: 'Alisa Senior', ...over };
  getMockTwentyClient().people.push(person);
  await upsertPersonCache(person);
  return person;
}

const deleted = () => getMockTwentyClient().writes.filter((w) => w.op === 'deletePerson').map((w) => ('id' in w ? w.id : null));

describe('Sandbox CRM cleanup (plan 8.9)', () => {
  let b: Basics;
  const contact = async (over: Parameters<typeof readyContact>[2] = {}) => readyContact(b.users.alisa.id, b.pods.Alisa.id, { createdAt: HOUR_AGO(), ...over });
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    invalidateSettingsCache();
  });
  afterEach(() => { process.env.CADENCE_DRY_RUN = 'false'; resetEnvCache(); invalidateSettingsCache(); });

  it('removes an untouched person created from email, writes the audit row and updates the cache', async () => {
    const c = await contact();
    const p = await autoPerson(c.email);
    const stats = await cleanupSandboxCrmPeople();
    expect(stats).toEqual(expect.objectContaining({ ran: true, removed: 1, kept: 0 }));
    expect(deleted()).toEqual([p.id]);
    expect(getMockTwentyClient().people.find((x) => x.id === p.id)?.deletedAt).toBeTruthy();
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: p.id } })).deletedAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: REMOVED_ACTION, entityId: p.id } });
    expect(audit.details).toEqual({ personId: p.id, name: 'Sam Auto', email: c.email, source: 'EMAIL', sandboxContactId: c.id });
    expect(await cleanupCounts()).toEqual(expect.objectContaining({ total: 1, week: 1 }));
  });

  it('removes a calendar person matched on an additional email, either side', async () => {
    const c1 = await contact({ additionalEmails: ['sam.home@example.org'] });
    const p1 = await autoPerson('Sam.Home@example.org', { createdBySource: 'CALENDAR' });
    const c2 = await contact();
    const p2 = await autoPerson('other@elsewhere.com', { additionalEmails: [c2.email!] });
    const stats = await cleanupSandboxCrmPeople();
    expect(stats.removed).toBe(2);
    expect(deleted().sort()).toEqual([p1.id, p2.id].sort());
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: p1.id } })).details).toEqual(expect.objectContaining({ source: 'CALENDAR', sandboxContactId: c1.id }));
  });

  it('treats an opted-out or removed contact as still in the sandbox, but leaves a match on a MOVED contact', async () => {
    const out = await contact({ status: 'OPTED_OUT' });
    const pOut = await autoPerson(out.email);
    const moved = await contact({ status: 'MOVED' });
    const pMoved = await autoPerson(moved.email);
    await cleanupSandboxCrmPeople();
    expect(deleted()).toEqual([pOut.id]);
    expect(getMockTwentyClient().people.find((x) => x.id === pMoved.id)?.deletedAt).toBeNull();
  });

  it('never touches people created MANUAL, IMPORT or API, or by Cadence', async () => {
    for (const createdBySource of ['MANUAL', 'IMPORT', 'API']) await autoPerson((await contact()).email, { createdBySource });
    // Cadence's own people are API-made; one that somehow says EMAIL is still left alone.
    await autoPerson((await contact()).email, { createdByName: 'Cadence' });
    // Twenty says EMAIL in the cache, but the live record says MANUAL: the live record wins.
    const c2 = await contact();
    const stale = await autoPerson(c2.email);
    getMockTwentyClient().updatePerson(stale.id, { createdBySource: 'MANUAL', updatedAt: stale.createdAt });
    const stats = await cleanupSandboxCrmPeople();
    expect(stats.removed + stats.kept).toBe(0);
    expect(deleted()).toEqual([]);
    expect(await prisma.sandboxContact.count({ where: { crmAutoPersonId: { not: null } } })).toBe(0);
  });

  it('leaves a person created before the sandbox contact', async () => {
    const p = await autoPerson('early@rivera-wealth.com');
    await contact({ email: 'early@rivera-wealth.com', createdAt: new Date(Date.now() + 60_000) });
    expect((await cleanupSandboxCrmPeople()).removed).toBe(0);
    expect(deleted()).not.toContain(p.id);
  });

  it('allows the sync its own writes inside the margin, and keeps and flags a person edited after it', async () => {
    const c1 = await contact();
    const p1 = await autoPerson(c1.email);
    getMockTwentyClient().updatePerson(p1.id, { updatedAt: new Date(Date.parse(p1.createdAt) + SYNC_MARGIN_MS / 2).toISOString() });
    const c2 = await contact();
    const p2 = await autoPerson(c2.email);
    getMockTwentyClient().updatePerson(p2.id, { jobTitle: 'Partner', updatedAt: new Date(Date.parse(p2.createdAt) + SYNC_MARGIN_MS + 60_000).toISOString() });
    const stats = await cleanupSandboxCrmPeople();
    expect(stats).toEqual(expect.objectContaining({ removed: 1, kept: 1 }));
    expect(deleted()).toEqual([p1.id]);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c2.id } })).toEqual(expect.objectContaining({ crmAutoPersonId: p2.id, crmAutoSource: 'EMAIL' }));
    const kept = await prisma.auditLog.findFirstOrThrow({ where: { action: KEPT_ACTION, entityId: c2.id } });
    expect(kept.details).toEqual(expect.objectContaining({ personId: p2.id, reasons: ['edited'] }));
    // Flagged once: the next run does not read it again.
    expect((await cleanupSandboxCrmPeople()).checked).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: KEPT_ACTION } })).toBe(1);
  });

  it('keeps a person with a note, a task or an opportunity', async () => {
    const mock = getMockTwentyClient();
    const now = new Date().toISOString();
    const withNote = await autoPerson((await contact()).email);
    mock.notes.push({ id: 'note-x', title: 'Call notes', bodyMarkdown: 'Spoke', createdByMemberId: 'wm-alisa', createdByName: 'Alisa', createdBySource: 'MANUAL', personIds: [withNote.id], companyIds: [], createdAt: now, updatedAt: now });
    const withTask = await autoPerson((await contact()).email);
    mock.tasks.push({ id: 'task-x', title: 'Follow up', bodyMarkdown: null, status: 'TODO', dueAt: null, assigneeMemberId: 'wm-alisa', personIds: [withTask.id], cadenceTaskId: null, createdByMemberId: 'wm-alisa', createdAt: now, updatedAt: now });
    const withOpp = await autoPerson((await contact()).email);
    mock.addOpportunity({ pointOfContactId: withOpp.id });
    const stats = await cleanupSandboxCrmPeople();
    expect(stats).toEqual(expect.objectContaining({ removed: 0, kept: 3 }));
    const reasons = await prisma.auditLog.findMany({ where: { action: KEPT_ACTION } });
    expect(reasons.map((r) => (r.details as { reasons: string[] }).reasons).sort()).toEqual([['notes'], ['opportunities'], ['tasks']]);
  });

  it('keeps a person in a Cadence campaign, an enrollment or a move', async () => {
    const inCampaign = await autoPerson((await contact()).email);
    await prisma.campaign.create({ data: { name: 'Q4', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2027-02-01', personIds: [inCampaign.id] } });
    const enrolled = await autoPerson((await contact()).email);
    await prisma.enrollment.create({ data: { personId: enrolled.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2027-02-01', status: 'ACTIVE' } });
    const moved = await autoPerson((await contact()).email);
    const move = await prisma.sandboxMove.create({ data: { createdById: b.users.alisa.id, count: 1, state: 'DONE' } });
    const other = await contact({ status: 'ACTIVE' });
    await prisma.sandboxMoveItem.create({ data: { moveId: move.id, sandboxContactId: other.id, state: 'DONE', mode: 'attach', attachPersonId: moved.id, snapshot: {} } });
    const stats = await cleanupSandboxCrmPeople();
    expect(stats).toEqual(expect.objectContaining({ removed: 0, kept: 3 }));
    const reasons = (await prisma.auditLog.findMany({ where: { action: KEPT_ACTION } })).map((r) => (r.details as { reasons: string[] }).reasons[0]).sort();
    expect(reasons).toEqual(['cadence_campaign', 'cadence_enrollment', 'cadence_move']);
  });

  it('does nothing when switched off in Settings', async () => {
    await saveSettingsSection('sandbox', { ...(await getSettings()).sandbox, cleanupAutoCreated: false });
    const c = await contact();
    await autoPerson(c.email);
    expect(await cleanupSandboxCrmPeople()).toEqual(expect.objectContaining({ ran: false, removed: 0 }));
    expect(deleted()).toEqual([]);
  });

  it('only logs in dry run, once, and leaves the person and the cache alone', async () => {
    process.env.CADENCE_DRY_RUN = 'true';
    resetEnvCache();
    const c = await contact();
    const p = await autoPerson(c.email);
    expect(await cleanupSandboxCrmPeople()).toEqual(expect.objectContaining({ dryRun: 1, removed: 0 }));
    expect(await cleanupSandboxCrmPeople()).toEqual(expect.objectContaining({ dryRun: 0, removed: 0 }));
    expect(getMockTwentyClient().people.find((x) => x.id === p.id)?.deletedAt).toBeNull();
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: p.id } })).deletedAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: DRY_RUN_ACTION, entityId: p.id } })).toBe(1);
  });

  it('a removed person no longer counts as already in the CRM for dedupe and Move to CRM', async () => {
    const c = await contact();
    await autoPerson(c.email);
    const input = { bellwetherContactId: null, firstName: 'Sam', lastName: 'Auto', email: c.email, additionalEmails: [], phone: null, phoneType: 'unknown', additionalPhones: [], linkedinUrl: null, individualCrd: null, companyName: null, companyDomain: null, companyCrd: null, companyPhone: null };
    expect(await crmMatch(input)).not.toBeNull();
    await cleanupSandboxCrmPeople();
    expect(await crmMatch(input)).toBeNull();
  });
});
