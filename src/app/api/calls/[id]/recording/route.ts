import { NextResponse } from 'next/server';
import { getCurrentUser, toActor } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { callOwnerId, HIDDEN_CALL, mayHearCall } from '@/lib/calls/access';
import { getTwilioReader } from '@/lib/calls/twilio';

export const dynamic = 'force-dynamic';

/**
 * A call's recording, streamed from Twilio to a signed-in user who may see the call (plan 9.6).
 * Nothing is stored; Range passes through so seeking works; the Twilio key never reaches the browser.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  const { id } = await params;
  const call = await prisma.callLog.findUnique({ where: { id }, select: { recordingSid: true, userId: true, formUserId: true, personId: true, sandboxContactId: true } });
  if (!call?.recordingSid) return NextResponse.json({ error: 'This call has no recording.' }, { status: 404 });
  // N051: one rule for the recording, the call page and the timelines.
  if (!mayHearCall(toActor(user), { userId: call.userId, formUserId: call.formUserId, ownerId: await callOwnerId(call) })) return NextResponse.json({ error: HIDDEN_CALL }, { status: 403 });
  const reader = getTwilioReader();
  if (!reader) return NextResponse.json({ error: 'Twilio is not connected.' }, { status: 503 });
  // M48: Twilio out of reach is said plainly, not a bare 500.
  const upstream = await reader.recordingMedia(call.recordingSid, req.headers.get('range')).catch(() => null);
  if (!upstream) return NextResponse.json({ error: 'Twilio could not be reached for this recording. Try again in a moment.' }, { status: 502 });
  if (!upstream.ok && upstream.status !== 206) return NextResponse.json({ error: `Twilio answered ${upstream.status}.` }, { status: upstream.status === 404 ? 404 : 502 });
  const headers = new Headers({ 'cache-control': 'private, no-store', 'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg' });
  for (const h of ['content-length', 'content-range', 'accept-ranges']) { const v = upstream.headers.get(h); if (v) headers.set(h, v); }
  return new Response(upstream.body, { status: upstream.status, headers });
}
