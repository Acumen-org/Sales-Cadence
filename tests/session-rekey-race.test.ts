import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: () => {}, get: () => (jar.token ? { value: jar.token } : undefined) }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
const { requireUser } = await import('@/lib/auth/current-user');
const { storedToken } = await import('@/lib/auth/session');

/**
 * Release 2 re-keys a session stored before Q12 on its first use. A browser sends several requests at
 * once: one re-keys the row while the others are still between their two reads. None of them may be
 * sent to /login, and the row ends hashed.
 */
let b: Basics;
const N = 6;

describe('a pre-Q12 session used by several requests at once', () => {
  beforeEach(async () => { await resetDb(); b = await seedBasics(); });
  afterEach(() => { vi.restoreAllMocks(); jar.token = undefined; });

  it('signs every request in and leaves one hashed row', async () => {
    const raw = randomBytes(32).toString('hex');
    await prisma.session.create({ data: { token: raw, userId: b.users.alisa.id, expiresAt: new Date(Date.now() + 3_600_000) } });
    jar.token = raw;

    // The worst order, every time: all requests miss the hash; one reads the old token and re-keys
    // it; only then do the others read the old token.
    const findUnique = prisma.session.findUnique;
    const updateMany = prisma.session.updateMany;
    let hashReads = 0;
    let rawReads = 0;
    let allHashed!: () => void;
    let rekeyDone!: () => void;
    const hashedAll = new Promise<void>((r) => { allHashed = r; });
    const rekeyed = new Promise<void>((r) => { rekeyDone = r; });
    vi.spyOn(prisma.session, 'findUnique').mockImplementation((async (args: { where: { token?: string } }) => {
      if (args.where.token === raw) {
        await hashedAll;
        if (rawReads++ > 0) await rekeyed;
      } else if (++hashReads === N) allHashed();
      return findUnique.call(prisma.session, args as never);
    }) as never);
    vi.spyOn(prisma.session, 'updateMany').mockImplementation((async (args: unknown) => {
      const r = await updateMany.call(prisma.session, args as never);
      rekeyDone();
      return r;
    }) as never);

    const results = await Promise.allSettled(Array.from({ length: N }, () => requireUser()));
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value.id : String(r.reason)))).toEqual(Array(N).fill(b.users.alisa.id));
    expect(rawReads).toBe(N);
    const rows = await prisma.session.findMany({ where: { userId: b.users.alisa.id } });
    expect(rows.map((r) => r.token)).toEqual([storedToken(raw)]);
  });
});
