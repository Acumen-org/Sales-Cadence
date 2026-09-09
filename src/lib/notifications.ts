import type { Prisma } from '@prisma/client';
import type { SessionUser } from './auth/current-user';
import { prisma } from './db';

/**
 * What the bell is for: replies arriving from contacts this person is responsible for.
 *
 * Responsibility is either of two things, and both matter. Twenty's own owner (`ownerMemberId`) is
 * one; the other is being the FO on the enrollment, because a round-robin campaign hands an FO
 * people who are owned by somebody else in the CRM - and the person who sent the email is exactly
 * the person who needs to know it was answered. Scoping on the Twenty owner alone left those
 * replies unnotified, and left a user with no `twentyMemberId` with a bell that could never ring.
 */
export function notificationScope(user: SessionUser): Prisma.TouchWhereInput {
  const owned: Prisma.PersonCacheWhereInput[] = [{ enrollments: { some: { foUserId: user.id } } }];
  if (user.twentyMemberId) owned.push({ ownerMemberId: user.twentyMemberId });
  return { channel: 'EMAIL', direction: 'INBOUND', person: { deletedAt: null, OR: owned } };
}

export async function unreadNotifications(user: SessionUser) {
  const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { notificationsReadAt: true } });
  return prisma.touch.count({ where: { ...notificationScope(user), ...(current.notificationsReadAt ? { createdAt: { gt: current.notificationsReadAt } } : {}) } });
}
