import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { getSettings, saveSettingsSection } from '@/lib/settings';
import { createMeetingAction, updateMeetingAction } from '@/lib/actions/meetings';
import { copyable, LIBRARY_KEY, libraryCounts, normaliseSiteUrl, queueExistingRecordings, runLibraryCopies, setLibrary, sourceCandidates } from '@/lib/meetings/library';
import { encodeSharingUrl, resetGraphThrottle } from '@/lib/meetings/sharepoint-player';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { withPeople } from './helpers/meeting-form';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (user: SessionUser) => user }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/meetings/crm', async (orig) => ({ ...(await orig<typeof import('@/lib/meetings/crm')>()), pushMeetingToCrm: vi.fn(async () => undefined) }));

/**
 * Teams recordings added to Cadence are copied into the company's Meeting Recordings library, where
 * everyone in the company can watch them and they do not expire (owner, 17-19 November 2026); and a
 * meeting's recording is mandatory unless it was not recorded or was held in person.
 */
const SHARING = 'https://glynac-my.sharepoint.com/:v:/g/personal/alisa_acumen-strategy_com/EYx1abc?e=Zt9q';
const SITE = 'https://glynac.sharepoint.com/sites/MeetingRecordings';
const UNIQUE = '88a4d11b-3f06-4bff-a726-8576be121d20';
const MONITOR = 'https://glynac.sharepoint.com/_api/v2.0/monitor/abc';
const accessToken = (roles: string[]) => `header.${Buffer.from(JSON.stringify({ roles })).toString('base64url')}.signature`;

type Call = { url: string; method: string; body: string | null; auth: string | null };
/** Microsoft played here. `fields` is what the copy's columns say, before and after a PATCH. */
function microsoft(opts: { roles?: string[]; source?: number; copy?: number; monitor?: unknown; fields?: Record<string, unknown>; patchClears?: boolean; put?: number } = {}) {
  const calls: Call[] = [];
  let fields = { ...(opts.fields ?? { Title: 'x' }) };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const h = new Headers(init?.headers);
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null, auth: h.get('authorization') });
    if (url.includes('/oauth2/v2.0/token')) return json({ access_token: accessToken(opts.roles ?? ['Files.Read.All', 'Sites.Selected']) });
    if (url.includes('/v1.0/sites/glynac.sharepoint.com:/sites/MeetingRecordings')) return json({ id: 'site-1' });
    if (url.includes('/v1.0/sites/site-1/drive/root')) return json({ id: 'root-1', parentReference: { driveId: 'lib-drive' } });
    if (url.includes('/v1.0/drives/lib-drive/root:/cadence-check-')) return json({ id: 'probe' }, opts.put ?? 201);
    if (url.includes('/v1.0/drives/lib-drive/items/probe')) return new Response(null, { status: 204 });
    if (url.includes('/v1.0/shares/')) return opts.source && opts.source >= 400 ? json({ error: { message: 'itemNotFound' } }, opts.source) : json({ id: 'src-item', name: 'Alisa and Lloyd-20260811_143012-Meeting Recording.mp4', file: { mimeType: 'video/mp4' }, parentReference: { driveId: 'onedrive-1' } });
    if (url.includes('/v1.0/drives/onedrive-1/items/src-item/copy')) return opts.copy ? json({ error: { message: 'Access denied' } }, opts.copy) : new Response(null, { status: 202, headers: { location: MONITOR } });
    if (url === MONITOR) return json(opts.monitor ?? { status: 'completed', resourceId: 'copy-1' });
    if (url.endsWith('/v1.0/drives/lib-drive/items/copy-1/listItem/fields')) {
      if (method === 'PATCH') { if (opts.patchClears !== false) fields = Object.fromEntries(Object.entries(fields).filter(([k]) => !/expir/i.test(k))); return json(fields); }
      return json(fields);
    }
    if (url.includes('/v1.0/drives/lib-drive/items/copy-1')) return json({ id: 'copy-1', webUrl: `${SITE}/Shared%20Documents/Alisa%20and%20Lloyd.mp4`, sharepointIds: { listItemUniqueId: UNIQUE } });
    return json({ error: { message: `unexpected ${method} ${url}` } }, 404);
  }) as typeof fetch;
  return { impl, calls };
}

