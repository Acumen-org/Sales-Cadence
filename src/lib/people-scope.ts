import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isAdmin, isJuniorFo } from './auth/rbac';

/**
 * Which people a user may see: everyone for an admin; otherwise the people in their pods (Twenty's
 * podOwner), the people they own in Twenty, and the people they are working. Accounts, Meetings
 * and Enrichment already draw this line; the People directory, the person record, global search
 * and the attendee picker follow the same rule, so the pod boundary cannot be walked around
 * through the directory.
 */
export async function peopleScopeWhere(user: SessionUser): Promise<Prisma.PersonCacheWhereInput> {
  if (isAdmin(user)) return { deletedAt: null };
  const pods = isJuniorFo(user) || !user.podIds.length ? [] : await prisma.pod.findMany({ where: { id: { in: user.podIds } }, select: { podOwnerValue: true } });
  return {
    deletedAt: null,
    OR: [
      { ownerMemberId: user.twentyMemberId ?? '__none__' },
      { enrollments: { some: { foUserId: user.id } } },
      ...(pods.length ? [{ podOwner: { in: pods.map((pod) => pod.podOwnerValue) } }] : []),
    ],
  };
}

export async function canReadPerson(user: SessionUser, personId: string): Promise<boolean> {
  if (isAdmin(user)) return true;
  return (await prisma.personCache.count({ where: { AND: [{ id: personId }, await peopleScopeWhere(user)] } })) > 0;
}
