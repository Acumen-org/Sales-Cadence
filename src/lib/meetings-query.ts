import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isAdmin, visiblePodIds } from './auth/rbac';
import { accountScopeCompanyIds } from './accounts-query';

/**
 * Which meetings a user may read.
 *
 * A meeting carries a recording and a full transcript of a prospect conversation, so it is scoped
 * the same way the rest of the workspace is: an admin sees everything, and everyone else sees the
 * meetings they created, the ones they were in, and the ones belonging to an account or contact in
 * their own pods. The write path (`mayManageMeeting`) was already scoped this way; reading was not,
 * which let anyone open any transcript in the workspace.
 */
export async function meetingReadWhere(user: SessionUser): Promise<Prisma.MeetingWhereInput> {
  if (isAdmin(user)) return {};
  const podIds = visiblePodIds(user) ?? [];
  const podValues = podIds.length
    ? (await prisma.pod.findMany({ where: { id: { in: podIds } }, select: { podOwnerValue: true } })).map((p) => p.podOwnerValue)
    : [];
  const ownPeople: Prisma.PersonCacheWhereInput = {
    deletedAt: null,
    OR: [
      ...(podValues.length ? [{ podOwner: { in: podValues } }] : []),
      { ownerMemberId: user.twentyMemberId ?? '__none__' },
      { enrollments: { some: { foUserId: user.id } } },
    ],
  };
  const companyIds = (
    await prisma.personCache.findMany({ where: { ...ownPeople, companyId: { not: null } }, select: { companyId: true }, distinct: ['companyId'] })
  ).map((row) => row.companyId!);

  return {
    OR: [
      { createdById: user.id },
      { attendees: { some: { userId: user.id } } },
      { attendees: { some: { person: ownPeople } } },
      ...(companyIds.length ? [{ companyId: { in: companyIds } }] : []),
    ],
  };
}

/** True when this user may open this meeting. */
export async function canReadMeeting(user: SessionUser, meetingId: string): Promise<boolean> {
  if (isAdmin(user)) return true;
  const where = await meetingReadWhere(user);
  return (await prisma.meeting.count({ where: { AND: [{ id: meetingId }, where] } })) > 0;
}

/** Accounts this user may attach a meeting to. Same scope as the Accounts section. */
export async function companiesInScope(user: SessionUser): Promise<{ id: string; name: string }[]> {
  const ids = await accountScopeCompanyIds(user);
  return prisma.companyCache.findMany({
    where: { deletedAt: null, ...(ids === null ? {} : { id: { in: ids } }) },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: 500,
  });
}
