import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

type LogOption = 'query' | 'warn' | 'error' | { emit: 'event'; level: 'query' };

/**
 * PRISMA_LOG=query prints every statement; PRISMA_LOG=events emits them as `$on('query')`
 * events instead, which is how the query-count tripwire measures a page without printing
 * thousands of lines. Neither is on by default, and tests are silent.
 */
function logLevels(): LogOption[] {
  if (process.env.PRISMA_LOG === 'events') return [{ emit: 'event', level: 'query' }];
  if (process.env.PRISMA_LOG === 'query') return ['query', 'warn', 'error'];
  if (process.env.PRISMA_LOG === 'silent' || process.env.VITEST) return [];
  return ['warn', 'error'];
}

/**
 * T20: this process's pool size and wait (DATABASE_CONNECTION_LIMIT, DATABASE_POOL_TIMEOUT, set by
 * the Nomad job) are added to DATABASE_URL here, after `&` when the stored address already carries
 * parameters of its own (sslmode=require, say), so it is never turned into a broken address.
 * A parameter the address already sets is left as it is. Neither set: the address is used as it is.
 */
export function pooledDatabaseUrl(url: string | undefined, limit = process.env.DATABASE_CONNECTION_LIMIT, timeout = process.env.DATABASE_POOL_TIMEOUT): string | undefined {
  if (!url) return url;
  const add: [string, string | undefined][] = [['connection_limit', limit], ['pool_timeout', timeout]];
  const at = url.indexOf('?');
  const params = new URLSearchParams(at < 0 ? '' : url.slice(at + 1));
  let changed = false;
  for (const [key, value] of add) {
    if (value && !params.has(key)) {
      params.set(key, value);
      changed = true;
    }
  }
  return changed ? `${at < 0 ? url : url.slice(0, at)}?${params.toString()}` : url;
}

const datasourceUrl = pooledDatabaseUrl(process.env.DATABASE_URL);

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({ log: logLevels() as never, ...(datasourceUrl && datasourceUrl !== process.env.DATABASE_URL ? { datasourceUrl } : {}) });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export type Db = PrismaClient;
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * The database's clock. Bellwether reads status changes since a time Cadence gave it, so statusChangedAt
 * and that serverTime come from one clock every app server shares, not each server's own (B062).
 */
export async function databaseNow(tx: Tx | PrismaClient = prisma): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return row.now;
}
