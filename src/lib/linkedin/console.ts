import { prisma } from '../db';
import { env } from '../env';
import { getSettings } from '../settings';
import { consoleUrl } from './keys';
import { storeEvents } from './events';

/**
 * The LinkedIn Console's read-only feed (its change C5): GET /api/ext/v1/events after a cursor, and
 * /api/ext/v1/accounts for each account's requests in the last 7 days. Webhooks bring events fast; the
 * feed catches up whatever a webhook missed. Both keep each event once, by its sequence number.
 */

const CURSOR_KEY = 'linkedinFeedCursor';
const FETCH_TIMEOUT_MS = 20_000;

/** Where the feed key comes from: the server's environment (wins), Settings > LinkedIn, or nowhere. */
export async function consoleKey(): Promise<{ key: string; from: 'server' | 'settings' } | null> {
  const fromEnv = env().LINKEDIN_CONSOLE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, from: 'server' };
  const fromSettings = (await getSettings()).linkedin.consoleApiKey;
  return fromSettings ? { key: fromSettings, from: 'settings' } : null;
}

export async function feedConfigured(): Promise<boolean> {
  return Boolean(consoleUrl() && (await consoleKey()));
}

async function get<T>(path: string, key?: string): Promise<T> {
  const k = key ?? (await consoleKey())?.key ?? '';
  const res = await fetch(`${consoleUrl()}${path}`, { headers: { authorization: `Bearer ${k}`, accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(res.status === 401 ? 'The LinkedIn Console refused the feed key (wrong, or revoked).' : `LinkedIn Console ${path.split('?')[0]} answered ${res.status}`);
  return (await res.json()) as T;
}

/** Try a key before keeping it: the Console's accounts list. Returns how many accounts it sees, or why not. */
export async function checkConsoleKey(key: string): Promise<{ ok: true; accounts: number } | { ok: false; error: string }> {
  if (!consoleUrl()) return { ok: false, error: 'The Console address (LINKEDIN_CONSOLE_URL) is not set on the server.' };
  try {
    const body = await get<{ accounts?: unknown[] } | unknown[]>('/api/ext/v1/accounts', key);
    const list = Array.isArray(body) ? body : Array.isArray(body.accounts) ? body.accounts : [];
    return { ok: true, accounts: list.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type FeedStatus = { cursor: string | null; at: string | null; error: string | null; stored?: number };

export async function feedStatus(): Promise<FeedStatus> {
  const row = await prisma.setting.findUnique({ where: { key: CURSOR_KEY } });
  const v = (row?.value ?? {}) as Partial<FeedStatus>;
  return { cursor: v.cursor ?? null, at: v.at ?? null, error: v.error ?? null };
}

async function saveStatus(s: FeedStatus) {
  await prisma.setting.upsert({ where: { key: CURSOR_KEY }, create: { key: CURSOR_KEY, value: s }, update: { value: s } });
}

/** Read the feed from the cursor on, a few pages at a time. Returns how many new events were kept. */
export async function pollFeed(now = new Date(), maxPages = 5): Promise<{ ran: boolean; stored: number; error?: string }> {
  if (!(await feedConfigured())) return { ran: false, stored: 0 };
  const status = await feedStatus();
  let cursor = status.cursor ?? '0';
  let stored = 0;
  try {
    for (let page = 0; page < maxPages; page++) {
      const body = await get<{ events?: unknown[]; next?: string | number | null; nextCursor?: string | number | null }>(`/api/ext/v1/events?after=${encodeURIComponent(cursor)}&limit=500`);
      const events = Array.isArray(body.events) ? body.events : [];
      const r = await storeEvents(events, 'feed');
      stored += r.stored;
      // The Console answers `nextCursor` (docs/event-feed.md); `next` was the spec's word.
      const cursorField = body.nextCursor ?? body.next;
      const next = cursorField != null ? String(cursorField) : r.lastSeq != null ? r.lastSeq.toString() : null;
      if (!events.length || !next || next === cursor) break;
      cursor = next;
    }
    await saveStatus({ cursor, at: now.toISOString(), error: null, stored });
    await pollAccounts(now);
    return { ran: true, stored };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await saveStatus({ cursor, at: now.toISOString(), error: message.slice(0, 300) });
    return { ran: true, stored, error: message };
  }
}

type ConsoleAccount = { id?: unknown; linkedinName?: unknown; name?: unknown; invitesLast7Days?: unknown; inviteWeeklyLimit?: unknown };

/** Each account's name and how many requests it sent in the last 7 days. */
async function pollAccounts(now: Date) {
  const body = await get<{ accounts?: ConsoleAccount[] } | ConsoleAccount[]>('/api/ext/v1/accounts');
  const list = Array.isArray(body) ? body : Array.isArray(body.accounts) ? body.accounts : [];
  for (const a of list) {
    const id = typeof a.id === 'string' ? a.id : null;
    if (!id) continue;
    const name = String(a.linkedinName ?? a.name ?? id);
    const invites = Number.isFinite(Number(a.invitesLast7Days)) ? Math.max(0, Math.trunc(Number(a.invitesLast7Days))) : 0;
    const limit = Number.isFinite(Number(a.inviteWeeklyLimit)) && Number(a.inviteWeeklyLimit) > 0 ? Math.trunc(Number(a.inviteWeeklyLimit)) : null;
    await prisma.linkedInAccount.upsert({ where: { id }, create: { id, name, invitesLast7Days: invites, inviteWeeklyLimit: limit, seenAt: now }, update: { name, invitesLast7Days: invites, inviteWeeklyLimit: limit, seenAt: now } });
  }
}
