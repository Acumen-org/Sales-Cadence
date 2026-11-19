import { prisma } from '../db';
import { env } from '../env';
import { logAudit, type AuditActor } from '../audit';
import { microsoftConfig } from '../auth/microsoft';
import { currentToken, encodeSharingUrl, graphThrottled, mayReadFiles, noteThrottle, type AppToken } from './sharepoint-player';

/**
 * Every Teams recording added to Cadence, copied into the company's Meeting Recordings library
 * (owner, 17-19 November 2026).
 *
 * A Teams recording sits in its organizer's OneDrive: only the meeting's invitees can open it, Teams
 * deletes it when its expiry date comes, and it goes with the organizer's account. The library is a
 * SharePoint site that everyone in the company can view. Cadence copies the file there with Graph's
 * own copy (the file never passes through Cadence), clears any expiry date the copy carries, and
 * plays the copy from then on. The pasted link stays on the meeting: its Teams transcript is found
 * from the original file.
 *
 * Microsoft asks two things of the app the sign-in uses: Files.Read.All to read the original, and
 * Sites.Selected with write access granted on the library site alone. A Microsoft 365 admin gives
 * both; Settings > Sign-in says which is missing.
 */

export const LIBRARY_KEY = 'meetingLibrary';
const SITE_ROLE = 'Sites.Selected';
const TIMEOUT_MS = 15_000;
/** Copies started in one pass. Graph does the copying; Cadence follows each one. */
const STARTS_PER_PASS = 2;
const MAX_TRIES = 8;
/** A copy Microsoft has not finished in this long is started again. */
const STUCK_MS = 3 * 3_600_000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LibraryConfig = {
  siteUrl: string;
  siteId?: string;
  driveId?: string;
  rootId?: string;
  /** The last check: whether Cadence could find the library and write to it. */
  check?: { at: string; ok: boolean; why?: string };
};

const SYSTEM: AuditActor = { type: 'SYSTEM', label: 'Cadence' };
const graphUrl = () => env().MICROSOFT_GRAPH_URL.replace(/\/+$/, '');
export const mayWriteLibrary = (roles: string[]) => mayReadFiles(roles) && roles.includes(SITE_ROLE);

/** A link Cadence copies: a recording in OneDrive or SharePoint. */
export function copyable(sourceUrl: string | null | undefined): boolean {
  if (!sourceUrl) return false;
  try {
    const u = new URL(sourceUrl.trim());
    return u.protocol === 'https:' && u.hostname.toLowerCase().endsWith('.sharepoint.com');
  } catch {
    return false;
  }
}

/** The site address as an admin types it, reduced to https://<tenant>.sharepoint.com/sites/<name>. */
export function normaliseSiteUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname.toLowerCase().endsWith('.sharepoint.com')) return null;
  const m = /^\/(sites|teams)\/([^/]+)/i.exec(u.pathname);
  return m ? `https://${u.hostname.toLowerCase()}/${m[1].toLowerCase()}/${m[2]}` : null;
}

/**
 * The addresses Graph may know the file by. A sharing link or a file's own path is asked as it is;
 * a Stream page names the file's path in its `id`; SharePoint's embed player names the file by its
 * unique id, which the site's Doc.aspx and download.aspx pages take too.
 */
export function sourceCandidates(raw: string): string[] {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return []; }
  const out: string[] = [];
  const sitePath = u.pathname.split('/_layouts/')[0].replace(/\/+$/, '');
  if (/\/_layouts\/15\/stream\.aspx$/i.test(u.pathname)) {
    const id = u.searchParams.get('id');
    if (id?.startsWith('/')) out.push(`${u.origin}${encodeURI(id)}`);
  }
  if (/\/_layouts\/15\/embed\.aspx$/i.test(u.pathname)) {
    const unique = (u.searchParams.get('UniqueId') ?? u.searchParams.get('uniqueId') ?? '').replace(/[{}]/g, '');
    if (GUID.test(unique)) {
      out.push(`${u.origin}${sitePath}/_layouts/15/Doc.aspx?sourcedoc=%7B${unique}%7D`);
      out.push(`${u.origin}${sitePath}/_layouts/15/download.aspx?UniqueId=${unique}`);
    }
  }
  out.push(u.toString());
  return [...new Set(out)];
}

