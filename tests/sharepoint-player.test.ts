import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { getSettings, saveSettingsSection } from '@/lib/settings';
import { appToken, backfillSharePointPlayers, encodeSharingUrl, fileMeeting, playerFromGraph, recordingFromGraph, recordingName, sharePointPlayer, sharePointPlayerStatus } from '@/lib/meetings/sharepoint-player';

/**
 * A Teams recording's SharePoint sharing link plays in Cadence (29 October 2026): Microsoft Graph
 * names the file behind the link, and SharePoint's own embed player is built from its site and id,
 * the same link Share > Embed gives. Nothing is asked until the app holds a file permission.
 */
const SHARING = 'https://glynac-my.sharepoint.com/:v:/g/personal/alisa_acumen-strategy_com/EYx1abc?e=Zt9q';
const SITE = 'https://glynac-my.sharepoint.com/personal/alisa_acumen-strategy_com';
const UNIQUE = '88a4d11b-3f06-4bff-a726-8576be121d20';
const PLAYER = `${SITE}/_layouts/15/embed.aspx?UniqueId=${UNIQUE}`;
const accessToken = (roles: string[]) => `header.${Buffer.from(JSON.stringify({ roles })).toString('base64url')}.signature`;
const recording = { name: 'Alisa and Lloyd-20260811_143012-Meeting Recording.mp4', file: { mimeType: 'video/mp4' }, sharepointIds: { siteUrl: SITE, listItemUniqueId: UNIQUE } };

type Route = { status?: number; body: unknown };
/** Microsoft played here: the token endpoint and Graph, answering what each test says. */
function microsoft(routes: { token?: Route; graph?: Route }) {
  const asked: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const route = url.includes('/oauth2/v2.0/token') ? routes.token : url.includes('/v1.0/shares/') ? routes.graph : undefined;
    if (!route) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, asked };
}

