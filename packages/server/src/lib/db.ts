/**
 * Prisma client singleton.
 *
 * `tsx watch` re-imports modules on every change; without the global cache each
 * reload would open another SQLite connection pool and leak handles.
 */
import { PrismaClient } from '@prisma/client';

import { isProduction, isTest } from '../env.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isTest ? [] : isProduction ? ['warn', 'error'] : ['warn', 'error'],
  });

if (!isProduction) globalForPrisma.prisma = prisma;

/**
 * SQLite defaults to a 5s lock timeout and rollback journalling. WAL lets the
 * SSE readers query while the download worker is writing progress, and the
 * longer busy_timeout absorbs the brief contention when it does.
 */
export async function configureSqlite(): Promise<void> {
  // $queryRawUnsafe, not $executeRawUnsafe: `PRAGMA journal_mode` answers with a
  // row, and Prisma rejects a result set from an "execute" call.
  for (const pragma of [
    'PRAGMA journal_mode = WAL;',
    'PRAGMA busy_timeout = 10000;',
    'PRAGMA synchronous = NORMAL;',
    'PRAGMA foreign_keys = ON;',
  ]) {
    await prisma.$queryRawUnsafe(pragma);
  }
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
