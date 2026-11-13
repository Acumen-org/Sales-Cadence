import { beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics } from './helpers/db';

/**
 * How long a sign-in lasts.
 *
 * A day by default, because this is a shared workspace holding a CRM's contact data and a browser
 * left open on a desk should not stay signed in indefinitely. "Keep me signed in" is the
 * deliberate opt-out for a machine one person uses.
 */

// `createSession` writes a cookie, which needs a request scope; the store is stubbed so the test
// can watch the only thing it is about - the expiry that goes into the database.
vi.mock('next/headers', () => ({ cookies: async () => ({ set: () => {}, get: () => undefined }) }));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('session lifetime', () => {
  let userId: string;

  beforeAll(async () => {
    await resetDb();
    const b = await seedBasics();
    userId = b.users.alisa.id;
  });

  it('lasts a day by default', async () => {
    const { createSession } = await import('@/lib/auth/session');
    const before = Date.now();
    const token = await createSession(userId);
    const session = await prisma.session.findUniqueOrThrow({ where: { token } });
    const life = session.expiresAt.getTime() - before;
    expect(life).toBeGreaterThan(23 * HOUR);
    expect(life).toBeLessThanOrEqual(DAY + HOUR);
  });

  it('lasts a month when the person asked to be remembered', async () => {
    const { createSession } = await import('@/lib/auth/session');
    const before = Date.now();
    const token = await createSession(userId, true);
    const session = await prisma.session.findUniqueOrThrow({ where: { token } });
    expect(session.expiresAt.getTime() - before).toBeGreaterThan(29 * DAY);
  });

  it('expired sessions are purged, live ones are not', async () => {
    const { purgeExpiredSessions } = await import('@/lib/auth/session');
    await prisma.session.create({ data: { token: 'stale-token', userId, expiresAt: new Date(Date.now() - HOUR) } });
    const live = await prisma.session.count({ where: { expiresAt: { gt: new Date() } } });
    expect(await purgeExpiredSessions()).toBe(1);
    expect(await prisma.session.count()).toBe(live);
  });
});