let b: Basics;
const form = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ title: 'Kick-off', occurredAt: '2026-11-10', bookedById: b.users.karson.id, ...values })) fd.set(k, v);
  return withPeople(fd, b.users.alisa.id);
};
async function signedIn() {
  const { signIn } = await getSettings();
  await saveSettingsSection('signIn', { ...signIn, microsoftClientId: '11111111-1111-4111-8111-111111111111', microsoftTenantId: '22222222-2222-4222-8222-222222222222', microsoftClientSecret: `secret-${Math.random()}` });
}
async function meetingWithLink(title: string, sourceUrl = SHARING) {
  return prisma.meeting.create({ data: { title, sourceUrl, provider: 'SHAREPOINT', occurredAt: new Date('2026-11-10T15:00:00Z'), libraryStatus: 'PENDING' } });
}

beforeEach(async () => {
  await resetDb(); b = await seedBasics(); resetGraphThrottle();
  auth.user.mockResolvedValue({ ...b.users.ria, timezone: WORKSPACE_TIMEZONE, podIds: [], pods: [] });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the links Cadence copies', () => {
  it('copies OneDrive and SharePoint recordings only', () => {
    expect(copyable(SHARING)).toBe(true);
    expect(copyable('https://acumen.zoom.us/rec/share/abc')).toBe(false);
    expect(copyable('https://evil.example/x.sharepoint.com')).toBe(false);
    expect(copyable('')).toBe(false);
  });

  it('reads the library site from whatever page of it an admin pastes', () => {
    expect(normaliseSiteUrl('https://glynac.sharepoint.com/sites/MeetingRecordings/Shared%20Documents/Forms/AllItems.aspx')).toBe(SITE);
    expect(normaliseSiteUrl('https://glynac.sharepoint.com/')).toBeNull();
    expect(normaliseSiteUrl('https://evil.example/sites/x')).toBeNull();
  });

  it("finds the file behind a Stream page and SharePoint's embed player", () => {
    expect(sourceCandidates('https://glynac-my.sharepoint.com/personal/a_b_com/_layouts/15/stream.aspx?id=/personal/a_b_com/Documents/Recordings/Call.mp4')[0]).toBe('https://glynac-my.sharepoint.com/personal/a_b_com/Documents/Recordings/Call.mp4');
    const embed = sourceCandidates(`https://glynac-my.sharepoint.com/personal/a_b_com/_layouts/15/embed.aspx?UniqueId=${UNIQUE}&embed=%7B%7D`);
    expect(embed[0]).toBe(`https://glynac-my.sharepoint.com/personal/a_b_com/_layouts/15/Doc.aspx?sourcedoc=%7B${UNIQUE}%7D`);
    expect(embed).toHaveLength(3);
  });
});

