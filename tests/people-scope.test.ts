import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { canReadPerson, peopleScopeWhere } from '@/lib/people-scope';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/**
 * Accounts and Meetings were pod-scoped while the People directory, the person record and search
 * were not, so a junior could read another pod's call notes and inbound emails by opening the
 * person instead of the account. One rule now, in one place.
 */

const session = (u: { id: string; role: string; email: string; name: string; twentyMemberId: string | null }, podIds: string[]): SessionUser =>
  ({ ...u, podIds, timezone: 'America/Chicago' }) as unknown as SessionUser;

describe('people are scoped the way accounts are', () => {
  let b: Basics;
  let alisa: SessionUser;
  let karson: SessionUser;
  let andrew: SessionUser;
  let ria: SessionUser;

  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
    alisa = session(b.users.alisa, [b.pods.Alisa.id]);
    karson = session(b.users.karson, [b.pods.Alisa.id]);
    andrew = session(b.users.andrew, [b.pods.Andrew.id]);
    ria = session(b.users.ria, []);
  });

  it('a senior reads another pod’s person too: filters open on their pod, nothing is hidden', async () => {
    const all = await prisma.personCache.count({ where: { deletedAt: null } });
    expect(await prisma.personCache.count({ where: await peopleScopeWhere(alisa) })).toBe(all);
    const theirs = await prisma.personCache.findFirstOrThrow({ where: { podOwner: 'ANDREW', ownerMemberId: { not: b.users.alisa.twentyMemberId } } });
    expect(await canReadPerson(alisa, theirs.id)).toBe(true);
    expect(await canReadPerson(andrew, theirs.id)).toBe(true);
  });

  it('a junior reads everyone as well; the pod and their own name are only the filters they open on', async () => {
    // On the live workspace a junior saw 174 of 8,159 people and read it as missing data.
    const all = await prisma.personCache.count({ where: { deletedAt: null } });
    expect(await prisma.personCache.count({ where: await peopleScopeWhere(karson) })).toBe(all);
  });

  it('an admin sees everyone', async () => {
    const all = await prisma.personCache.count({ where: { deletedAt: null } });
    expect(await prisma.personCache.count({ where: await peopleScopeWhere(ria) })).toBe(all);
  });
});
