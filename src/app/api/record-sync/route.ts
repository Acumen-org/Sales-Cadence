import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { liveRead } from '@/lib/twenty/live-read';

/**
 * A record page's re-read of Twenty, asked for by the page once it has painted. It used to run
 * inside the page's own render, so every action on a person or an account waited on Twenty before
 * the page could show its answer, and on a slow runner the answer never showed at all.
 *
 * Audit Q18: it rewrites the cached record, so it is a POST (the session cookie is SameSite=Lax, so
 * another site cannot make a signed-in browser send it), and one record is re-read at most once in
 * 10 seconds, so a loop cannot hammer the CRM.
 */
const REREAD_GAP_MS = 10_000;
const g = globalThis as unknown as { __recordSyncAt?: Map<string, number> };

function recentlyRead(key: string, now = Date.now()): boolean {
  const seen = (g.__recordSyncAt ??= new Map<string, number>());
  for (const [k, t] of seen) if (now - t >= REREAD_GAP_MS) seen.delete(k);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ changed: false }, { status: 401 });
  const kind = req.nextUrl.searchParams.get('kind');
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if ((kind !== 'person' && kind !== 'company') || !id) return NextResponse.json({ changed: false }, { status: 400 });
  if (recentlyRead(`${kind}:${id}`)) return NextResponse.json({ changed: false }, { headers: { 'cache-control': 'no-store' } });
  const { changed } = await liveRead(kind, id);
  return NextResponse.json({ changed }, { headers: { 'cache-control': 'no-store' } });
}
