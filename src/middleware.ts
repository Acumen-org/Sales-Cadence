import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'cadence_session';
const PUBLIC_PREFIXES = ['/login', '/api/health', '/api/webhooks', '/_next', '/favicon.ico'];

/**
 * Cheap gate: redirect anonymous visitors to /login. The cookie is only checked for
 * presence here (Edge runtime, no database); the real session lookup happens in the
 * app layout via requireUser().
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p))) {
    return NextResponse.next();
  }
  if (!req.cookies.get(SESSION_COOKIE)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname && pathname !== '/' ? `?next=${encodeURIComponent(pathname + req.nextUrl.search)}` : '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
