import { getTwentyClient } from '@/lib/twenty';
import { prisma } from '@/lib/db';
import { upsertCompanyCache, upsertPersonCache } from '@/lib/person-cache';

/**
 * Re-reading a record from Twenty when someone opens it, without ever making them wait for it or
 * showing them the gateway's error page.
 *
 * The page renders from the cache at once; this runs after that paint. When Twenty answers and the
 * record changed, the page refreshes itself in place. When Twenty fails, the failure is counted
 * here and nothing is shown on the record: after three failures inside five minutes the live read
 * pauses for five minutes, so a gateway that is down does not add a slow round trip to every click.
 * Settings > Twenty shows the count and the pause.
 */
type Kind = 'person' | 'company';
const WINDOW_MS = 5 * 60_000;
const PAUSE_MS = 5 * 60_000;
const TRIP_AT = 3;

const failures: number[] = [];
let pausedUntil = 0;
let lastError: string | null = null;

export function liveReadHealth(now = Date.now()): { failuresLastHour: number; pausedUntil: Date | null; lastError: string | null } {
  return { failuresLastHour: failures.filter((t) => now - t < 3_600_000).length, pausedUntil: pausedUntil > now ? new Date(pausedUntil) : null, lastError };
}

/** For tests: forget every failure. */
export function resetLiveReadHealth() {
  failures.length = 0;
  pausedUntil = 0;
  lastError = null;
}

function recordFailure(err: unknown, now: number) {
  failures.push(now);
  while (failures.length && now - failures[0] > 3_600_000) failures.shift();
  lastError = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
  if (failures.filter((t) => now - t < WINDOW_MS).length >= TRIP_AT) pausedUntil = now + PAUSE_MS;
}

/** Twenty's timestamp against the cache's, as instants, so formatting can never read as a change. */
function moved(cached: Date | null | undefined, live: string | null | undefined): boolean {
  if (!live) return false;
  const at = new Date(live).getTime();
  return Number.isFinite(at) && cached?.getTime() !== at;
}

/** Returns whether the cached record changed; never throws. */
export async function liveRead(kind: Kind, id: string, now = Date.now()): Promise<{ changed: boolean; skipped: boolean }> {
  if (pausedUntil > now) return { changed: false, skipped: true };
  try {
    const client = await getTwentyClient();
    if (kind === 'person') {
      const fresh = await client.getPerson(id);
      if (!fresh) return { changed: false, skipped: false };
      const before = await prisma.personCache.findUnique({ where: { id }, select: { twentyUpdatedAt: true } });
      await upsertPersonCache(fresh);
      return { changed: moved(before?.twentyUpdatedAt, fresh.updatedAt), skipped: false };
    }
    const fresh = (await client.listCompanies({ ids: [id], limit: 1 })).items[0];
    if (!fresh) return { changed: false, skipped: false };
    const before = await prisma.companyCache.findUnique({ where: { id }, select: { twentyUpdatedAt: true } });
    await upsertCompanyCache(fresh);
    return { changed: moved(before?.twentyUpdatedAt, fresh.updatedAt), skipped: false };
  } catch (err) {
    recordFailure(err, now);
    return { changed: false, skipped: false };
  }
}
