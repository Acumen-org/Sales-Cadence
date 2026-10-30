import { prisma } from '../db';
import { env } from '../env';
import { microsoftConfig } from '../auth/microsoft';
import { currentToken, needsPlayer, noteFor, sharePointRecording, standingRefusal, type AppToken, type RecordingFile } from './sharepoint-player';
import { detectTranscriptFormat } from './transcript';
import { pushMeetingToCrm } from './crm';

/**
 * A Teams recording's transcript, fetched from Microsoft instead of downloaded and pasted (owner,
 * 29 October 2026).
 *
 * Teams keeps the transcript with the meeting, not with the recording's file, so the file only says
 * where to look: whose OneDrive it sits in (Teams saves a recording to the organizer's) and when it
 * was made. Graph lists that organizer's transcripts around that time, and the one that started and
 * ended with the recording is the meeting's. Its WebVTT has the speakers, which the meeting page
 * already reads.
 *
 * Microsoft asks for three things before it answers, all on the same app registration the sign-in
 * uses: the OnlineMeetingTranscript.Read.All application permission, a Teams application access
 * policy for the app, and "Microsoft Graph access" to transcripts turned on in the Teams admin
 * center. Until then Cadence asks nothing; Settings > Sign-in says which is missing.
 */

const TRANSCRIPT_ROLE = 'OnlineMeetingTranscript.Read.All';
const REFUSED = 'teamsTranscriptRefused';
const TIMEOUT_MS = 10_000;
/** How far a transcript's start and end may sit from the recording's, together. */
const MATCH_WINDOW_MS = 90 * 60_000;
const HOUR = 3_600_000;

const graphUrl = () => env().MICROSOFT_GRAPH_URL.replace(/\/+$/, '');
export const mayReadTranscripts = (roles: string[]) => roles.includes(TRANSCRIPT_ROLE);

type Answer = { text: string } | { refused: string } | null;
type GraphError = { error?: { code?: unknown; message?: unknown; innerError?: { code?: unknown } } };

