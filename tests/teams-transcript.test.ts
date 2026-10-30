import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { getSettings, saveSettingsSection } from '@/lib/settings';
import { closestTranscript, fetchMeetingTranscript, refusalText, teamsTranscriptStatus, transcriptForFile } from '@/lib/meetings/teams-transcript';

/**
 * A Teams recording's transcript comes from Microsoft (29 October 2026): the recording's file says
 * whose OneDrive it sits in and when it was made, and the organizer's transcript that started and
 * ended with it is the meeting's.
 */
const SHARING = 'https://glynac-my.sharepoint.com/:v:/g/personal/alisa_acumen-strategy_com/EYx1abc?e=Zt9q';
const SITE = 'https://glynac-my.sharepoint.com/personal/alisa_acumen-strategy_com';
const UNIQUE = '88a4d11b-3f06-4bff-a726-8576be121d20';
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Alisa Senior>Thanks for joining.\n';
const FILE = { driveId: 'b!drive', createdAt: '2026-08-11T15:31:00Z', durationMs: 30 * 60_000 };
const item = { name: 'Alisa and Lloyd-20260811_150100-Meeting Recording.mp4', file: { mimeType: 'video/mp4' }, sharepointIds: { siteUrl: SITE, listItemUniqueId: UNIQUE }, createdDateTime: FILE.createdAt, video: { duration: FILE.durationMs }, parentReference: { driveId: FILE.driveId } };
const listed = (from: string, to: string, id: string) => ({ createdDateTime: from, endDateTime: to, transcriptContentUrl: `https://graph.example/v1.0/users/owner-1/onlineMeetings/m/transcripts/${id}/content` });
const accessToken = (roles: string[]) => `h.${Buffer.from(JSON.stringify({ roles })).toString('base64url')}.s`;

type Reply = { status?: number; body: unknown; text?: string };
/** Microsoft played here: each request answered by the first route whose key its URL contains. */
function microsoft(routes: Record<string, Reply | ((init?: RequestInit) => Reply)>) {
  const asked: { url: string; accept: string | null }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, accept: new Headers(init?.headers).get('accept') });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('{}', { status: 404 });
    const route = routes[key];
    const r = typeof route === 'function' ? route(init) : route;
    return new Response(r.text ?? JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, asked };
}

describe('finding the transcript that goes with a recording', () => {
  it('takes the one that started and ended with the recording, and none that is far off', () => {
    const list = [
      listed('2026-08-11T13:00:00Z', '2026-08-11T13:30:00Z', 'earlier-call'),
      listed('2026-08-11T15:01:30Z', '2026-08-11T15:30:40Z', 'this-call'),
      listed('2026-08-11T15:45:00Z', '2026-08-11T16:20:00Z', 'next-call'),
    ];
    expect(closestTranscript(list, FILE)).toContain('/this-call/');
    expect(closestTranscript([list[0]], FILE)).toBeNull();
  });

  it('says what an admin has to change when Microsoft refuses', () => {
    expect(refusalText({ error: { message: 'Forbidden', innerError: { code: 'GraphAccessToTranscriptsDisabled' } } }, 403)).toBe('Microsoft Graph access to transcripts is off in the Teams admin center');
    expect(refusalText({ error: { message: 'No application access policy found for this app.' } }, 403)).toBe('No Teams application access policy lets the app read meetings');
    expect(refusalText({ error: { message: 'Something else\nTrace' } }, 403)).toBe('Something else');
  });

  it("asks the OneDrive's owner for their transcripts around the recording, and reads it without speakers when names are withheld", async () => {
    const ms = microsoft({
      '/drives/': { body: { owner: { user: { id: 'owner-1' } } } },
      'getAllTranscripts': { body: { value: [listed('2026-08-11T15:01:30Z', '2026-08-11T15:30:40Z', 'this-call')] } },
      '/this-call/content': (init) => new Headers(init?.headers).get('accept') === 'text/vtt'
        ? { status: 403, body: { error: { message: 'No speakers', innerError: { code: 'SpeakerAttributionNotAllowed' } } } }
        : { body: null, text: '0:00:01 Thanks for joining.' },
    });
    expect(await transcriptForFile(FILE, [], 'tok', ms.impl, 'https://graph.example')).toEqual({ text: '0:00:01 Thanks for joining.' });
    const list = ms.asked.find((a) => a.url.includes('getAllTranscripts'))!.url;
    expect(list).toBe("https://graph.example/v1.0/users/owner-1/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='owner-1',startDateTime=2026-08-11T13:01:00Z,endDateTime=2026-08-11T17:31:00Z)");
    expect(ms.asked.filter((a) => a.url.includes('/content')).map((a) => a.accept)).toEqual(['text/vtt', 'application/vnd.microsoft.graph.transcript+text']);
  });

  it('asks the team on the call when the owner organized nothing then', async () => {
    const ms = microsoft({
      '/drives/': { body: { owner: { user: { id: 'owner-1' } } } },
      "users/owner-1/onlineMeetings/getAllTranscripts": { body: { value: [] } },
      "users/team-9/onlineMeetings/getAllTranscripts": { body: { value: [listed('2026-08-11T15:01:30Z', '2026-08-11T15:30:40Z', 'this-call')] } },
      '/this-call/content': { body: null, text: VTT },
    });
    expect(await transcriptForFile(FILE, ['team-9'], 'tok', ms.impl, 'https://graph.example')).toEqual({ text: VTT.trim() });
  });
});

