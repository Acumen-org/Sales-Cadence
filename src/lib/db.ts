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

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient({ log: logLevels() as never });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export type Db = PrismaClient;
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
