import { prisma } from '../db';
import { env } from '../env';
import { microsoftConfig, type MicrosoftConfig } from '../auth/microsoft';
import { parseMeetingLink } from './providers';

/**
 * A SharePoint or OneDrive sharing link, turned into the player SharePoint itself hands out under
 * Share > Embed, so a Teams recording plays here as pasted.
 *
 * Microsoft Graph names the file behind a sharing link: the site it lives in and the id SharePoint
 * keys its embed player on (`<site>/_layouts/15/embed.aspx?UniqueId=<id>`, the same link Share >
 * Embed gives). Cadence asks as itself, with the app an admin saved under Settings > Sign-in, and
 * only once a Microsoft 365 admin has granted that app Files.Read.All; until then nothing is asked
 * and a sharing link opens in SharePoint as before. Cadence keeps the player's address, never the
 * file: whoever watches still needs access to the recording in their own Microsoft 365 session.
 */

/** Any one of these application permissions lets the app read a file's ids; Files.Read.All is the least. */
const FILE_ROLES = ['Files.Read.All', 'Files.ReadWrite.All', 'Sites.Read.All', 'Sites.ReadWrite.All', 'Sites.Manage.All', 'Sites.FullControl.All'];
/** Microsoft's last refusal, and the permissions the app had then: granting another one retires it. */
const REFUSED = 'sharePointPlayerRefused';
const TIMEOUT_MS = 8000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_NAME = /\.(mp4|webm|m4v|mov|wmv|avi|mkv|mpe?g|mp3|wav|m4a|aac)$/i;

export type AppToken = { value: string; roles: string[] };
export type Player = { embedUrl: string; title: string | null; date: string | null };

const graphUrl = () => env().MICROSOFT_GRAPH_URL.replace(/\/+$/, '');
export const mayReadFiles = (roles: string[]) => roles.some((r) => FILE_ROLES.includes(r));

/** Graph's form of a sharing link: `u!` and the link in base64url, unpadded. */
export function encodeSharingUrl(url: string): string {
  return `u!${Buffer.from(url, 'utf8').toString('base64url')}`;
}

/** What a Teams recording's file name says: "Alisa and Lloyd-20260811_143012-Meeting Recording.mp4". */
export function recordingName(name: string): { title: string | null; date: string | null } {
  const m = /^(.+?)-(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:_\d{4,6})?[-\s]+Meeting Recording(?:\.[a-z0-9]+)?$/i.exec(name.trim());
  return m ? { title: m[1].trim(), date: `${m[2]}-${m[3]}-${m[4]}` } : { title: null, date: null };
}

/** The app's own token, with the application permissions Microsoft granted it (its `roles` claim). */
export async function appToken(c: Pick<MicrosoftConfig, 'clientId' | 'tenantId' | 'clientSecret' | 'loginUrl'>, fetchImpl: typeof fetch = fetch): Promise<AppToken | { error: string }> {
  try {
    const res = await fetchImpl(`${c.loginUrl}/${c.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret, scope: 'https://graph.microsoft.com/.default' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown; error_description?: unknown };
    if (!res.ok || typeof body.access_token !== 'string') return { error: String(body.error_description ?? body.error ?? res.status).split(/\r?\n/)[0] };
    let roles: string[] = [];
    try {
      const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { roles?: unknown };
      if (Array.isArray(claims.roles)) roles = claims.roles.map(String);
    } catch {
      // A token that cannot be read carries no permission we can see.
    }
    return { value: body.access_token, roles };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The player for one sharing link, from Graph. Null when Graph cannot name the file or it is not a
 * recording; `refused` when Microsoft turns the app away, which Settings > Sign-in then shows.
 */
export async function playerFromGraph(url: string, token: string, fetchImpl: typeof fetch = fetch, base = graphUrl()): Promise<Player | { refused: string } | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/v1.0/shares/${encodeSharingUrl(url)}/driveItem?$select=name,file,sharepointIds`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
  const body = (await res.json().catch(() => ({}))) as { name?: unknown; file?: { mimeType?: unknown }; sharepointIds?: { siteUrl?: unknown; listItemUniqueId?: unknown }; error?: { message?: unknown } };
  if (res.status === 401 || res.status === 403) return { refused: String(body.error?.message ?? res.status).split(/\r?\n/)[0] };
  if (!res.ok) return null;
  const name = typeof body.name === 'string' ? body.name : '';
  if (!/^(video|audio)\//i.test(String(body.file?.mimeType ?? '')) && !MEDIA_NAME.test(name)) return null;
  const id = String(body.sharepointIds?.listItemUniqueId ?? '');
  let site: URL;
  try { site = new URL(String(body.sharepointIds?.siteUrl ?? '')); } catch { return null; }
  // Only SharePoint's own player goes into the frame, whatever the answer says.
  if (!GUID.test(id) || site.protocol !== 'https:' || !site.hostname.toLowerCase().endsWith('.sharepoint.com')) return null;
  const embed = new URL(`${site.origin}${site.pathname.replace(/\/+$/, '')}/_layouts/15/embed.aspx`);
  embed.searchParams.set('UniqueId', id);
  return { embedUrl: embed.toString(), ...recordingName(name) };
}

// A granted permission reaches the app with its next token, so one is kept for minutes, not the hour.
let kept: { key: string; token: AppToken; until: number } | null = null;

async function currentToken(c: MicrosoftConfig, fresh = false): Promise<AppToken | { error: string }> {
  const key = `${c.tenantId}|${c.clientId}|${c.clientSecret}`;
  if (!fresh && kept?.key === key && kept.until > Date.now()) return kept.token;
  const token = await appToken(c);
  if (!('error' in token)) kept = { key, token, until: Date.now() + 10 * 60_000 };
  return token;
}

const sameRoles = (a: string[], b: string[]) => [...a].sort().join(' ') === [...b].sort().join(' ');

/** Microsoft's refusal, while the app still has the permissions it was refused with. */
async function standingRefusal(roles: string[]): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: REFUSED } });
  const value = row?.value as { message?: unknown; roles?: unknown } | undefined;
  if (!value || !Array.isArray(value.roles) || !sameRoles(value.roles.map(String), roles)) return null;
  return String(value.message ?? '');
}

