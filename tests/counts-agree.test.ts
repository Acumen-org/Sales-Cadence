import { beforeEach, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { buildHome } from '@/lib/home-query';
import { listAccounts, myOwnershipCounts } from '@/lib/accounts-query';
import { blockAccount } from '@/lib/blocked-accounts';
import { foPeopleWhere, myPeopleWhere, peopleScopeWhere } from '@/lib/people-scope';
import { userActor } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/**
 * The owner's rule of 18 September 2026: "my people" means live work everywhere. The Home tile,
 * the People list it opens and the Accounts list it opens must be one number, whatever the
 * person's history, whichever seat is reading.
 */
let b: Basics;
const session = (user: Basics['users']['alisa'], podIds: string[]): SessionUser => ({ ...user, pods: [], podIds });

beforeEach(async () => {
  await resetDb();
  b = await seedBasics();
  await prisma.companyCache.createMany({ data: [
    { id: 'co-owned', name: 'Owned Capital', sortName: 'owned capital' },
    { id: 'co-live', name: 'Live Partners', sortName: 'live partners' },
    { id: 'co-done', name: 'Done Holdings', sortName: 'done holdings' },
    { id: 'co-ours', name: 'Acumen Strategy', sortName: 'acumen strategy', domain: 'acumen-strategy.com' },
    { id: 'co-blocked', name: 'Blocked Trust', sortName: 'blocked trust' },
  ] });
  await prisma.personCache.createMany({ data: [
    // Owned in Twenty by Alisa: counts.
    { id: 'p-owned', firstName: 'Olive', lastName: 'Owned', companyId: 'co-owned', companyName: 'Owned Capital', podOwner: 'ALISA', ownerMemberId: 'wm-alisa' },
    // Not owned, but in a running sequence with Alisa: counts.
    { id: 'p-live', firstName: 'Liv', lastName: 'Live', companyId: 'co-live', companyName: 'Live Partners', podOwner: 'ALISA', ownerMemberId: 'wm-leigh' },
    // Owned, but with no company: counts as a person, never as an account.
    { id: 'p-nocompany', firstName: 'Nora', lastName: 'Nocompany', podOwner: 'ALISA', ownerMemberId: 'wm-alisa' },
    // A finished sequence with Alisa and nothing else: does not count.
    { id: 'p-done', firstName: 'Dan', lastName: 'Done', companyId: 'co-done', companyName: 'Done Holdings', podOwner: 'ALISA', ownerMemberId: 'wm-leigh' },
    // A colleague at one of our own organisations: never a prospect.
    { id: 'p-ours', firstName: 'Cole', lastName: 'Colleague', companyId: 'co-ours', companyName: 'Acumen Strategy', podOwner: 'ALISA', ownerMemberId: 'wm-alisa' },
    // Owned, but at a blocked account: gone with it.
    { id: 'p-blocked', firstName: 'Bea', lastName: 'Blocked', companyId: 'co-blocked', companyName: 'Blocked Trust', podOwner: 'ALISA', ownerMemberId: 'wm-alisa' },
  ] });
  await prisma.enrollment.createMany({ data: [
    { personId: 'p-live', companyId: 'co-live', foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-09-14', status: 'ACTIVE' },
    { personId: 'p-done', companyId: 'co-done', foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-08-01', status: 'COMPLETED' },
  ] });
  await blockAccount('co-blocked', { actor: userActor(b.users.ria), byUserId: b.users.ria.id });
});

it('Home, the People filter and the Accounts filter give one number for an FO', async () => {
  const alisa = session(b.users.alisa, [b.pods.Alisa.id]);
  const home = await buildHome(alisa, new Date('2026-09-18T12:00:00Z'));
  const ownership = await myOwnershipCounts(alisa);

  // People: owned or live, in the prospect directory. The seeded workspace owns some people to
  // Alisa already; what matters is who is in and who is out, and that every surface agrees.
  const peopleList = await prisma.personCache.findMany({ where: { AND: [await peopleScopeWhere(alisa), foPeopleWhere(alisa.id, alisa.twentyMemberId)] }, select: { id: true } });
  const ids = peopleList.map((p) => p.id);
  expect(ids).toEqual(expect.arrayContaining(['p-owned', 'p-live', 'p-nocompany']));
  for (const out of ['p-done', 'p-ours', 'p-blocked']) expect(ids).not.toContain(out);
  expect(home.my.relationships).toBe(peopleList.length);
  expect(await prisma.personCache.count({ where: await myPeopleWhere(alisa) })).toBe(peopleList.length);

  // Accounts: the companies of those people. The person with no company adds nothing.
  const accounts = await listAccounts(alisa, { foUserId: alisa.id, pod: null });
  const accountIds = accounts.rows.map((r) => r.id);
  expect(accountIds).toEqual(expect.arrayContaining(['co-live', 'co-owned']));
  for (const out of ['co-done', 'co-ours', 'co-blocked']) expect(accountIds).not.toContain(out);
  expect(home.my.accounts).toBe(accounts.total);
  expect(ownership.accounts).toBe(accounts.total);

  // "In a sequence" is the live subset, and the account carrying it is the live account.
  expect(home.my.inSequence).toBe(1);
  expect(home.my.activeAccounts).toBe(1);
});

it('a finished sequence, a colleague and a blocked account never inflate the tiles', async () => {
  const alisa = session(b.users.alisa, [b.pods.Alisa.id]);
  const before = await myOwnershipCounts(alisa);
  // Ending the live sequence removes that person; unblocking brings the blocked one back.
  await prisma.enrollment.updateMany({ where: { personId: 'p-live' }, data: { status: 'EXITED' } });
  const after = await myOwnershipCounts(alisa);
  expect(after.relationships).toBe(before.relationships - 1);
  expect(after.accounts).toBe(before.accounts - 1);
  expect(after.inSequence).toBe(0);
});

it('every seat reads the same number on its tile and in the list it opens', async () => {
  for (const [user, podIds] of [[b.users.daniel, [b.pods.Leigh.id]], [b.users.karson, [b.pods.Alisa.id]], [b.users.ria, []]] as const) {
    const seat = session(user, [...podIds]);
    const home = await buildHome(seat, new Date('2026-09-18T12:00:00Z'));
    expect(home.my.relationships, user.name).toBe(await prisma.personCache.count({ where: await myPeopleWhere(seat) }));
    expect(home.my.accounts, user.name).toBe((await listAccounts(seat, { foUserId: seat.id, pod: null })).total);
  }
});
