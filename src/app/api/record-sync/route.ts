import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/current-user';
import { liveRead } from '@/lib/twenty/live-read';

/**
 * A record page's re-read of Twenty, asked for by the page once it has painted. It used to run
 * inside the page's own render, so every action on a person or an account waited on Twenty before
 * the page could show its answer, and on a slow runner the answer never showed at all.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ changed: false }, { status: 401 });
  const kind = req.nextUrl.searchParams.get('kind');
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if ((kind !== 'person' && kind !== 'company') || !id) return NextResponse.json({ changed: false }, { status: 400 });
  const { changed } = await liveRead(kind, id);
  return NextResponse.json({ changed }, { headers: { 'cache-control': 'no-store' } });
}
