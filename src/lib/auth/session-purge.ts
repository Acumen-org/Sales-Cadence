import { prisma } from '../db';

/** Delete expired sessions. Lives apart from session.ts so the worker never imports next/headers. */
export async function purgeExpiredSessions(): Promise<number> {
  const r = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return r.count;
}