describe('asking Graph about a sharing link', () => {
  it('encodes the link the way Graph reads it', () => {
    expect(encodeSharingUrl('https://contoso.example.com/shared')).toBe('u!aHR0cHM6Ly9jb250b3NvLmV4YW1wbGUuY29tL3NoYXJlZA');
  });

  it('reads the permissions Microsoft granted from the token, and says why when there is none', async () => {
    const app = { clientId: 'c', tenantId: 't', clientSecret: 's', loginUrl: 'https://login.example' };
    expect(await appToken(app, microsoft({ token: { body: { access_token: accessToken(['Files.Read.All']) } } }).impl)).toEqual({ value: accessToken(['Files.Read.All']), roles: ['Files.Read.All'] });
    expect(await appToken(app, microsoft({ token: { status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: 1' } } }).impl)).toEqual({ error: 'AADSTS7000215: Invalid client secret provided.' });
  });

  it("builds SharePoint's own player from the file's site and id", async () => {
    const ms = microsoft({ graph: { body: recording } });
    expect(await playerFromGraph(SHARING, 'tok', ms.impl, 'https://graph.example')).toEqual({ embedUrl: PLAYER, title: 'Alisa and Lloyd', date: '2026-08-11' });
    expect(ms.asked[0]).toBe(`https://graph.example/v1.0/shares/${encodeSharingUrl(SHARING)}/driveItem?$select=name,file,sharepointIds,createdDateTime,video,parentReference`);
  });

  it('frames nothing that is not a recording or not on SharePoint, and tells a refusal apart', async () => {
    const answer = async (route: Route) => playerFromGraph(SHARING, 'tok', microsoft({ graph: route }).impl, 'https://graph.example');
    expect(await answer({ body: { ...recording, name: 'Proposal.docx', file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } } })).toBeNull();
    expect(await answer({ body: { ...recording, sharepointIds: { siteUrl: 'https://evil.example/site', listItemUniqueId: UNIQUE } } })).toBeNull();
    expect(await answer({ body: { ...recording, sharepointIds: { siteUrl: SITE, listItemUniqueId: 'not-an-id' } } })).toBeNull();
    expect(await answer({ status: 404, body: { error: { code: 'itemNotFound', message: 'The sharing link no longer exists' } } })).toBeNull();
    expect(await answer({ status: 403, body: { error: { code: 'accessDenied', message: 'Either scp or roles claim need to be present in the token.' } } })).toEqual({ refused: 'Either scp or roles claim need to be present in the token.' });
  });

  it('says where the file sits and when it was made, for its transcript', async () => {
    const withFile = { ...recording, createdDateTime: '2026-08-11T15:31:00Z', video: { duration: 1_800_000 }, parentReference: { driveId: 'b!drive' } };
    expect(await recordingFromGraph(SHARING, 'tok', microsoft({ graph: { body: withFile } }).impl, 'https://graph.example')).toMatchObject({ embedUrl: PLAYER, file: { driveId: 'b!drive', createdAt: '2026-08-11T15:31:00Z', durationMs: 1_800_000 } });
  });

  it('titles any other recording after its file, dated when the file was made', () => {
    expect(fileMeeting('Acubooth demo with Lloyd.mp4', '2026-10-28T16:00:00Z')).toEqual({ title: 'Acubooth demo with Lloyd', date: '2026-10-28' });
    expect(fileMeeting('Recording 3.mp4', '2026-10-28T16:00:00Z')).toEqual({ title: null, date: '2026-10-28' });
    expect(fileMeeting('Alisa and Lloyd-20260811_143012-Meeting Recording.mp4', '2026-10-28T16:00:00Z')).toEqual({ title: 'Alisa and Lloyd', date: '2026-08-11' });
  });

  it("takes the meeting and its day from a Teams recording's file name, and nothing from another", () => {
    expect(recordingName('Alisa and Lloyd-20260811 Meeting Recording.mp4')).toEqual({ title: 'Alisa and Lloyd', date: '2026-08-11' });
    expect(recordingName('Acubooth - Discovery-20260912_090501-Meeting Recording.mp4')).toEqual({ title: 'Acubooth - Discovery', date: '2026-09-12' });
    expect(recordingName('screen capture.mp4')).toEqual({ title: null, date: null });
    expect(recordingName('Weekly-20261399_101010-Meeting Recording.mp4')).toEqual({ title: null, date: null });
  });
});

describe('a sharing link plays once Microsoft lets Cadence look', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    const { signIn } = await getSettings();
    // Each test names its own secret, so no token is carried over from the last one.
    await saveSettingsSection('signIn', { ...signIn, microsoftClientId: '11111111-1111-4111-8111-111111111111', microsoftTenantId: '22222222-2222-4222-8222-222222222222', microsoftClientSecret: `secret-${Math.random()}` });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks Graph nothing while the app has no file permission, and Settings says what it needs', async () => {
    const ms = microsoft({ token: { body: { access_token: accessToken([]) } }, graph: { body: recording } });
    vi.stubGlobal('fetch', ms.impl);
    expect(await sharePointPlayer(SHARING)).toBeNull();
    expect(ms.asked.some((u) => u.includes('/v1.0/shares/'))).toBe(false);
    expect(await sharePointPlayerStatus()).toEqual({ plays: false, why: 'The app needs the Files.Read.All application permission' });
  });

  it('plays with Files.Read.All; a refusal shows in Settings until the app is granted something else', async () => {
    vi.stubGlobal('fetch', microsoft({ token: { body: { access_token: accessToken(['Files.Read.All']) } }, graph: { body: recording } }).impl);
    expect(await sharePointPlayer(SHARING)).toEqual({ embedUrl: PLAYER, title: 'Alisa and Lloyd', date: '2026-08-11' });
    expect(await sharePointPlayer(PLAYER)).toBeNull();
    expect(await sharePointPlayer('https://teams.microsoft.com/l/meetup-join/abc')).toBeNull();
    expect(await sharePointPlayerStatus()).toEqual({ plays: true });

    vi.stubGlobal('fetch', microsoft({ token: { body: { access_token: accessToken(['Files.Read.All']) } }, graph: { status: 403, body: { error: { message: 'Access denied' } } } }).impl);
    expect(await sharePointPlayer(SHARING)).toBeNull();
    expect(await sharePointPlayerStatus()).toEqual({ plays: false, why: 'Microsoft refused: Access denied' });

    vi.stubGlobal('fetch', microsoft({ token: { body: { access_token: accessToken(['Files.ReadWrite.All']) } }, graph: { body: recording } }).impl);
    expect(await sharePointPlayerStatus()).toEqual({ plays: true });
  });

  it('gives meetings saved before then their player, once, and leaves the rest alone', async () => {
    const meeting = (sourceUrl: string, embedUrl: string | null = null) => prisma.meeting.create({ data: { title: 'Call', provider: 'SHAREPOINT', sourceUrl, embedUrl, occurredAt: new Date('2026-08-11T15:00:00Z'), bookedById: b.users.alisa.id } });
    const waiting = await meeting(SHARING);
    // An earlier build framed the sharing link itself, which SharePoint refuses.
    const framed = await meeting(`${SHARING}&x=1`, `${SHARING}&x=1`);
    const embedded = await meeting(PLAYER, PLAYER);

    vi.stubGlobal('fetch', microsoft({ token: { body: { access_token: accessToken([]) } }, graph: { body: recording } }).impl);
    expect(await backfillSharePointPlayers()).toBeNull();

    vi.stubGlobal('fetch', microsoft({ token: { body: { access_token: accessToken(['Sites.Read.All']) } }, graph: { body: recording } }).impl);
    await saveSettingsSection('signIn', { ...(await getSettings()).signIn, microsoftClientSecret: 'granted-now' });
    expect(await backfillSharePointPlayers()).toBe(2);
    const after = await prisma.meeting.findMany({ where: { id: { in: [waiting.id, framed.id, embedded.id] } }, select: { id: true, embedUrl: true } });
    expect(Object.fromEntries(after.map((m) => [m.id, m.embedUrl]))).toEqual({ [waiting.id]: PLAYER, [framed.id]: PLAYER, [embedded.id]: PLAYER });
    expect(await backfillSharePointPlayers()).toBe(0);
  });
});
