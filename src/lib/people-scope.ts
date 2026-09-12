import type { Prisma } from '@prisma/client';
import { externalPeopleWhere } from './internal-organizations';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { canSeeAllPods, isAdmin } from './auth/rbac';

/** Everyone may read prospect records; pod and FO defaults are removable filters.
 * Team members and internal organisations stay cached for CRM activity matching,
 * but are excluded from prospect directories, search and enrichment.
 */
export async function peopleScopeWhere(user: SessionUser): Promise<Prisma.PersonCacheWhereInput> {
  const notTeam = await externalPeopleWhere();
  if (canSeeAllPods(user)) return { deletedAt: null, AND: [notTeam] };
  // A junior reads their pod like anyone else in it; what a junior may not do is work anyone
  // else's tasks, and that is decided where tasks are, not here. On the live workspace a junior
  // saw 174 of the pod's 936 people - only the ones assigned to them in Twenty - and read it as
  // missing data.
  const pods = !user.podIds.length ? [] : await prisma.pod.findMany({ where: { id: { in: user.podIds } }, select: { podOwnerValue: true } });
  return {
    deletedAt: null,
    AND: [notTeam],
    OR: [
      { ownerMemberId: user.twentyMemberId ?? '__none__' },
      { enrollments: { some: { foUserId: user.id } } },
      ...(pods.length ? [{ podOwner: { in: pods.map((pod) => pod.podOwnerValue) } }] : []),
    ],
  };
}

/**
 * The people a user may *change*: an admin anyone; otherwise the people in their pods, the people
 * they own in Twenty and the people they are working. Reading is universal now (see
 * `peopleScopeWhere`); this is the boundary the write paths keep - enrichment imports today.
 */
export async function podPeopleWhere(user: SessionUser): Promise<Prisma.PersonCacheWhereInput> {
  const notTeam = await externalPeopleWhere();
  if (isAdmin(user)) return { deletedAt: null, AND: [notTeam] };
  const pods = user.podIds.length ? await prisma.pod.findMany({ where: { id: { in: user.podIds } }, select: { podOwnerValue: true } }) : [];
  return {
    deletedAt: null,
    AND: [notTeam],
    OR: [
      { ownerMemberId: user.twentyMemberId ?? '__none__' },
      { enrollments: { some: { foUserId: user.id } } },
      ...(pods.length ? [{ podOwner: { in: pods.map((pod) => pod.podOwnerValue) } }] : []),
    ],
  };
}

export async function canReadPerson(user: SessionUser, personId: string): Promise<boolean> {
  return (await prisma.personCache.count({ where: { AND: [{ id: personId }, await peopleScopeWhere(user)] } })) > 0;
}
