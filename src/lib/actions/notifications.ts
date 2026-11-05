'use server';
import { requireUser } from '../auth/current-user';
import { listNotifications, markNotificationsRead } from '../notifications';

/** A page of the bell: CRM replies and every other notification, newest first. */
export async function loadNotificationsAction(after?: string) {
  const user = await requireUser();
  return listNotifications(user, after ?? null);
}

export async function markNotificationsReadAction(through: string) {
  const user = await requireUser(); const date = new Date(through);
  if (!Number.isFinite(date.getTime()) || date > new Date()) throw new Error('Invalid notification timestamp.');
  await markNotificationsRead(user.id, date);
  return { ok: true };
}