/** Microsoft's reason, in the words an admin acts on. */
export function refusalText(body: GraphError, status: number): string {
  const inner = String(body.error?.innerError?.code ?? '');
  const message = String(body.error?.message ?? status).split(/\r?\n/)[0];
  if (inner === 'GraphAccessToTranscriptsDisabled') return 'Microsoft Graph access to transcripts is off in the Teams admin center';
  if (/application access policy/i.test(message)) return 'No Teams application access policy lets the app read meetings';
  return message;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function getJson(url: string, token: string, fetchImpl: typeof fetch): Promise<{ status: number; body: Record<string, unknown> } | null> {
  try {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Whose OneDrive the recording sits in: the meeting's organizer, as Teams saves it. */
export async function driveOwner(driveId: string, token: string, fetchImpl: typeof fetch = fetch, base = graphUrl()): Promise<string | null> {
  const answer = await getJson(`${base}/v1.0/drives/${encodeURIComponent(driveId)}?$select=owner`, token, fetchImpl);
  const owner = (answer?.body.owner as { user?: { id?: unknown } } | undefined)?.user?.id;
  return answer?.status === 200 && typeof owner === 'string' ? owner : null;
}

type Listed = { createdDateTime?: unknown; endDateTime?: unknown; transcriptContentUrl?: unknown };

/** The transcript that started and ended with the recording, among one organizer's. */
export function closestTranscript(list: Listed[], file: RecordingFile): string | null {
  const end = new Date(file.createdAt).getTime();
  const start = end - (file.durationMs ?? 0);
  let best: { url: string; gap: number } | null = null;
  for (const t of list) {
    const from = new Date(String(t.createdDateTime ?? '')).getTime();
    const to = new Date(String(t.endDateTime ?? t.createdDateTime ?? '')).getTime();
    if (typeof t.transcriptContentUrl !== 'string' || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    const gap = Math.abs(from - start) + Math.abs(to - end);
    if (gap <= MATCH_WINDOW_MS && (!best || gap < best.gap)) best = { url: t.transcriptContentUrl, gap };
  }
  return best?.url ?? null;
}

/** The transcript's text: WebVTT with speakers, or without them when the tenant withholds names. */
async function transcriptContent(url: string, token: string, fetchImpl: typeof fetch): Promise<Answer> {
  for (const accept of ['text/vtt', 'application/vnd.microsoft.graph.transcript+text']) {
    let res: Response;
    try { res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept }, signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch { return null; }
    if (res.ok) {
      const text = (await res.text()).trim();
      return text ? { text } : null;
    }
    const body = (await res.json().catch(() => ({}))) as GraphError;
    if (res.status === 403 && String(body.error?.innerError?.code ?? '') === 'SpeakerAttributionNotAllowed') continue;
    return res.status === 401 || res.status === 403 ? { refused: refusalText(body, res.status) } : null;
  }
  return null;
}

/**
 * The meeting's transcript, for a recording file: asked of its OneDrive's owner first, then of
 * anyone else who may have organized it (the team on the call).
 */
export async function transcriptForFile(file: RecordingFile, organizers: string[], token: string, fetchImpl: typeof fetch = fetch, base = graphUrl()): Promise<Answer> {
  const owner = await driveOwner(file.driveId, token, fetchImpl, base);
  const ids = [...new Set([owner, ...organizers].filter((id): id is string => Boolean(id)))];
  const end = new Date(file.createdAt).getTime();
  if (!Number.isFinite(end)) return null;
  const from = iso(end - (file.durationMs ?? 0) - 2 * HOUR);
  const to = iso(end + 2 * HOUR);
  for (const id of ids) {
    const user = encodeURIComponent(id);
    const listed = await getJson(`${base}/v1.0/users/${user}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='${user}',startDateTime=${from},endDateTime=${to})`, token, fetchImpl);
    if (!listed) continue;
    if (listed.status === 401 || listed.status === 403) return { refused: refusalText(listed.body as GraphError, listed.status) };
    if (listed.status !== 200) continue;
    const url = closestTranscript((listed.body.value as Listed[] | undefined) ?? [], file);
    if (url) return transcriptContent(url, token, fetchImpl);
  }
  return null;
}

/** May Cadence ask Microsoft for transcripts now: the permission granted, and no refusal standing. */
async function transcriptToken(): Promise<AppToken | null> {
  const c = await microsoftConfig();
  if (!c) return null;
  const token = await currentToken(c);
  if ('error' in token || !mayReadTranscripts(token.roles) || (await standingRefusal(token.roles, REFUSED)) !== null) return null;
  return token;
}

/** The Microsoft object ids of team members, for asking whose meeting it was. */
async function organizerIds(userIds: string[]): Promise<string[]> {
  if (!userIds.length) return [];
  const users = await prisma.user.findMany({ where: { id: { in: userIds }, microsoftId: { not: null } }, select: { microsoftId: true } });
  return users.map((u) => u.microsoftId!);
}

/**
 * The transcript of the recording behind a pasted SharePoint link, or null. `teamUserIds` are the
 * people who may have organized the meeting, asked after the recording's own OneDrive owner.
 */
export async function teamsTranscript(raw: string, teamUserIds: string[] = []): Promise<string | null> {
  if (!needsPlayer(raw) || !(await transcriptToken())) return null;
  const found = await sharePointRecording(raw);
  return transcriptForRecording(found?.recording.file ?? null, teamUserIds);
}

/** The transcript for a recording already looked up (the link was read for its player too). */
export async function transcriptForRecording(file: RecordingFile | null, teamUserIds: string[] = []): Promise<string | null> {
  if (!file) return null;
  const token = await transcriptToken();
  if (!token) return null;
  const answer = await transcriptForFile(file, await organizerIds(teamUserIds), token.value);
  await noteFor(REFUSED, answer, token.roles);
  return answer && 'text' in answer ? answer.text : null;
}

export type TranscriptStatus = { fetches: true } | { fetches: false; why: string };

/** For Settings > Sign-in: whether Teams transcripts arrive on their own, and if not, why. */
export async function teamsTranscriptStatus(): Promise<TranscriptStatus | null> {
  const c = await microsoftConfig();
  if (!c) return null;
  const token = await currentToken(c, true);
  if ('error' in token) return { fetches: false, why: `Microsoft gave Cadence no token: ${token.error}` };
  if (!mayReadTranscripts(token.roles)) return { fetches: false, why: 'The app needs the OnlineMeetingTranscript.Read.All application permission' };
  const refused = await standingRefusal(token.roles, REFUSED);
  return refused === null ? { fetches: true } : { fetches: false, why: `Microsoft refused: ${refused}` };
}

/** Fetch one saved meeting's transcript, when it has none yet. True when one arrived. */
export async function fetchMeetingTranscript(meetingId: string): Promise<boolean> {
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { id: true, sourceUrl: true, transcript: true, bookedById: true, attendees: { where: { userId: { not: null } }, select: { userId: true } } } });
  if (!meeting || meeting.transcript || !needsPlayer(meeting.sourceUrl)) return false;
  const team = [...new Set([meeting.bookedById, ...meeting.attendees.map((a) => a.userId)].filter((id): id is string => Boolean(id)))];
  const text = await teamsTranscript(meeting.sourceUrl, team);
  await prisma.meeting.update({ where: { id: meetingId }, data: { transcriptTriedAt: new Date() } });
  if (!text) return false;
  // Only into a meeting that still has none: a transcript someone pasted meanwhile stays.
  const { count } = await prisma.meeting.updateMany({ where: { id: meetingId, transcript: null, sourceUrl: meeting.sourceUrl }, data: { transcript: text, transcriptFormat: detectTranscriptFormat(text) } });
  return count > 0;
}

/**
 * The worker's hourly pass: recent meetings with a SharePoint recording and no transcript yet,
 * each asked again at most every six hours (Teams can take a while to finish one). Null while
 * Microsoft does not let Cadence ask.
 */
export async function backfillTeamsTranscripts(now = new Date()): Promise<number | null> {
  if (!(await transcriptToken())) return null;
  const meetings = await prisma.meeting.findMany({
    where: {
      review: 'APPROVED', provider: 'SHAREPOINT', transcript: null,
      sourceUrl: { contains: '.sharepoint.com', mode: 'insensitive' },
      occurredAt: { gte: new Date(now.getTime() - 90 * 24 * HOUR) },
      OR: [{ transcriptTriedAt: null }, { transcriptTriedAt: { lt: new Date(now.getTime() - 6 * HOUR) } }],
    },
    orderBy: { occurredAt: 'desc' }, take: 25, select: { id: true },
  });
  let found = 0;
  for (const m of meetings) {
    if (!(await fetchMeetingTranscript(m.id))) continue;
    found++;
    // Twenty keeps the transcript too.
    await pushMeetingToCrm(m.id);
  }
  return found;
}
