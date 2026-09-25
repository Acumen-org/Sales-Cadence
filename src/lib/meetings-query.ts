import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { isExternalEmail } from './settings';
import type { SessionUser } from './auth/current-user';
import { accountScopeCompanyIds } from './accounts-query';
import { isAdmin, isPodManager, isSalesLeader, toActor } from './auth/rbac';

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
  // A meeting from a calendar is one only once a pod manager approved it.
  return { review: 'APPROVED' };
}

/** Every meeting that exists for the team: approved, or waiting for approval - never one removed. */
export const MEETING_EXISTS: Prisma.MeetingWhereInput = { review: { not: 'DISMISSED' } };

/** True when this user may open this meeting. Every signed-in user may, while it is not removed. */
export async function canReadMeeting(_user: SessionUser, meetingId: string): Promise<boolean> {
  return (await prisma.meeting.count({ where: { id: meetingId, ...MEETING_EXISTS } })) > 0;
}

/**
 * The meetings this user approves (owner, 25 September 2026: "a pod manager approves or removes
 * it"): an admin every one; the Pod Manager or Sales Leader of a pod those of that pod - the FO who
 * booked it is in the pod, or a contact on it belongs to it. Null for everyone else.
 */
export async function meetingsToReviewWhere(user: SessionUser): Promise<Prisma.MeetingWhereInput | null> {
  const actor = toActor(user);
  if (isAdmin(actor)) return {};
  if (!(isPodManager(actor) || isSalesLeader(actor)) || !user.podIds.length) return null;
  const pods = await prisma.pod.findMany({ where: { id: { in: user.podIds } }, select: { podOwnerValue: true } });
  return {
    OR: [
      { bookedBy: { pods: { some: { podId: { in: user.podIds } } } } },
      { attendees: { some: { person: { OR: [{ podOwner: { in: pods.map((p) => p.podOwnerValue) } }, { enrollments: { some: { podId: { in: user.podIds } } } }] } } } },
    ],
  };
}

/** Whether this user approves or removes this meeting. */
export async function mayReviewMeeting(user: SessionUser, meetingId: string): Promise<boolean> {
  const scope = await meetingsToReviewWhere(user);
  if (!scope) return false;
  return (await prisma.meeting.count({ where: { AND: [{ id: meetingId }, MEETING_EXISTS, scope] } })) > 0;
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

/**
 * Whether an attendee is outside the team, decided from the address against the internal domains
 * whenever there is one, so editing the domain list is retroactive; the stored flag serves only an
 * attendee recorded by name alone.
 */
export function attendeeIsExternal(attendee: { email: string | null; external: boolean }, internalDomains: string[]): boolean {
  return attendee.email ? isExternalEmail(attendee.email, internalDomains) : attendee.external;
}

