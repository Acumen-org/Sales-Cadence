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

  it('a senior sees their own pod, and another pod answers not found', async () => {
    const seen = await prisma.personCache.findMany({ where: await peopleScopeWhere(alisa), select: { podOwner: true, ownerMemberId: true } });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.podOwner === 'ALISA' || p.ownerMemberId === b.users.alisa.twentyMemberId)).toBe(true);

    const theirs = await prisma.personCache.findFirstOrThrow({ where: { podOwner: 'ANDREW', ownerMemberId: { not: b.users.alisa.twentyMemberId } } });
    expect(await canReadPerson(alisa, theirs.id)).toBe(false);
    expect(await canReadPerson(andrew, theirs.id)).toBe(true);
  });

  it('a junior sees only the people they own or are working', async () => {
    const seen = await prisma.personCache.findMany({ where: await peopleScopeWhere(karson), include: { enrollments: { select: { foUserId: true } } } });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.ownerMemberId === b.users.karson.twentyMemberId || p.enrollments.some((e) => e.foUserId === b.users.karson.id))).toBe(true);
    const all = await prisma.personCache.count({ where: { deletedAt: null } });
    expect(seen.length).toBeLessThan(all);
  });

  it('an admin sees everyone', async () => {
    const all = await prisma.personCache.count({ where: { deletedAt: null } });
    expect(await prisma.personCache.count({ where: await peopleScopeWhere(ria) })).toBe(all);
  });
});
