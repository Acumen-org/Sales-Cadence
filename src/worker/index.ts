import 'dotenv/config';
import { prisma } from '../lib/db';
import { env } from '../lib/env';
import { SYSTEM_ACTOR } from '../lib/audit';
import { purgeExpiredSessions } from '../lib/auth/session-purge';
import { refreshPersonCache } from '../lib/person-cache';
import { runSchedulerTick } from '../lib/engine/tasks';
import { reconcile } from '../lib/engine/reconcile';
import { getTwentyClient } from '../lib/twenty';

/**
 * Cadence worker: runs beside the web app.
 *  - every WORKER_TICK_SECONDS: scheduler tick (generate due steps, complete finished enrollments)
 *  - once a day at RECONCILE_HOUR: reconcile the last N days of Twenty activity
 *  - once a day at CACHE_REFRESH_HOUR: refresh the person/company cache
 *  - hourly: purge expired sessions
 */
const e = env();
const log = (msg: string, extra?: unknown) => console.log(`[worker ${new Date().toISOString()}] ${msg}`, extra ?? '');

let lastReconcileDay = '';
let lastRefreshDay = '';
let lastPurgeHour = -1;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const stats = await runSchedulerTick({ actor: SYSTEM_ACTOR });
    if (stats.generated || stats.completed) log('scheduler', stats);

    const now = new Date();
    const day = now.toDateString();
    const hour = now.getHours();

    if (hour === e.RECONCILE_HOUR && lastReconcileDay !== day) {
      lastReconcileDay = day;
      log('reconcile: start');
      try {
        const stats = await reconcile({ actor: SYSTEM_ACTOR });
        log('reconcile: done', stats);
      } catch (err) {
        log('reconcile: failed', err);
      }
    }

    if (hour === e.CACHE_REFRESH_HOUR && lastRefreshDay !== day) {
      lastRefreshDay = day;
      try {
        const client = await getTwentyClient();
        const since = new Date(now.getTime() - 36 * 3_600_000).toISOString();
        const stats = await refreshPersonCache(client, { since });
        log('cache refresh: done', stats);
      } catch (err) {
        log('cache refresh: failed', err);
      }
    }

    if (hour !== lastPurgeHour) {
      lastPurgeHour = hour;
      const purged = await purgeExpiredSessions();
      if (purged) log(`purged ${purged} expired sessions`);
    }
  } catch (err) {
    log('tick failed', err);
  } finally {
    running = false;
  }
}

async function main() {
  log(`starting: tick every ${e.WORKER_TICK_SECONDS}s, reconcile at ${e.RECONCILE_HOUR}:00, cache refresh at ${e.CACHE_REFRESH_HOUR}:00, twenty=${e.TWENTY_MODE}${e.CADENCE_DRY_RUN ? ' (dry run)' : ''}`);
  await tick();
  const timer = setInterval(tick, e.WORKER_TICK_SECONDS * 1000);
  const stop = async () => {
    clearInterval(timer);
    log('stopping');
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
