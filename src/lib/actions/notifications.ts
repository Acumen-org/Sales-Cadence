'use server';
import { prisma } from '../db';
import { requireUser } from '../auth/current-user';
import { notificationScope } from '../notifications';
import { cachedPersonName } from '../person-cache';

export async function loadNotificationsAction(after?: string) {
  const user = await requireUser();
  const through = new Date();
  const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { notificationsReadAt: true } });
  if (after && !(await prisma.touch.findFirst({ where: { id: after, ...notificationScope(user) }, select: { id: true } }))) throw new Error('Notification cursor is unavailable.');
  const rows = await prisma.touch.findMany({ where: notificationScope(user), include: { person: { select: { id: true, firstName: true, lastName: true, companyName: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 26, ...(after ? { cursor: { id: after }, skip: 1 } : {}) });
  return { through: through.toISOString(), next: rows.length > 25 ? rows[24].id : null, items: rows.slice(0,25).map(t => ({ id: t.id, personId: t.personId, name: cachedPersonName(t.person), company: t.person.companyName, title: t.summary, at: t.occurredAt.toISOString(), unread: !current.notificationsReadAt || t.createdAt > current.notificationsReadAt })) };
}
export async function markNotificationsReadAction(through: string) {
  const user = await requireUser(); const date = new Date(through);
  if (!Number.isFinite(date.getTime()) || date > new Date()) throw new Error('Invalid notification timestamp.');
  await prisma.user.updateMany({ where: { id: user.id, OR: [{ notificationsReadAt: null }, { notificationsReadAt: { lt: date } }] }, data: { notificationsReadAt: date } });
  return { ok: true };
}