describe('the recording on the meeting form', () => {
  it('is mandatory unless the meeting was not recorded or was in person', async () => {
    const none = form({ sourceUrl: '' }); none.delete('notRecorded');
    expect(await createMeetingAction(none)).toMatchObject({ ok: false, error: expect.stringContaining('Not recorded or in person') });
    expect(await createMeetingAction(form({ sourceUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc' }))).toMatchObject({ ok: false, error: expect.stringContaining('join the meeting') });
    // A link typed before the box was ticked is not kept.
    expect(await createMeetingAction(form({ sourceUrl: 'https://example.com/whatever', notRecorded: 'on' }))).toMatchObject({ ok: true });
    expect(await prisma.meeting.findFirstOrThrow({ where: { title: 'Kick-off' } })).toMatchObject({ notRecorded: true, sourceUrl: '', libraryStatus: null });
  });

  it('queues a OneDrive recording for the library, and starts over only when the link changes', async () => {
    expect(await createMeetingAction(form({ sourceUrl: SHARING }))).toMatchObject({ ok: true });
    const m = await prisma.meeting.findFirstOrThrow({ where: { title: 'Kick-off' } });
    expect(m).toMatchObject({ libraryStatus: 'PENDING', notRecorded: false });
    await prisma.meeting.update({ where: { id: m.id }, data: { libraryStatus: 'DONE', libraryUrl: `${SITE}/x.mp4`, libraryEmbedUrl: 'https://p' } });
    expect(await updateMeetingAction(form({ meetingId: m.id, sourceUrl: SHARING, title: 'Kick-off call' }))).toMatchObject({ ok: true });
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ libraryStatus: 'DONE', libraryUrl: `${SITE}/x.mp4` });
    expect(await updateMeetingAction(form({ meetingId: m.id, sourceUrl: 'https://acumen.zoom.us/rec/share/abc', title: 'Kick-off call' }))).toMatchObject({ ok: true });
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ libraryStatus: null, libraryUrl: null, libraryEmbedUrl: null });
  });
});