type GraphAnswer = { status: number; body: Record<string, unknown>; headers: Headers } | null;

async function graph(path: string, token: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch, base = graphUrl()): Promise<GraphAnswer> {
  if (graphThrottled()) return null;
  let res: Response;
  try {
    res = await fetchImpl(path.startsWith('http') ? path : `${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (noteThrottle(res)) return null;
  const text = await res.text().catch(() => '');
  let body: Record<string, unknown> = {};
  try { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { body = {}; }
  return { status: res.status, body, headers: res.headers };
}

const graphError = (a: NonNullable<GraphAnswer>) => {
  const e = a.body.error as { message?: unknown; code?: unknown } | undefined;
  return String(e?.message ?? e?.code ?? `Microsoft answered ${a.status}`).split(/\r?\n/)[0];
};

/** The library's site, its document library and that library's top folder, from the site address. */
export async function resolveLibrary(siteUrl: string, token: string, fetchImpl: typeof fetch = fetch, base = graphUrl()): Promise<{ siteId: string; driveId: string; rootId: string } | { error: string }> {
  const u = new URL(siteUrl);
  const site = await graph(`/v1.0/sites/${u.hostname}:${u.pathname}?$select=id`, token, {}, fetchImpl, base);
  if (!site) return { error: 'Microsoft could not be reached. Try again in a minute.' };
  if (site.status === 404) return { error: `Microsoft has no site at ${siteUrl}.` };
  if (site.status === 401 || site.status === 403) return { error: `Microsoft refused Cadence the site: ${graphError(site)}. The admin grants the app write access to this site (Sites.Selected).` };
  if (site.status >= 400 || typeof site.body.id !== 'string') return { error: graphError(site) };
  const siteId = site.body.id;
  const root = await graph(`/v1.0/sites/${siteId}/drive/root?$select=id,parentReference`, token, {}, fetchImpl, base);
  if (!root) return { error: 'Microsoft could not be reached. Try again in a minute.' };
  if (root.status >= 400) return { error: `Microsoft would not open the site's documents: ${graphError(root)}` };
  const driveId = (root.body.parentReference as { driveId?: unknown } | undefined)?.driveId;
  if (typeof root.body.id !== 'string' || typeof driveId !== 'string') return { error: "The site's document library could not be read." };
  return { siteId, driveId, rootId: root.body.id };
}

/** Proof that Cadence may write there: a small file put in the library and taken out again. */
async function writeProbe(driveId: string, token: string, fetchImpl: typeof fetch = fetch, base = graphUrl()): Promise<string | null> {
  const name = `cadence-check-${Date.now()}.txt`;
  const put = await graph(`/v1.0/drives/${driveId}/root:/${name}:/content`, token, { method: 'PUT', body: 'Cadence checks it can save recordings here. This file is deleted at once.', headers: { 'content-type': 'text/plain' } }, fetchImpl, base);
  if (!put) return 'Microsoft could not be reached. Try again in a minute.';
  if (put.status >= 400 || typeof put.body.id !== 'string') return `Cadence cannot save files in the library: ${graphError(put)}. The admin grants the app write (not read) access to this site.`;
  await graph(`/v1.0/drives/${driveId}/items/${put.body.id}`, token, { method: 'DELETE' }, fetchImpl, base);
  return null;
}

export async function libraryConfig(): Promise<LibraryConfig | null> {
  const row = await prisma.setting.findUnique({ where: { key: LIBRARY_KEY } });
  const v = row?.value as LibraryConfig | undefined;
  return v && typeof v.siteUrl === 'string' && v.siteUrl ? v : null;
}

async function saveConfig(c: LibraryConfig) {
  await prisma.setting.upsert({ where: { key: LIBRARY_KEY }, create: { key: LIBRARY_KEY, value: c }, update: { value: c } });
}

async function libraryToken(): Promise<AppToken | { error: string }> {
  const c = await microsoftConfig();
  if (!c) return { error: 'Microsoft sign-in is not set up.' };
  const token = await currentToken(c);
  if ('error' in token) return { error: `Microsoft gave Cadence no token: ${token.error}` };
  if (!mayReadFiles(token.roles)) return { error: 'The app needs the Files.Read.All application permission to read the recordings people paste.' };
  if (!token.roles.includes(SITE_ROLE)) return { error: 'The app needs the Sites.Selected application permission, with write access granted on the library site.' };
  return token;
}

/** Save the library's address and check it: Cadence finds the site and can write to it. */
export async function setLibrary(siteUrl: string, fetchImpl: typeof fetch = fetch): Promise<LibraryConfig> {
  const at = new Date().toISOString();
  const token = await libraryToken();
  let config: LibraryConfig = { siteUrl };
  if ('error' in token) config.check = { at, ok: false, why: token.error };
  else {
    const found = await resolveLibrary(siteUrl, token.value, fetchImpl);
    if ('error' in found) config.check = { at, ok: false, why: found.error };
    else {
      const refused = await writeProbe(found.driveId, token.value, fetchImpl);
      config = { siteUrl, ...found, check: refused ? { at, ok: false, why: refused } : { at, ok: true } };
    }
  }
  await saveConfig(config);
  return config;
}

/** The library ready to copy into, resolving it once when its ids are not known yet. */
async function readyLibrary(token: string): Promise<Required<Pick<LibraryConfig, 'siteUrl' | 'driveId' | 'rootId'>> | null> {
  const c = await libraryConfig();
  if (!c) return null;
  if (c.driveId && c.rootId) return { siteUrl: c.siteUrl, driveId: c.driveId, rootId: c.rootId };
  const found = await resolveLibrary(c.siteUrl, token);
  if ('error' in found) { await saveConfig({ ...c, check: { at: new Date().toISOString(), ok: false, why: found.error } }); return null; }
  await saveConfig({ ...c, ...found });
  return { siteUrl: c.siteUrl, driveId: found.driveId, rootId: found.rootId };
}

type SourceFile = { driveId: string; id: string; name: string };
/** `gone`: Graph says the file is not there; `refused`: Microsoft would not let Cadence read it. */
type SourceAnswer = SourceFile | { gone: string } | { refused: string } | null;

/** The original file behind the pasted link. */
export async function sourceFile(raw: string, token: string, fetchImpl: typeof fetch = fetch, base = graphUrl()): Promise<SourceAnswer> {
  let refused: string | null = null;
  for (const candidate of sourceCandidates(raw)) {
    const a = await graph(`/v1.0/shares/${encodeSharingUrl(candidate)}/driveItem?$select=id,name,file,parentReference`, token, {}, fetchImpl, base);
    if (!a) return null;
    if (a.status === 401 || a.status === 403) { refused = graphError(a); continue; }
    if (a.status >= 400) continue;
    const driveId = (a.body.parentReference as { driveId?: unknown } | undefined)?.driveId;
    if (typeof a.body.id === 'string' && typeof driveId === 'string' && a.body.file) return { driveId, id: a.body.id, name: typeof a.body.name === 'string' ? a.body.name : 'Meeting recording.mp4' };
  }
  if (refused) return { refused };
  return { gone: /\/_layouts\/15\/embed\.aspx/i.test(raw) ? 'Cadence could not find the file behind this embed code. Edit the meeting and paste the recording’s sharing link from OneDrive instead.' : 'The recording is no longer in OneDrive: it was deleted, it expired, or the link is wrong.' };
}

/** Ask Graph to copy the file into the library. The address that follows the copy, or why not. */
export async function startCopy(src: SourceFile, lib: { driveId: string; rootId: string }, token: string, fetchImpl: typeof fetch = fetch, base = graphUrl()): Promise<{ monitor: string } | { error: string; retry: boolean }> {
  const a = await graph(`/v1.0/drives/${src.driveId}/items/${src.id}/copy?@microsoft.graph.conflictBehavior=rename`, token, { method: 'POST', body: JSON.stringify({ parentReference: { driveId: lib.driveId, id: lib.rootId }, name: src.name }) }, fetchImpl, base);
  if (!a) return { error: 'Microsoft could not be reached.', retry: true };
  const monitor = a.headers.get('location');
  if (a.status === 202 && monitor && trustedMonitor(monitor, base)) return { monitor };
  return { error: `Microsoft would not copy the recording: ${graphError(a)}`, retry: a.status !== 404 };
}

/** Graph's monitor lives on SharePoint (or Graph itself); nothing else is followed. */
function trustedMonitor(url: string, base = graphUrl()): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (host.endsWith('.sharepoint.com') || host === 'graph.microsoft.com' || host === new URL(base).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type CopyProgress = { done: string } | { failed: string } | { waiting: true };

/** Where a copy stands. The monitor address carries its own access: no token goes to it. */
export async function followCopy(monitor: string, fetchImpl: typeof fetch = fetch, base = graphUrl()): Promise<CopyProgress> {
  if (!trustedMonitor(monitor, base)) return { failed: 'Microsoft gave an address Cadence does not follow.' };
  let res: Response;
  try {
    res = await fetchImpl(monitor, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { waiting: true };
  }
  if (noteThrottle(res)) return { waiting: true };
  // Finished copies sometimes answer with a redirect to the new file instead of a status.
  if (res.status >= 300 && res.status < 400) {
    const id = /\/items\/([^/?#]+)/.exec(res.headers.get('location') ?? '')?.[1];
    return id ? { done: decodeURIComponent(id) } : { waiting: true };
  }
  const body = (await res.json().catch(() => ({}))) as { status?: unknown; resourceId?: unknown; error?: { message?: unknown } };
  if (body.status === 'completed' && typeof body.resourceId === 'string') return { done: body.resourceId };
  if (body.status === 'failed') return { failed: `Microsoft could not copy the recording: ${String(body.error?.message ?? 'no reason given')}` };
  if (res.status === 404) return { failed: 'Microsoft lost track of the copy.' };
  return { waiting: true };
}

const EXPIRY = /expir/i;

/**
 * The finished copy: its address, its player, and no expiry date. Teams marks a recording with an
 * expiry column; a copy should not carry it, and where it does, Cadence clears it and checks.
 */
export async function finishCopy(itemId: string, lib: { siteUrl: string; driveId: string }, token: string, fetchImpl: typeof fetch = fetch, base = graphUrl()): Promise<{ webUrl: string; embedUrl: string; cleared: string[] } | { error: string }> {
  const item = await graph(`/v1.0/drives/${lib.driveId}/items/${itemId}?$select=id,webUrl,sharepointIds`, token, {}, fetchImpl, base);
  if (!item || item.status >= 400) return { error: item ? `The copy could not be read: ${graphError(item)}` : 'Microsoft could not be reached.' };
  const unique = String((item.body.sharepointIds as { listItemUniqueId?: unknown } | undefined)?.listItemUniqueId ?? '');
  const webUrl = typeof item.body.webUrl === 'string' ? item.body.webUrl : '';
  if (!GUID.test(unique) || !webUrl) return { error: 'The copy could not be read.' };
  const site = new URL(lib.siteUrl);
  const embed = new URL(`${site.origin}${site.pathname.replace(/\/+$/, '')}/_layouts/15/embed.aspx`);
  embed.searchParams.set('UniqueId', unique);

  const fieldsPath = `/v1.0/drives/${lib.driveId}/items/${itemId}/listItem/fields`;
  const expiring = async () => {
    const f = await graph(fieldsPath, token, {}, fetchImpl, base);
    if (!f || f.status >= 400) return null;
    return Object.entries(f.body).filter(([k, v]) => EXPIRY.test(k) && v !== null && v !== '').map(([k]) => k);
  };
  const set = await expiring();
  if (set === null) return { error: 'Cadence could not check the copy for an expiry date.' };
  if (set.length) {
    const patched = await graph(fieldsPath, token, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(set.map((k) => [k, null]))) }, fetchImpl, base);
    const still = patched && patched.status < 400 ? await expiring() : null;
    if (still === null || still.length) return { error: `The copy still has an expiry date (${set.join(', ')}) that Cadence could not clear${patched && patched.status >= 400 ? `: ${graphError(patched)}` : ''}.` };
  }
  return { webUrl, embedUrl: embed.toString(), cleared: set };
}

const backoff = (tries: number, now: number) => new Date(now + Math.min(24 * 3_600_000, 15 * 60_000 * 2 ** Math.max(0, tries - 1)));

/** What a meeting's library fields become when its link is saved: a changed link starts over. */
export function libraryFieldsFor(sourceUrl: string, existing?: { sourceUrl: string } | null) {
  if (existing && existing.sourceUrl === sourceUrl.trim()) return {};
  return {
    libraryStatus: copyable(sourceUrl) ? 'PENDING' : null,
    libraryError: null, libraryTries: 0, libraryNextAt: null, libraryMonitorUrl: null,
    libraryItemId: null, libraryUrl: null, libraryEmbedUrl: null, libraryCopiedAt: null,
  };
}

/** Queue every meeting whose recording is not in the library yet, failed ones included. */
export async function queueExistingRecordings(): Promise<number> {
  const rows = await prisma.meeting.findMany({ where: { sourceUrl: { contains: '.sharepoint.com', mode: 'insensitive' }, OR: [{ libraryStatus: null }, { libraryStatus: 'FAILED' }] }, select: { id: true, sourceUrl: true } });
  const ids = rows.filter((r) => copyable(r.sourceUrl)).map((r) => r.id);
  if (!ids.length) return 0;
  const { count } = await prisma.meeting.updateMany({ where: { id: { in: ids } }, data: { libraryStatus: 'PENDING', libraryError: null, libraryTries: 0, libraryNextAt: null, libraryMonitorUrl: null } });
  return count;
}

export type LibraryCounts = { done: number; waiting: number; failed: { id: string; title: string; error: string | null }[] };
export async function libraryCounts(): Promise<LibraryCounts> {
  const [done, waiting, failed] = await Promise.all([
    prisma.meeting.count({ where: { libraryStatus: 'DONE' } }),
    prisma.meeting.count({ where: { libraryStatus: { in: ['PENDING', 'COPYING'] } } }),
    prisma.meeting.findMany({ where: { libraryStatus: 'FAILED' }, select: { id: true, title: true, libraryError: true }, orderBy: { occurredAt: 'desc' }, take: 20 }),
  ]);
  return { done, waiting, failed: failed.map((m) => ({ id: m.id, title: m.title, error: m.libraryError })) };
}

/**
 * The worker's pass: follow the copies in progress, then start the next ones. Null while Microsoft
 * or the library is not ready, so nothing is counted as tried.
 */
export async function runLibraryCopies(now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<{ started: number; copied: number; failed: number } | null> {
  const config = await libraryConfig();
  if (!config) return null;
  const token = await libraryToken();
  if ('error' in token) return null;
  const lib = await readyLibrary(token.value);
  if (!lib) return null;
  const stats = { started: 0, copied: 0, failed: 0 };
  const fail = async (id: string, tries: number, error: string, retry: boolean) => {
    const last = !retry || tries >= MAX_TRIES;
    await prisma.meeting.update({ where: { id }, data: { libraryStatus: last ? 'FAILED' : 'PENDING', libraryError: error, libraryTries: tries, libraryNextAt: last ? null : backoff(tries, now), libraryMonitorUrl: null } });
    if (last) stats.failed++;
  };

  /** The copy made: checked, then the meeting plays it. Kept by id when the check fails, so a retry makes no second copy. */
  const complete = async (m: { id: string; sourceUrl: string }, itemId: string, tries: number, from: string) => {
    const finished = await finishCopy(itemId, lib, token.value, fetchImpl);
    if ('error' in finished) {
      // A copy that cannot be read any more (deleted from the library) is made again.
      await prisma.meeting.update({ where: { id: m.id }, data: { libraryItemId: finished.error.startsWith('The copy could not be read') ? null : itemId } });
      await fail(m.id, tries, finished.error, true);
      return;
    }
    // Only where nobody changed the meeting's link meanwhile.
    const { count } = await prisma.meeting.updateMany({ where: { id: m.id, sourceUrl: m.sourceUrl, libraryStatus: from }, data: { libraryStatus: 'DONE', libraryError: null, libraryMonitorUrl: null, libraryNextAt: null, libraryTries: tries, libraryItemId: itemId, libraryUrl: finished.webUrl, libraryEmbedUrl: finished.embedUrl, libraryCopiedAt: new Date(now) } });
    if (!count) return;
    stats.copied++;
    await logAudit({ entityType: 'meeting', entityId: m.id, action: 'recording_copied', actor: SYSTEM, details: { libraryUrl: finished.webUrl, expiryCleared: finished.cleared } });
    // Twenty's recording link becomes the company's copy.
    const { pushMeetingToCrm } = await import('./crm');
    await pushMeetingToCrm(m.id).catch(() => undefined);
  };

  const copying = await prisma.meeting.findMany({ where: { libraryStatus: 'COPYING' }, select: { id: true, sourceUrl: true, libraryTries: true, libraryMonitorUrl: true, libraryNextAt: true } });
  for (const m of copying) {
    if (graphThrottled()) return stats;
    const progress = m.libraryMonitorUrl ? await followCopy(m.libraryMonitorUrl, fetchImpl) : ({ failed: 'The copy was lost.' } as CopyProgress);
    if ('waiting' in progress) {
      // libraryNextAt holds when the copy started.
      if (m.libraryNextAt && now - m.libraryNextAt.getTime() > STUCK_MS) await fail(m.id, m.libraryTries, 'Microsoft did not finish the copy in three hours.', true);
      continue;
    }
    if ('failed' in progress) { await fail(m.id, m.libraryTries, progress.failed, true); continue; }
    await complete(m, progress.done, m.libraryTries, 'COPYING');
  }

  const pending = await prisma.meeting.findMany({ where: { libraryStatus: 'PENDING', OR: [{ libraryNextAt: null }, { libraryNextAt: { lte: new Date(now) } }] }, orderBy: { occurredAt: 'desc' }, take: STARTS_PER_PASS, select: { id: true, sourceUrl: true, libraryTries: true, libraryItemId: true } });
  for (const m of pending) {
    if (graphThrottled()) break;
    const tries = m.libraryTries + 1;
    if (!copyable(m.sourceUrl)) { await prisma.meeting.update({ where: { id: m.id }, data: { libraryStatus: null } }); continue; }
    if (m.libraryItemId) { await complete(m, m.libraryItemId, tries, 'PENDING'); continue; }
    const src = await sourceFile(m.sourceUrl, token.value, fetchImpl);
    if (!src) continue;
    if ('gone' in src) { await fail(m.id, tries, src.gone, false); continue; }
    if ('refused' in src) { await fail(m.id, tries, `Microsoft would not let Cadence read the recording: ${src.refused}`, true); continue; }
    const started = await startCopy(src, lib, token.value, fetchImpl);
    if ('error' in started) { await fail(m.id, tries, started.error, started.retry); continue; }
    await prisma.meeting.update({ where: { id: m.id }, data: { libraryStatus: 'COPYING', libraryTries: tries, libraryMonitorUrl: started.monitor, libraryError: null, libraryNextAt: new Date(now) } });
    stats.started++;
  }
  return stats;
}
