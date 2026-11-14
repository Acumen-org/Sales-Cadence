import { createHash, randomBytes } from 'node:crypto';
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

/**
 * Audit Q12: the database keeps a hash of each session token, never the token, so a copy of the
 * Session table opens nothing. Stored hashes carry a prefix so a token from before this change
 * (stored as it was) can be told apart and re-keyed on its next use.
 */
const HASHED = 'h:';
export const storedToken = (token: string) => `${HASHED}${createHash('sha256').update(token).digest('hex')}`;

/** A cookie value that may name a row stored before Q12 (never one shaped like a stored hash). */
export const mayBeLegacyToken = (token: string) => !token.startsWith(HASHED);

/**
 * A row found by its pre-Q12 token is re-keyed to the hash at once. One atomic update: when two
 * requests race, the loser matches no row (it is already re-keyed) and reads the row by its hash.
 */
export async function rekeySession(id: string, token: string): Promise<void> {
  await prisma.session.updateMany({ where: { id, token }, data: { token: storedToken(token) } });
}

/**
 * Audit Q13: the cookie is Secure unless the setting says otherwise. Left unset, it follows the
 * address the app is served at: https means Secure.
 */
export function cookieSecure(): boolean {
  const raw = process.env.COOKIE_SECURE;
  if (raw === undefined || raw === '') return env().APP_URL.startsWith('https:');
  return env().COOKIE_SECURE;
}

/** A new session row and the cookie that carries it, for a caller that sets cookies on its own response. */
export async function startSession(userId: string, remember = false) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + (remember ? REMEMBERED_DAYS * 86_400_000 : SESSION_HOURS * 3_600_000));
  await prisma.session.create({ data: { token: storedToken(token), userId, expiresAt } });
  return { name: SESSION_COOKIE, value: token, options: { httpOnly: true, sameSite: 'lax' as const, secure: cookieSecure(), path: '/', expires: expiresAt } };
}

export async function createSession(userId: string, remember = false): Promise<string> {
  const session = await startSession(userId, remember);
  const jar = await cookies();
  jar.set(session.name, session.value, session.options);
  return session.value;
}

export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { token: { in: token.startsWith(HASHED) ? [storedToken(token)] : [storedToken(token), token] } } });
  }
  jar.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}

export async function purgeExpiredSessions(): Promise<number> {
  const r = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return r.count;
}
