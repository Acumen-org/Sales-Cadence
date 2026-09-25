import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { unreadNotifications } from '@/lib/notifications';

/**
 * The signed-in person's unread count, for the bell to check on its own every few seconds. The
 * page refresh waits for a quiet moment (no dialog open, no field in focus); the bell, and its
 * chime, should not.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ unread: null }, { status: 401 });
  return NextResponse.json({ unread: await unreadNotifications(user) }, { headers: { 'cache-control': 'no-store' } });
}
