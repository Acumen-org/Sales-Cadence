import { prisma } from '../db';
import { env } from '../env';
import { clientIp } from '../public-api/keys';

/**
 * Audit Q02, Q03, Q08: how many password guesses either sign-in form takes. A try is refused when,
 * in the last 15 minutes, the same address from the same caller has had 5 tries, or the same
 * caller 20 on any addresses, or when the address has had 50 tries in a day from anywhere. The
 * per-caller limits mean one stranger hammering an address does not lock its owner out at their
 * own desk; the daily cap bounds a spread-out attack on one address (the admin's) to 50 guesses a
 * day instead of about 480. Each try is a row written before the password is checked, so parallel
 * tries cannot slip past the count; a refused try or a right password takes its row back, so only
 * real wrong guesses count. Rows older than a day are deleted as we go.
 */

export const TRY_WINDOW_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
export const LIMITS = { addressFromCaller: 5, caller: 20, addressPerDay: 50 } as const;

export type SignInForm = 'password' | 'admin';

/** The caller's address as the trusted proxy reports it, or "unknown". Never throws. */
export async function callerAddress(): Promise<string> {
  try {
    const { headers } = await import('next/headers');
    return clientIp(await headers(), env().API_TRUSTED_PROXY_HOPS) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Records this try and says whether it may go ahead. `attemptId` is handed back to
 * `forgetAttempt` once the password proves right.
 */
export async function takeAttempt(form: SignInForm, email: string, ip: string, now = new Date()): Promise<{ allowed: boolean; attemptId: string }> {
  const windowStart = new Date(now.getTime() - TRY_WINDOW_MS);
  const dayStart = new Date(now.getTime() - DAY_MS);
  await prisma.signInAttempt.deleteMany({ where: { createdAt: { lt: dayStart } } });
  const row = await prisma.signInAttempt.create({ data: { form, email, ip, createdAt: now } });
  const [pair, caller, day] = await Promise.all([
    prisma.signInAttempt.count({ where: { email, ip, createdAt: { gte: windowStart } } }),
    // An unknown caller address is everyone's: counting it would let one stranger lock out the team.
    ip === 'unknown' ? Promise.resolve(0) : prisma.signInAttempt.count({ where: { ip, createdAt: { gte: windowStart } } }),
    prisma.signInAttempt.count({ where: { email, createdAt: { gte: dayStart } } }),
  ]);
  const allowed = pair <= LIMITS.addressFromCaller && caller <= LIMITS.caller && day <= LIMITS.addressPerDay;
  if (!allowed) await forgetAttempt(row.id);
  return { allowed, attemptId: row.id };
}

/** A right password, or a try that was refused anyway: that row does not count against anyone. */
export async function forgetAttempt(attemptId: string): Promise<void> {
  await prisma.signInAttempt.deleteMany({ where: { id: attemptId } });
}
