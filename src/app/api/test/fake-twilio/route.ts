import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getFakeTwilio } from '@/lib/calls/fake-twilio';

export const dynamic = 'force-dynamic';

/**
 * Seeds the in-memory Twilio stand-in for the browser tests. It exists only when the stand-in is on
 * (CADENCE_FAKE_TWILIO=1, which a production deployment refuses without mock mode) and answers 404
 * otherwise, so no deployment exposes it.
 */
export async function POST(req: Request) {
  const e = env();
  if (e.CADENCE_FAKE_TWILIO !== '1' || e.CADENCE_ALLOW_MOCK !== '1') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await getCurrentUser())) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  const fake = getFakeTwilio();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.action === 'reset') { fake.reset(); return NextResponse.json({ ok: true }); }
  if (body.action === 'addNumber') return NextResponse.json(fake.addNumber(String(body.phoneNumber), String(body.friendlyName ?? '')));
  if (body.action === 'addCall') {
    const parent = body.parentIdentity ? fake.addCall({ from: `client:${String(body.parentIdentity)}`, to: String(body.to), direction: 'inbound', durationSec: Number(body.durationSec ?? 95) }) : null;
    // Started now unless told otherwise, so it counts after the import's first run.
    const startTime = new Date(Date.now() + Number(body.startOffsetSec ?? 0) * 1000);
    const call = fake.addCall({ from: String(body.from), to: String(body.to), status: body.status ? String(body.status) : undefined, durationSec: body.durationSec != null ? Number(body.durationSec) : undefined, direction: parent ? 'outbound-dial' : String(body.direction ?? 'outbound-api'), parentCallSid: parent?.sid ?? null, startTime: startTime.toISOString(), endTime: new Date(startTime.getTime() + 1000).toISOString() });
    const recording = body.recording ? fake.addRecording(call.sid, Number(body.durationSec ?? 90)) : null;
    return NextResponse.json({ call, recording });
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
