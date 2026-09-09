import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { prisma } from '../db';
import { env } from '../env';

export const SESSION_COOKIE = 'cadence_session';

/**
 * How long a sign-in lasts.
 *
 * A day by default: this is a shared workspace holding a CRM's contact data, and a browser left
 * open on a desk should not stay signed in indefinitely. "Remember me" is the deliberate opt-out,
 * for a machine one person uses.
 */
const SESSION_HOURS = 24;
const REMEMBERED_DAYS = 30;

export async function createSession(userId: string, remember = false): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + (remember ? REMEMBERED_DAYS * 86_400_000 : SESSION_HOURS * 3_600_000));
  await prisma.session.create({ data: { token, userId, expiresAt } });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().COOKIE_SECURE,
    path: '/',
    expires: expiresAt,
  });
  return token;
}

export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { token } });
  }
  jar.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}

export async function purgeExpiredSessions(): Promise<number> {
  const r = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return r.count;
}
