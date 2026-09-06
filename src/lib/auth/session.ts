import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { prisma } from '../db';
import { env } from '../env';

export const SESSION_COOKIE = 'cadence_session';
const SESSION_DAYS = 30;

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
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
