'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser } from '../auth/current-user';
import { notify } from '../notifications';
import { isCounted } from '../meetings/counted';

export type KudosResult = { ok: true; kudos: number; mine: boolean } | { ok: false; error: string };

/**
 * A colleague's 👏 on a meeting someone booked (owner, 21 Nov 2026: Meetings, gamified). Pressed again,
 * it is taken back. Never on your own meeting; the booker's bell rings once per colleague.
 */
export async function toggleKudosAction(meetingId: string): Promise<KudosResult> {
  const user = await requireUser();
  const m = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { id: true, title: true, bookedById: true, review: true, approval: true } });
  if (!m || !isCounted(m)) return { ok: false, error: 'This meeting is not on the board.' };
  if (m.bookedById === user.id) return { ok: false, error: 'This is your own meeting: your colleagues cheer it.' };
  const key = { meetingId_userId: { meetingId, userId: user.id } };
  const had = await prisma.meetingKudos.findUnique({ where: key });
  if (had) await prisma.meetingKudos.delete({ where: key });
  else {
    const made = await prisma.meetingKudos.createMany({ data: [{ meetingId, userId: user.id }], skipDuplicates: true });
    // The bell rings the first time only: a 👏 taken back and given again is not news.
    const before = made.count ? await prisma.notification.count({ where: { userId: m.bookedById ?? '', kind: 'meeting_kudos', fromUserId: user.id, payload: { path: ['meetingId'], equals: meetingId } } }) : 1;
    if (!before) await notify([m.bookedById], { kind: 'meeting_kudos', fromUserId: user.id, payload: { meetingId, title: m.title } });
  }
  const kudos = await prisma.meetingKudos.count({ where: { meetingId } });
  revalidatePath('/meetings');
  return { ok: true, kudos, mine: !had };
}