describe('a saved meeting gets its Teams transcript once Microsoft allows it', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    const { signIn } = await getSettings();
    await saveSettingsSection('signIn', { ...signIn, microsoftClientId: '11111111-1111-4111-8111-111111111111', microsoftTenantId: '22222222-2222-4222-8222-222222222222', microsoftClientSecret: `secret-${Math.random()}` });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const meeting = () => prisma.meeting.create({ data: { title: 'Alisa and Lloyd', provider: 'SHAREPOINT', sourceUrl: SHARING, occurredAt: new Date('2026-08-11T17:00:00Z'), bookedById: b.users.alisa.id } });
  const graph = (roles: string[], extra: Record<string, Reply> = {}) => microsoft({
    '/oauth2/v2.0/token': { body: { access_token: accessToken(roles) } },
    '/v1.0/shares/': { body: item },
    '/drives/': { body: { owner: { user: { id: 'owner-1' } } } },
    'getAllTranscripts': { body: { value: [listed('2026-08-11T15:01:30Z', '2026-08-11T15:30:40Z', 'this-call')] } },
    '/this-call/content': { body: null, text: VTT },
    ...extra,
  });

  it('asks nothing while the app lacks the permission, and Settings says which one', async () => {
    const ms = graph(['Files.Read.All']);
    vi.stubGlobal('fetch', ms.impl);
    const m = await meeting();
    expect(await fetchMeetingTranscript(m.id)).toBe(false);
    expect(ms.asked.some((a) => a.url.includes('getAllTranscripts'))).toBe(false);
    expect(await teamsTranscriptStatus()).toEqual({ fetches: false, why: 'The app needs the OnlineMeetingTranscript.Read.All application permission' });
  });

  it('stores the transcript, and shows a refusal in Settings until the app is granted something else', async () => {
    vi.stubGlobal('fetch', graph(['Files.Read.All', 'OnlineMeetingTranscript.Read.All']).impl);
    const m = await meeting();
    expect(await fetchMeetingTranscript(m.id)).toBe(true);
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ transcript: VTT.trim(), transcriptFormat: 'vtt' });
    expect(await teamsTranscriptStatus()).toEqual({ fetches: true });

    vi.stubGlobal('fetch', graph(['Files.Read.All', 'OnlineMeetingTranscript.Read.All'], { getAllTranscripts: { status: 403, body: { error: { message: 'Forbidden', innerError: { code: 'GraphAccessToTranscriptsDisabled' } } } } }).impl);
    const other = await prisma.meeting.create({ data: { title: 'Another', provider: 'SHAREPOINT', sourceUrl: `${SHARING}&x=2`, occurredAt: new Date('2026-08-12T17:00:00Z'), bookedById: b.users.alisa.id } });
    expect(await fetchMeetingTranscript(other.id)).toBe(false);
    expect(await teamsTranscriptStatus()).toEqual({ fetches: false, why: 'Microsoft refused: Microsoft Graph access to transcripts is off in the Teams admin center' });
  });

  it('never replaces a transcript someone already added', async () => {
    vi.stubGlobal('fetch', graph(['Files.Read.All', 'OnlineMeetingTranscript.Read.All']).impl);
    const m = await meeting();
    await prisma.meeting.update({ where: { id: m.id }, data: { transcript: 'Pasted by hand' } });
    expect(await fetchMeetingTranscript(m.id)).toBe(false);
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).transcript).toBe('Pasted by hand');
  });
});