async function noteAnswer(answer: Player | { refused: string } | null, roles: string[]) {
  if (answer && 'refused' in answer) {
    const value = { message: answer.refused, roles, at: new Date().toISOString() };
    await prisma.setting.upsert({ where: { key: REFUSED }, create: { key: REFUSED, value }, update: { value } });
  } else if (answer) {
    await prisma.setting.deleteMany({ where: { key: REFUSED } });
  }
}

/** A sharing link SharePoint will not frame: its own player is the one that plays. */
function needsPlayer(raw: string): boolean {
  const link = parseMeetingLink(raw);
  if (link.provider !== 'SHAREPOINT' || link.embedUrl) return false;
  try { return new URL(raw.trim()).hostname.toLowerCase().endsWith('.sharepoint.com'); } catch { return false; }
}

/** The player for a pasted link, when it is a SharePoint sharing link and Microsoft lets Cadence look. */
export async function sharePointPlayer(raw: string): Promise<Player | null> {
  if (!needsPlayer(raw)) return null;
  const c = await microsoftConfig();
  if (!c) return null;
  const token = await currentToken(c);
  if ('error' in token || !mayReadFiles(token.roles)) return null;
  const answer = await playerFromGraph(raw.trim(), token.value);
  await noteAnswer(answer, token.roles);
  return answer && 'refused' in answer ? null : answer;
}

export type PlayerStatus = { plays: true } | { plays: false; why: string };

/** For Settings > Sign-in: whether a pasted SharePoint sharing link plays here, and if not, why. */
export async function sharePointPlayerStatus(): Promise<PlayerStatus | null> {
  const c = await microsoftConfig();
  if (!c) return null;
  const token = await currentToken(c, true);
  if ('error' in token) return { plays: false, why: `Microsoft gave Cadence no token: ${token.error}` };
  if (!mayReadFiles(token.roles)) return { plays: false, why: 'The app needs the Files.Read.All application permission' };
  const refused = await standingRefusal(token.roles);
  return refused === null ? { plays: true } : { plays: false, why: `Microsoft refused: ${refused}` };
}

/**
 * Meetings saved with a sharing link before Microsoft let Cadence look, given their player. Null
 * while Microsoft still does not let it, so the worker asks again later.
 */
export async function backfillSharePointPlayers(): Promise<number | null> {
  const c = await microsoftConfig();
  if (!c) return null;
  const token = await currentToken(c);
  if ('error' in token || !mayReadFiles(token.roles) || (await standingRefusal(token.roles)) !== null) return null;
  const meetings = await prisma.meeting.findMany({ where: { provider: 'SHAREPOINT', mediaUrl: null, sourceUrl: { contains: '.sharepoint.com', mode: 'insensitive' } }, select: { id: true, sourceUrl: true, embedUrl: true } });
  let played = 0;
  for (const m of meetings) {
    // No player yet, or one an earlier build framed that SharePoint refuses: the sharing link itself.
    if (!needsPlayer(m.sourceUrl) || (m.embedUrl && parseMeetingLink(m.embedUrl).embedUrl)) continue;
    const answer = await playerFromGraph(m.sourceUrl.trim(), token.value);
    await noteAnswer(answer, token.roles);
    if (answer && 'refused' in answer) return null;
    // Only where nobody changed the meeting's link meanwhile.
    if (answer) played += (await prisma.meeting.updateMany({ where: { id: m.id, sourceUrl: m.sourceUrl, embedUrl: m.embedUrl }, data: { embedUrl: answer.embedUrl } })).count;
  }
  return played;
}
