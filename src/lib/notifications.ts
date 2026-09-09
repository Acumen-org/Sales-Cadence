import type { Prisma } from '@prisma/client';
import type { SessionUser } from './auth/current-user';
import { prisma } from './db';

export function notificationScope(user: SessionUser): Prisma.TouchWhereInput {
  return { channel: 'EMAIL', direction: 'INBOUND', person: { deletedAt: null, ...(user.twentyMemberId ? { ownerMemberId: user.twentyMemberId } : { id: { in: [] } }) } };
}
export async function unreadNotifications(user: SessionUser) {
  const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { notificationsReadAt: true } });
  return prisma.touch.count({ where: { ...notificationScope(user), ...(current.notificationsReadAt ? { createdAt: { gt: current.notificationsReadAt } } : {}) } });
}
