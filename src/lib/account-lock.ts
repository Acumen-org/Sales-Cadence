import type { Tx } from './db';
/** Serialize blocking, enrollment and task generation for the same account. */
export async function lockAccounts(tx: Tx, ids: (string | null | undefined)[]) {
  for (const id of [...new Set(ids.filter((id): id is string => Boolean(id)))].sort()) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`account:${id}`}))`;
  }
}