describe('copying into the library', () => {
  beforeEach(signedIn);

  it('saves the library only once Cadence finds it and can write to it', async () => {
    let ms = microsoft({ roles: ['Files.Read.All'] });
    vi.stubGlobal('fetch', ms.impl);
    expect((await setLibrary(SITE, ms.impl)).check).toMatchObject({ ok: false, why: expect.stringContaining('Sites.Selected') });
    await saveSettingsSection('signIn', { ...(await getSettings()).signIn, microsoftClientSecret: 'granted-now' });
    ms = microsoft({ put: 403 });
    vi.stubGlobal('fetch', ms.impl);
    expect((await setLibrary(SITE, ms.impl)).check).toMatchObject({ ok: false, why: expect.stringContaining('cannot save files') });
    ms = microsoft();
    vi.stubGlobal('fetch', ms.impl);
    expect(await setLibrary(SITE, ms.impl)).toMatchObject({ siteUrl: SITE, siteId: 'site-1', driveId: 'lib-drive', rootId: 'root-1', check: { ok: true } });
    // The check file is taken out again.
    expect(ms.calls.some((c) => c.method === 'DELETE' && c.url.includes('/items/probe'))).toBe(true);
  });

  it('copies the recording with Graph, clears its expiry date, and plays the copy', async () => {
    const ms = microsoft({ fields: { Title: 'x', _ExpirationDate: '2027-03-01T00:00:00Z' } });
    vi.stubGlobal('fetch', ms.impl);
    await setLibrary(SITE, ms.impl);
    const m = await meetingWithLink('Kick-off');
    expect(await runLibraryCopies(Date.now(), ms.impl)).toEqual({ started: 1, copied: 0, failed: 0 });
    const copy = ms.calls.find((c) => c.url.includes('/copy?'))!;
    expect(copy.url).toBe('https://graph.microsoft.com/v1.0/drives/onedrive-1/items/src-item/copy?@microsoft.graph.conflictBehavior=rename');
    expect(JSON.parse(copy.body!)).toEqual({ parentReference: { driveId: 'lib-drive', id: 'root-1' }, name: 'Alisa and Lloyd-20260811_143012-Meeting Recording.mp4' });
    expect(ms.calls.find((c) => c.url.includes('/v1.0/shares/'))!.url).toContain(encodeSharingUrl(SHARING));
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ libraryStatus: 'COPYING', libraryMonitorUrl: MONITOR, libraryTries: 1 });

    expect(await runLibraryCopies(Date.now(), ms.impl)).toEqual({ started: 0, copied: 1, failed: 0 });
    // The monitor address carries its own access: Cadence's token never goes to it.
    expect(ms.calls.find((c) => c.url === MONITOR)!.auth).toBeNull();
    expect(ms.calls.find((c) => c.method === 'PATCH')!.body).toBe(JSON.stringify({ _ExpirationDate: null }));
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({
      libraryStatus: 'DONE', libraryItemId: 'copy-1', sourceUrl: SHARING,
      libraryUrl: `${SITE}/Shared%20Documents/Alisa%20and%20Lloyd.mp4`,
      libraryEmbedUrl: `${SITE}/_layouts/15/embed.aspx?UniqueId=${UNIQUE}`,
    });
    expect(await prisma.auditLog.count({ where: { entityId: m.id, action: 'recording_copied' } })).toBe(1);
    expect(await libraryCounts()).toMatchObject({ done: 1, waiting: 0, failed: [] });
  });

  it('does not call a copy done while its expiry date stays, and does not copy it twice', async () => {
    const ms = microsoft({ fields: { _ExpirationDate: '2027-03-01T00:00:00Z' }, patchClears: false });
    vi.stubGlobal('fetch', ms.impl);
    await setLibrary(SITE, ms.impl);
    const m = await meetingWithLink('Kick-off');
    await runLibraryCopies(Date.now(), ms.impl);
    await runLibraryCopies(Date.now(), ms.impl);
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ libraryStatus: 'PENDING', libraryItemId: 'copy-1', libraryError: expect.stringContaining('expiry date') });
    // The retry checks the copy it has: no second copy.
    await prisma.meeting.update({ where: { id: m.id }, data: { libraryNextAt: null } });
    await runLibraryCopies(Date.now(), ms.impl);
    expect(ms.calls.filter((c) => c.url.includes('/copy?')).length).toBe(1);
  });

  it('gives up on a recording that is gone, and says why', async () => {
    const ms = microsoft({ source: 404 });
    vi.stubGlobal('fetch', ms.impl);
    await setLibrary(SITE, ms.impl);
    const m = await meetingWithLink('Old call');
    expect(await runLibraryCopies(Date.now(), ms.impl)).toMatchObject({ failed: 1 });
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ libraryStatus: 'FAILED', libraryError: expect.stringContaining('no longer in OneDrive') });
    // An embed code that cannot be followed says to paste the sharing link instead.
    const e = await meetingWithLink('Embedded', `https://glynac-my.sharepoint.com/personal/a_b_com/_layouts/15/embed.aspx?UniqueId=${UNIQUE}`);
    await runLibraryCopies(Date.now(), ms.impl);
    expect(await prisma.meeting.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ libraryStatus: 'FAILED', libraryError: expect.stringContaining('sharing link') });
  });

  it('tries a refused copy again later, and queues the recordings already in Cadence', async () => {
    const ms = microsoft({ copy: 403 });
    vi.stubGlobal('fetch', ms.impl);
    await setLibrary(SITE, ms.impl);
    const m = await meetingWithLink('Kick-off');
    await runLibraryCopies(Date.now(), ms.impl);
    const after = await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(after).toMatchObject({ libraryStatus: 'PENDING', libraryTries: 1, libraryError: expect.stringContaining('Access denied') });
    expect(after.libraryNextAt!.getTime()).toBeGreaterThan(Date.now());

    await prisma.meeting.create({ data: { title: 'Older', sourceUrl: SHARING, provider: 'SHAREPOINT', occurredAt: new Date('2026-09-01T15:00:00Z') } });
    await prisma.meeting.create({ data: { title: 'Zoom', sourceUrl: 'https://acumen.zoom.us/rec/share/abc', provider: 'ZOOM', occurredAt: new Date('2026-09-01T15:00:00Z') } });
    expect(await queueExistingRecordings()).toBe(1);
    expect(await prisma.meeting.findFirstOrThrow({ where: { title: 'Older' } })).toMatchObject({ libraryStatus: 'PENDING' });
  });

  it('does nothing until the library is set', async () => {
    await prisma.setting.deleteMany({ where: { key: LIBRARY_KEY } });
    const ms = microsoft();
    vi.stubGlobal('fetch', ms.impl);
    await meetingWithLink('Kick-off');
    expect(await runLibraryCopies(Date.now(), ms.impl)).toBeNull();
    expect(ms.calls).toEqual([]);
  });
});
