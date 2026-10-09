import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { safeReturnPath } from '@/lib/auth/redirect';
import { authorizeUrl, microsoftConfig, newSignInAttempt } from '@/lib/auth/microsoft';
import { ATTEMPT_COOKIE, encodeAttempt } from './attempt';

export const dynamic = 'force-dynamic';

/** "Sign in with Microsoft": remember this attempt in a short-lived cookie and go to Microsoft. */
export async function GET(req: NextRequest) {
  const config = await microsoftConfig();
  if (!config) return NextResponse.redirect(new URL('/login', env().APP_URL));
  const attempt = newSignInAttempt();
  const res = NextResponse.redirect(authorizeUrl(config, attempt));
  res.cookies.set(ATTEMPT_COOKIE, encodeAttempt({
    state: attempt.state, nonce: attempt.nonce, verifier: attempt.verifier,
    next: safeReturnPath(req.nextUrl.searchParams.get('next') ?? undefined),
    remember: req.nextUrl.searchParams.get('remember') === 'on',
  }), { httpOnly: true, sameSite: 'lax', secure: env().COOKIE_SECURE, path: '/api/auth/microsoft', maxAge: 600 });
  return res;
}
