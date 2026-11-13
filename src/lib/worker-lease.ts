import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { prisma } from './db';

/**
 * T19: one worker only. The worker takes this lease (a row in Setting) before its first pass and
 * renews it every LEASE_RENEW_MS. A second copy (a manual `pnpm worker`, a raised count, the local
 * launcher pointed at this database) waits until the lease is free or has run out, instead of
 * running the scheduler and the CRM sync a second time. A clean stop gives the lease back at once;
 * the lease of a worker that died runs out after LEASE_MS.
 */
export const WORKER_LEASE_KEY = 'workerLease';
export const LEASE_MS = 120_000;
export const LEASE_RENEW_MS = 30_000;

export type WorkerLease = { holder: string; until: string };

export function newLeaseHolder() {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/** Takes or renews the lease for `holder`: false while another holder's lease has not run out. */
export async function takeWorkerLease(holder: string, now = new Date()): Promise<boolean> {
  const value = JSON.stringify({ holder, until: new Date(now.getTime() + LEASE_MS).toISOString() } satisfies WorkerLease);
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${WORKER_LEASE_KEY}, ${value}::jsonb, ${now})
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = EXCLUDED."updatedAt"
    WHERE "Setting"."value"->>'holder' = ${holder}
       OR ("Setting"."value"->>'until')::timestamptz < ${now.toISOString()}::timestamptz
    RETURNING "key"`;
  return rows.length > 0;
}

/** Gives the lease back, if `holder` still has it. */
export async function releaseWorkerLease(holder: string) {
  await prisma.$executeRaw`DELETE FROM "Setting" WHERE "key" = ${WORKER_LEASE_KEY} AND "value"->>'holder' = ${holder}`;
}
