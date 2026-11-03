import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getTwentyClient } from '@/lib/twenty';
import { blankPerson, getMockTwentyClient } from '@/lib/twenty/mock-client';
import { upsertPersonCache } from '@/lib/person-cache';

export const dynamic = 'force-dynamic';

/**
 * Plays Twenty's mail and calendar sync for the browser tests: a person created from an email,
 * as Twenty would, and cached as the sync would. It exists only with the built-in fake Twenty
 * (CADENCE_ALLOW_MOCK=1 and the mock client) and answers 404 otherwise.
 */
export async function POST(req: Request) {
  if (env().CADENCE_ALLOW_MOCK !== '1' || (await getTwentyClient().catch(() => null))?.kind !== 'mock') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!(await getCurrentUser())) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const mock = getMockTwentyClient();
  if (body.action === 'autoPerson') {
    const now = new Date().toISOString();
    const person = { ...blankPerson(`person-auto-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, now), firstName: String(body.firstName ?? ''), lastName: String(body.lastName ?? ''), email: String(body.email ?? '').toLowerCase() || null, createdBySource: String(body.source ?? 'EMAIL') };
    mock.people.push(person);
    await upsertPersonCache(person);
    return NextResponse.json({ person });
  }
  if (body.action === 'editPerson') {
    const person = mock.updatePerson(String(body.id), { updatedAt: new Date(Date.now() + 3_600_000).toISOString(), jobTitle: String(body.jobTitle ?? 'Edited') });
    await upsertPersonCache(person);
    return NextResponse.json({ person });
  }
  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
