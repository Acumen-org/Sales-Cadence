import type { Prisma } from '@prisma/client';
import { getSettings } from './settings';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { canSeeAllPods } from './auth/rbac';

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
async function teamExclusion(): Promise<Prisma.PersonCacheWhereInput> {
  const [users, settings] = await Promise.all([prisma.user.findMany({ select: { email: true } }), getSettings()]);
  const emails = users.map((u) => u.email.toLowerCase()).filter(Boolean);
  // A person with no email is not a colleague; SQL's NOT IN would have said "unknown" and dropped them.
  return {
    OR: [
      { email: null },
      {
        AND: [
          ...(emails.length ? [{ email: { notIn: emails, mode: 'insensitive' as const } }] : []),
          ...settings.rules.internalDomains.map((domain) => ({ NOT: { email: { endsWith: `@${domain}`, mode: 'insensitive' as const } } })),
        ],
      },
    ],
  };
}

export async function peopleScopeWhere(user: SessionUser): Promise<Prisma.PersonCacheWhereInput> {
  const notTeam = await teamExclusion();
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

export async function canReadPerson(user: SessionUser, personId: string): Promise<boolean> {
  return (await prisma.personCache.count({ where: { AND: [{ id: personId }, await peopleScopeWhere(user)] } })) > 0;
}
