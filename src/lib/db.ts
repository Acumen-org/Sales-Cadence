import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export type Db = PrismaClient;
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
