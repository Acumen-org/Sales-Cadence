import { prisma } from '../db';
import { env } from '../env';
import { consoleUrl } from './keys';
import { storeEvents } from './events';

/**
 * The LinkedIn Console's read-only feed (its change C5): GET /api/ext/v1/events after a cursor, and
 * /api/ext/v1/accounts for each account's requests in the last 7 days. Webhooks bring events fast; the
 * feed catches up whatever a webhook missed. Both keep each event once, by its sequence number.
 */

const CURSOR_KEY = 'linkedinFeedCursor';
const FETCH_TIMEOUT_MS = 20_000;

export function feedConfigured(): boolean {
  return Boolean(consoleUrl() && env().LINKEDIN_CONSOLE_API_KEY);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${consoleUrl()}${path}`, { headers: { authorization: `Bearer ${env().LINKEDIN_CONSOLE_API_KEY}`, accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`LinkedIn Console ${path.split('?')[0]} answered ${res.status}`);
  return (await res.json()) as T;
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
  if (!feedConfigured()) return { ran: false, stored: 0 };
  const status = await feedStatus();
  let cursor = status.cursor ?? '0';
  let stored = 0;
  try {
    for (let page = 0; page < maxPages; page++) {
      const body = await get<{ events?: unknown[]; next?: string | number | null }>(`/api/ext/v1/events?after=${encodeURIComponent(cursor)}&limit=500`);
      const events = Array.isArray(body.events) ? body.events : [];
      const r = await storeEvents(events, 'feed');
      stored += r.stored;
      const next = body.next != null ? String(body.next) : r.lastSeq != null ? r.lastSeq.toString() : null;
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
