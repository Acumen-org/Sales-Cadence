import { activateCampaign } from '@/lib/engine/campaigns';
import { beforeEach, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { accountDetail, listAccounts } from '@/lib/accounts-query';
import { blockAccount, blockedCompanyIds, isBlockedAccount, unblockAccount } from '@/lib/blocked-accounts';
import { enrichmentQueue } from '@/lib/enrichment-work';
import { canReadPerson, peopleScopeWhere } from '@/lib/people-scope';
import { enrollPeople, previewEnrollment } from '@/lib/engine/enrollment';
import { userActor } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';

let basics: Basics;
const session = (user: Basics['users']['ria'], podIds: string[] = []): SessionUser => ({ ...user, pods: [], podIds });

beforeEach(async () => {
  await resetDb();
  basics = await seedBasics();
  await prisma.companyCache.createMany({ data: [
    { id: 'blocked-co', name: 'Blocked Holdings', sortName: 'blocked holdings', domain: 'blocked.example' },
    { id: 'open-co', name: 'Open Partners', sortName: 'open partners', domain: 'open.example' },
  ] });
  await prisma.personCache.createMany({ data: [
    { id: 'at-blocked', firstName: 'Bea', lastName: 'Blocked', companyId: 'blocked-co', companyName: 'Blocked Holdings', podOwner: 'ALISA', ownerMemberId: 'wm-alisa' },
    { id: 'at-open', firstName: 'Otto', lastName: 'Open', companyId: 'open-co', companyName: 'Open Partners', podOwner: 'ALISA', ownerMemberId: 'wm-alisa' },
  ] });
});

const block = (companyId = 'blocked-co', reason?: string) =>
  blockAccount(companyId, { reason, actor: userActor(basics.users.ria), byUserId: basics.users.ria.id });

it('a blocked account and its people leave the directories, enrichment and search', async () => {
  const admin = session(basics.users.ria);
  const before = await listAccounts(admin, {});
  expect(before.rows.map((row) => row.id)).toContain('blocked-co');

  const result = await block('blocked-co', 'Client asked us to stop');
  expect(result).toMatchObject({ ok: true, name: 'Blocked Holdings', endedEnrollments: 0 });
  expect(await blockedCompanyIds()).toEqual(['blocked-co']);
  expect(await isBlockedAccount('blocked-co')).toBe(true);
  expect(await isBlockedAccount('open-co')).toBe(false);

  const after = await listAccounts(admin, {});
  expect(after.rows.map((row) => row.id)).not.toContain('blocked-co');
  expect(after.rows.map((row) => row.id)).toContain('open-co');
  expect(after.total).toBe(before.total - 1);

  const visible = await prisma.personCache.findMany({ where: await peopleScopeWhere(admin), select: { id: true } });
  expect(visible.map((p) => p.id)).not.toContain('at-blocked');
  expect(visible.map((p) => p.id)).toContain('at-open');

  const queue = await enrichmentQueue(admin);
  expect(queue.map((item) => item.id)).not.toContain('blocked-co');
  expect(queue.map((item) => item.id)).not.toContain('at-blocked');

  // The cache row itself is untouched, so inbound CRM activity still matches these people.
  expect(await prisma.personCache.count({ where: { id: 'at-blocked' } })).toBe(1);
  expect(await prisma.companyCache.count({ where: { id: 'blocked-co' } })).toBe(1);
});

it('only an admin can open a blocked account, and unblocking puts it back', async () => {
  await block();
  expect(await accountDetail('blocked-co', session(basics.users.ria))).toMatchObject({ blocked: { reason: null } });
  expect(await accountDetail('blocked-co', session(basics.users.alisa, [basics.pods.Alisa.id]))).toBeNull();

  const undone = await unblockAccount('blocked-co', { actor: userActor(basics.users.ria) });
  expect(undone).toMatchObject({ ok: true, name: 'Blocked Holdings' });
  const rows = await listAccounts(session(basics.users.ria), {});
  expect(rows.rows.map((row) => row.id)).toContain('blocked-co');
  const visible = await prisma.personCache.findMany({ where: await peopleScopeWhere(session(basics.users.ria)), select: { id: true } });
  expect(visible.map((p) => p.id)).toContain('at-blocked');
});

it('its people are unreachable, except for the admin who can unblock them', async () => {
  await block();
  expect(await canReadPerson(session(basics.users.alisa, [basics.pods.Alisa.id]), 'at-blocked')).toBe(false);
  expect(await canReadPerson(session(basics.users.ria), 'at-blocked')).toBe(true);
  expect(await canReadPerson(session(basics.users.alisa, [basics.pods.Alisa.id]), 'at-open')).toBe(true);
});

it('blocking ends the sequences its people are in and refuses a new enrollment', async () => {
  const enrollment = await prisma.enrollment.create({
    data: { personId: 'at-blocked', companyId: 'blocked-co', foUserId: basics.users.alisa.id, podId: basics.pods.Alisa.id, sequenceId: basics.sequence.id, startDate: '2026-09-14', status: 'ACTIVE' },
  });
  const task = await prisma.task.create({
    data: { enrollmentId: enrollment.id, foUserId: basics.users.alisa.id, stepIndex: 0, stepId: 'email-step', stepDay: 1, actionIndex: 0, actionId: 'email-0', action: 'EMAIL', label: 'Email Bea', dueDate: '2026-09-14', dueAt: new Date('2026-09-14T12:00:00Z'), plannedDate: '2026-09-14' },
  });

  const result = await block();
  expect(result).toMatchObject({ ok: true, endedEnrollments: 1 });
  expect((await prisma.enrollment.findUnique({ where: { id: enrollment.id } }))?.status).toBe('EXITED');
  expect((await prisma.enrollment.findUnique({ where: { id: enrollment.id } }))?.exitReason).toBe('account_blocked');
  expect((await prisma.task.findUnique({ where: { id: task.id } }))?.state).toBe('CANCELLED');

  const preview = await previewEnrollment({ personIds: ['at-blocked', 'at-open'], podId: basics.pods.Alisa.id, sequenceId: basics.sequence.id, startDate: '2026-09-15', assignment: { mode: 'ROUND_ROBIN' }, actor: userActor(basics.users.ria) });
  expect(preview.conflicts.find((c) => c.personId === 'at-blocked')?.reason).toBe('blocked');
  expect(preview.conflicts.find((c) => c.personId === 'at-open')).toBeUndefined();
});

it('the same account cannot be blocked twice and an unknown one is refused', async () => {
  await block();
  expect(await block()).toMatchObject({ ok: false });
  expect(await blockAccount('no-such-company', { actor: userActor(basics.users.ria) })).toMatchObject({ ok: false });
  expect(await unblockAccount('open-co', { actor: userActor(basics.users.ria) })).toMatchObject({ ok: false });
  expect(await blockedCompanyIds()).toEqual(['blocked-co']);
});

it('simultaneous blocking and enrollment leave no active work at a blocked account', async () => {
  const request = { personIds: ['at-blocked'], podId: basics.pods.Alisa.id, sequenceId: basics.sequence.id, startDate: '2026-09-15', assignment: { mode: 'ROUND_ROBIN' as const }, actor: userActor(basics.users.ria) };
  const results = await Promise.allSettled([enrollPeople(request, { skipSync: true }), block(), block()]);
  expect(results.every(result => result.status === 'fulfilled')).toBe(true);
  expect(await prisma.blockedAccount.count({ where: { companyId: 'blocked-co' } })).toBe(1);
  expect(await prisma.enrollment.count({ where: { personId: 'at-blocked', status: { in: ['ACTIVE', 'PAUSED'] } } })).toBe(0);
  expect(await prisma.task.count({ where: { enrollment: { personId: 'at-blocked' }, state: 'PENDING' } })).toBe(0);
});

it('a campaign starting while its account is blocked cannot leave active outreach', async () => {
  const campaign = await prisma.campaign.create({ data: { name: 'Concurrent launch', podId: basics.pods.Alisa.id, sequenceId: basics.sequence.id, personIds: ['at-blocked'], status: 'SCHEDULED', startDate: '2026-09-15' } });
  await Promise.all([activateCampaign(campaign.id, { actor: userActor(basics.users.ria), now: new Date('2026-09-15T18:00:00Z'), skipSync: true }), block()]);
  expect(await prisma.enrollment.count({ where: { personId: 'at-blocked', status: { in: ['ACTIVE', 'PAUSED'] } } })).toBe(0);
  expect(await prisma.task.count({ where: { enrollment: { personId: 'at-blocked' }, state: 'PENDING' } })).toBe(0);
});
