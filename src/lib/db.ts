import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function logLevels(): ('query' | 'warn' | 'error')[] {
  if (process.env.PRISMA_LOG === 'query') return ['query', 'warn', 'error'];
  if (process.env.PRISMA_LOG === 'silent' || process.env.VITEST) return [];
  return ['warn', 'error'];
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient({ log: logLevels() });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export type Db = PrismaClient;
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
