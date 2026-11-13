import { NextResponse, type NextRequest } from 'next/server';
import { coldOutreachRedirect } from './lib/cold-outreach-paths';

const SESSION_COOKIE = 'cadence_session';
// V10: only the Bellwether contract's own path skips the sign-in check, not all of /api/integrations;
// every route under it and under /api/v1 must check a key itself (tests/screens-audit-fixes.test.ts checks this).
const PUBLIC_PREFIXES = ['/login', '/api/auth', '/api/health', '/api/webhooks', '/api/integrations/bellwether/v1', '/api/v1', '/_next', '/fonts', '/favicon.ico', '/icon.svg'];

/**
 * Cheap gate: redirect anonymous visitors to /login. The cookie is only checked for
 * presence here (Edge runtime, no database); the real session lookup happens in the
 * app layout via requireUser().
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // The section moved from /sandbox to /cold-outreach (PLAN 3): old links land on the new page, 307.
  const moved = coldOutreachRedirect(pathname, req.nextUrl.search);
  if (moved) {
    const url = req.nextUrl.clone();
    const [path, query] = moved.split('?');
    url.pathname = path;
    url.search = query ? `?${query}` : '';
    return NextResponse.redirect(url, 307);
  }
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
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
