import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { accountScopeCompanyIds } from './accounts-query';

/**
 * Which meetings a user may read: all of them.
 *
 * Meetings were pod-scoped for a while, like people and accounts, on the grounds that a transcript
 * is a prospect conversation. On the live workspace that meant a meeting an admin added against
 * Acubooth or PHH - the team's own companies, with no CRM contact in anybody's pod - was visible
 * to nobody but admins, which is the opposite of what the team wants from a meetings library. The
 * owner's rule is that meetings are visible to the team; who may edit or delete one is still
 * decided by `mayManageMeeting`, which has not changed.
 */
export async function meetingReadWhere(_user: SessionUser): Promise<Prisma.MeetingWhereInput> {
  return {};
}

/** True when this user may open this meeting. Every signed-in user may. */
export async function canReadMeeting(_user: SessionUser, meetingId: string): Promise<boolean> {
  return (await prisma.meeting.count({ where: { id: meetingId } })) > 0;
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
