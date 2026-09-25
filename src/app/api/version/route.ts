import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/current-user';

/**
 * A number that changes when the signed-in person's screen would. The live refresh asks for it
 * every minute and reloads only when it moved, instead of re-rendering the whole tree on a timer
 * whether or not anything happened - which used to land on top of clicks.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ version: null }, { status: 401 });
  const [task, touch, enrollment, notification] = await Promise.all([
    prisma.task.aggregate({ _max: { updatedAt: true } }),
    // When a touch arrived, not when it happened: a reply synced late still changes the screen.
    prisma.touch.aggregate({ _max: { createdAt: true } }),
    prisma.enrollment.aggregate({ _max: { updatedAt: true } }),
    prisma.user.findUnique({ where: { id: user.id }, select: { notificationsReadAt: true } }),
  ]);
  const stamps = [task._max.updatedAt, touch._max.createdAt, enrollment._max.updatedAt, notification?.notificationsReadAt].map((d) => d?.getTime() ?? 0);
  return NextResponse.json({ version: Math.max(...stamps) }, { headers: { 'cache-control': 'no-store' } });
}
