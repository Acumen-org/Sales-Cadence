import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logAudit, userActor } from '@/lib/audit';
import { startSession } from '@/lib/auth/session';
import { safeReturnPath } from '@/lib/auth/redirect';
import { microsoftConfig, microsoftUser, redeemCode, retirePasswords, SignInError } from '@/lib/auth/microsoft';
import { ATTEMPT_COOKIE, decodeAttempt } from '../attempt';

export const dynamic = 'force-dynamic';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Microsoft sends the person back here: check it is the attempt this browser started, then sign in. */
export async function GET(req: NextRequest) {
  const base = env().APP_URL;
  const attempt = decodeAttempt(req.cookies.get(ATTEMPT_COOKIE)?.value);
  const done = (path: string, session?: Awaited<ReturnType<typeof startSession>>) => {
    const res = NextResponse.redirect(new URL(path, base));
    res.cookies.set(ATTEMPT_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: env().COOKIE_SECURE, path: '/api/auth/microsoft', maxAge: 0 });
    if (session) res.cookies.set(session.name, session.value, session.options);
    return res;
  };
  const params = req.nextUrl.searchParams;
  const code = params.get('code');
  const state = params.get('state') ?? '';
  if (!attempt) return done('/login?error=expired');
  if (params.get('error') || !code || !same(state, attempt.state)) {
    if (params.get('error')) console.warn(`[auth] Microsoft sign-in stopped: ${params.get('error')}: ${(params.get('error_description') ?? '').split(/\r?\n/)[0]}`);
    // Someone who closed Microsoft's page or picked another account just starts again.
    return done(params.get('error') === 'access_denied' ? '/login' : '/login?error=microsoft');
  }
  const config = await microsoftConfig();
  if (!config) return done('/login');
  try {
    const identity = await redeemCode(config, code, attempt.verifier, attempt.nonce);
    const user = await microsoftUser(identity);
    await retirePasswords();
    const session = await startSession(user.id, attempt.remember);
    await logAudit({ entityType: 'user', entityId: user.id, action: 'login', actor: userActor(user), details: { via: 'microsoft', remembered: attempt.remember } });
    return done(safeReturnPath(attempt.next), session);
  } catch (err) {
    const code = err instanceof SignInError ? err.code : 'microsoft';
    console.warn(`[auth] Microsoft sign-in refused (${code}): ${err instanceof Error ? err.message : String(err)}`);
    return done(`/login?error=${code}`);
  }
}
