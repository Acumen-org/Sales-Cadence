import { createHash } from 'node:crypto';
import { prisma } from './db';

/**
 * U19, U27, V09: a one-minute sliding request count kept in the database, so every server process and
 * the next restart see the same count. Each accepted request is one row; a refused one is not kept,
 * as before. A bucket names what is counted ("bw-push:<key hash>", "read:<key id>", "bw-fail:<caller>").
 */
export async function takeFromWindow(bucket: string, limit: number, now = new Date()): Promise<{ ok: boolean; used: number; retryAfter?: number }> {
  const since = new Date(now.getTime() - 60_000);
  const hit = await prisma.apiRateHit.create({ data: { bucket, at: now }, select: { id: true } });
  const window = { bucket, at: { gt: since, lte: now } };
  const row = await prisma.apiRateHit.aggregate({ where: window, _count: { _all: true }, _min: { at: true } });
  const used = row._count._all;
  // Now and then, rows over an hour old go, so the table stays small.
  if (used === 1) await prisma.apiRateHit.deleteMany({ where: { at: { lt: new Date(now.getTime() - 3_600_000) } } });
  if (used <= limit) return { ok: true, used };
  await prisma.apiRateHit.delete({ where: { id: hit.id } });
  const oldest = row._min.at ? row._min.at.getTime() : now.getTime();
  return { ok: false, used: used - 1, retryAfter: Math.max(1, Math.ceil((60_000 - (now.getTime() - oldest)) / 1000)) };
}

/** Forget every count (tests). */
export async function resetWindows(): Promise<void> {
  await prisma.apiRateHit.deleteMany({});
}

/** A short, stable, non-reversible name for a secret or an address inside a bucket. */
export const bucketId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Wrong keys one caller may send in a minute before it is slowed (401 becomes 429). */
export const WRONG_KEY_LIMIT = 20;
