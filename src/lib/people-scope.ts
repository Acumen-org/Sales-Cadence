import type { Prisma } from '@prisma/client';
import { getSettings } from './settings';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isJuniorFo, canSeeAllPods } from './auth/rbac';

/**
 * Which people a user may see: everyone for an admin; otherwise the people in their pods (Twenty's
 * podOwner), the people they own in Twenty, and the people they are working. Accounts, Meetings
 * and Enrichment already draw this line; the People directory, the person record, global search
 * and the attendee picker follow the same rule, so the pod boundary cannot be walked around
 * through the directory.
 */
/**
 * The team is not the audience. A colleague who also exists as a person in Twenty (every user
 * does, through the mailbox sync) is left out of People, search, the attendee picker and
 * enrichment, by login email and by the workspace's own domains.
 */
async function teamExclusion(): Promise<Prisma.PersonCacheWhereInput[]> {
  const [users, settings] = await Promise.all([prisma.user.findMany({ select: { email: true } }), getSettings()]);
  const emails = users.map((u) => u.email.toLowerCase()).filter(Boolean);
  return [
    ...(emails.length ? [{ email: { in: emails, mode: 'insensitive' as const } }] : []),
    ...settings.rules.internalDomains.map((domain) => ({ email: { endsWith: `@${domain}`, mode: 'insensitive' as const } })),
  ];
}

export async function peopleScopeWhere(user: SessionUser): Promise<Prisma.PersonCacheWhereInput> {
  const notTeam = await teamExclusion();
  if (canSeeAllPods(user)) return { deletedAt: null, NOT: notTeam };
  const pods = isJuniorFo(user) || !user.podIds.length ? [] : await prisma.pod.findMany({ where: { id: { in: user.podIds } }, select: { podOwnerValue: true } });
  return {
    deletedAt: null,
    NOT: notTeam,
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
