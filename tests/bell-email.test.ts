import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { invalidateSettingsCache, saveSettingsSection, DEFAULT_SETTINGS } from '@/lib/settings';
import { digestDue, inWorkHours, runBellEmail } from '@/lib/bell-email/run';
import { escapeHtml, renderBellEmail } from '@/lib/bell-email/template';
import { fakeOutbox } from '@/lib/bell-email/send';
import { saveEmailSettingsAction } from '@/lib/actions/settings';
import { saveEmailTimezoneAction } from '@/lib/actions/bell-email';
import { dayFigures, dayHasNews } from '@/lib/bell-email/day';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.user, requireAdmin: auth.user, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * The bell by email (owner, 21 Nov 2026): each person gets only what is in their own bell. What needs
 * action comes within minutes in work hours unless it was read; the rest in a weekday morning summary.
 * The seeded team works in London, so the clock below is London's (GMT in November).
 */
const TUE_10AM = new Date('2026-11-24T10:00:00Z');
const WED_8AM = new Date('2026-11-25T08:05:00Z');
const SAT_9AM = new Date('2026-11-28T09:00:00Z');
const mins = (at: Date, m: number) => new Date(at.getTime() - m * 60_000);

describe('the bell by email', () => {
  let b: Basics;
  const ring = (userId: string, kind: string, createdAt: Date, payload: Record<string, unknown> = {}) => prisma.notification.create({ data: { userId, kind, createdAt, payload: { title: 'Intro call', meetingId: 'm-1', day: '2026-11-20', bookedBy: 'Karson Reed', ...payload } } });
  const on = (extra: Partial<typeof DEFAULT_SETTINGS.email> = {}) => saveSettingsSection('email', { ...DEFAULT_SETTINGS.email, enabled: true, senderMailbox: 'cadence@acumen.example', ...extra });

  beforeEach(async () => {
    await resetDb(); b = await seedBasics(); invalidateSettingsCache();
    fakeOutbox().length = 0;
  });

  it('sends nothing while it is off', async () => {
    await ring(b.users.alisa.id, 'meeting_approval', mins(TUE_10AM, 30));
    expect(await runBellEmail(TUE_10AM)).toMatchObject({ ran: false });
    expect(fakeOutbox()).toHaveLength(0);
  });

  it('emails what needs action after the pause, once, with a link into Cadence; the rest waits for the summary', async () => {
    await on();
    const approval = await ring(b.users.alisa.id, 'meeting_approval', mins(TUE_10AM, 12));
    const fresh = await ring(b.users.alisa.id, 'meeting_declined', mins(TUE_10AM, 3), { reason: 'No proof' });
    const kudos = await ring(b.users.alisa.id, 'meeting_kudos', mins(TUE_10AM, 30));
    expect(await runBellEmail(TUE_10AM)).toMatchObject({ ran: true, instant: 1 });
    expect(fakeOutbox()).toHaveLength(1);
    const [mail] = fakeOutbox();
    expect(mail).toMatchObject({ from: 'cadence@acumen.example', to: 'alisa@cadence.local', subject: 'Approve or decline: Intro call' });
    expect(mail.html).toContain('Approve or decline it.');
    expect(mail.html).toContain('http://localhost:3100/meetings/approval');
    expect(mail.html).toContain('Hi Alisa,');
    // No pictures to fetch: the wordmark is text, and there is no meetings bar without "Your day" (owner, 25 Nov).
    expect(mail.images).toEqual([]);
    const row = (id: string) => prisma.notification.findUniqueOrThrow({ where: { id } });
    expect((await row(approval.id)).emailedAt).not.toBeNull();
    expect((await row(fresh.id)).emailedAt).toBeNull();
    expect((await row(kudos.id)).emailedAt).toBeNull();
    // The same run again sends nothing new: the declined one is not due yet.
    await runBellEmail(TUE_10AM);
    expect(fakeOutbox()).toHaveLength(1);
    expect(await prisma.notificationEmail.findMany({ where: { userId: b.users.alisa.id } })).toEqual([expect.objectContaining({ kind: 'instant', status: 'SENT', notificationIds: [approval.id] })]);
  });

  it('never emails what was read or answered in Cadence, or anyone whose emails are off', async () => {
    await on();
    await ring(b.users.alisa.id, 'meeting_approval', mins(TUE_10AM, 30));
    await prisma.user.update({ where: { id: b.users.alisa.id }, data: { notificationsReadAt: mins(TUE_10AM, 1) } });
    const settled = await ring(b.users.leigh.id, 'meeting_approval', mins(TUE_10AM, 30));
    await prisma.notification.update({ where: { id: settled.id }, data: { resolution: 'approved' } });
    await ring(b.users.karson.id, 'meeting_declined', mins(TUE_10AM, 30));
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { emailNotifications: 'off' } });
    expect(await runBellEmail(TUE_10AM)).toMatchObject({ instant: 0, skipped: 3 });
    expect(fakeOutbox()).toHaveLength(0);
    expect(await prisma.notification.count({ where: { emailedAt: null } })).toBe(0);
  });

  it('the morning summary goes once on a weekday, with what came in and what is waiting; never at the weekend', async () => {
    await on();
    // Sam, a Sales Leader in Alisa's pod, with a meeting waiting for him and a cheer.
    const sam = await prisma.user.create({ data: { email: 'sam@cadence.local', name: 'Sam Leader', role: 'SALES_LEADER', passwordHash: 'x', timezone: 'Europe/London', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    await prisma.meeting.create({ data: { title: 'Waiting one', sourceUrl: '', occurredAt: new Date('2026-11-20T12:00:00Z'), approval: 'WAITING', bookedById: b.users.karson.id } });
    await ring(sam.id, 'meeting_kudos', mins(WED_8AM, 600));
    await prisma.user.update({ where: { id: sam.id }, data: { emailNotifications: 'digest' } });
    // Sam's, and the admin's: the meeting waits for her decision too.
    expect(await runBellEmail(WED_8AM)).toMatchObject({ digests: 2 });
    expect(fakeOutbox().map((m) => m.to).sort()).toEqual(['ria@cadence.local', 'sam@cadence.local']);
    const mail = fakeOutbox().find((m) => m.to === 'sam@cadence.local')!;
    expect(mail.subject).toBe('Your Cadence summary: 1 update');
    expect(mail.html).toContain('1 meeting waiting for your approval');
    expect(mail.html).toContain('class="cd-box"');
    expect(mail.html).toContain('Cheer');
    expect(mail.html).toContain('A colleague cheered');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: sam.id } })).lastDigestOn).toBe('2026-11-25');
    // Once a day.
    const before = fakeOutbox().length;
    await runBellEmail(new Date(WED_8AM.getTime() + 3_600_000));
    expect(fakeOutbox().length).toBe(before);
    // Not at the weekend, even with something new.
    await ring(sam.id, 'meeting_kudos', mins(SAT_9AM, 60));
    await runBellEmail(SAT_9AM);
    expect(fakeOutbox().length).toBe(before);
  });

  it('a digest-only person gets urgent things in the summary, not on their own', async () => {
    await on();
    await prisma.user.update({ where: { id: b.users.alisa.id }, data: { emailNotifications: 'digest' } });
    await ring(b.users.alisa.id, 'meeting_approval', mins(TUE_10AM, 30));
    expect(await runBellEmail(TUE_10AM)).toMatchObject({ instant: 0 });
    expect(await runBellEmail(WED_8AM)).toMatchObject({ digests: 1 });
    expect(fakeOutbox().filter((m) => m.to === 'alisa@cadence.local')).toHaveLength(1);
  });

  it('a refusal that would refuse every email pauses the pass instead of failing for everyone', async () => {
    await on();
    const refuse = vi.fn(async () => ({ ok: false as const, error: 'Microsoft refused (403): Access is denied.', permanent: true }));
    await ring(b.users.alisa.id, 'meeting_approval', mins(TUE_10AM, 30));
    await ring(b.users.leigh.id, 'meeting_approval', mins(TUE_10AM, 30));
    expect(await runBellEmail(TUE_10AM, refuse)).toMatchObject({ failed: 1, reason: expect.stringContaining('403') });
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(await prisma.notificationEmail.count()).toBe(1);
    expect(await runBellEmail(new Date(TUE_10AM.getTime() + 60_000), refuse)).toMatchObject({ ran: false, reason: expect.stringContaining('[Paused]') });
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(await prisma.notification.count({ where: { emailedAt: null } })).toBe(2);
  });

  it('turning emails on never sends what rang while they were off', async () => {
    await ring(b.users.alisa.id, 'meeting_approval', mins(TUE_10AM, 30));
    auth.user.mockResolvedValue({ ...b.users.ria, podIds: [], pods: [] });
    const fd = new FormData();
    for (const [k, v] of Object.entries({ enabled: 'on', senderMailbox: 'cadence@acumen.example', digestHour: '8', urgentDelayMinutes: '10', workStartHour: '8', workEndHour: '19' })) fd.set(k, v);
    expect(await saveEmailSettingsAction(fd)).toMatchObject({ ok: true });
    expect(await runBellEmail(TUE_10AM)).toMatchObject({ ran: true, instant: 0 });
    expect(fakeOutbox()).toHaveLength(0);
  });

  it('something urgent from the evening goes in the morning summary, not in a second email', async () => {
    await on();
    await ring(b.users.alisa.id, 'meeting_approval', mins(WED_8AM, 600));
    expect(await runBellEmail(WED_8AM)).toMatchObject({ instant: 0, digests: 1 });
    expect(fakeOutbox().filter((m) => m.to === 'alisa@cadence.local').map((m) => m.subject)).toEqual(['Your Cadence summary: 1 update']);
  });

  it('work hours and the summary hour are the person\'s own', () => {
    const s = DEFAULT_SETTINGS.email;
    expect(inWorkHours(TUE_10AM, 'Europe/London', s)).toBe(true);
    expect(inWorkHours(TUE_10AM, 'America/Los_Angeles', s)).toBe(false); // 2am there
    expect(inWorkHours(SAT_9AM, 'Europe/London', s)).toBe(false);
    expect(digestDue(WED_8AM, 'Europe/London', s, null)).toBe(true);
    expect(digestDue(WED_8AM, 'Europe/London', s, '2026-11-25')).toBe(false);
    expect(digestDue(WED_8AM, 'America/Chicago', s, null)).toBe(false); // 2am there
  });

  it('the email escapes what it shows', () => {
    expect(escapeHtml('<b>"Tom & Jerry"</b>')).toBe('&lt;b&gt;&quot;Tom &amp; Jerry&quot;&lt;/b&gt;');
    const mail = renderBellEmail({ kind: 'instant', firstName: '<Sam>', appUrl: 'https://cadence.example', timezone: 'UTC', items: [{ kind: 'reply', name: 'Pat <script>', company: null, title: 'Replied', detail: null, href: '/people/p1', linkLabel: 'Open', at: new Date() }] });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('https://cadence.example/people/p1');
    expect(mail.text).toContain('https://cadence.example/people/p1');
  });

  it('the email reads the same in every mail app and on a phone: sizes written out, a sheet on a page, dark mode for Apple Mail and Outlook apart', () => {
    const mail = renderBellEmail({ kind: 'test', firstName: 'Sam', appUrl: 'https://cadence.example', timezone: 'UTC', extras: { approvalsWaiting: 2 }, items: [{ kind: 'meeting_approval', name: 'Intro', company: null, title: 'Approve it', detail: null, href: '/meetings/approval', linkLabel: 'Open', at: new Date() }] });
    // Outlook drops the `font` shorthand, and every size with it.
    expect(mail.html).not.toMatch(/[;"]font:/);
    expect(mail.html).toContain('font-size:16px;font-weight:600');
    // The greeting in one line, short at the top (owner, 25 Nov).
    expect(mail.html).toMatch(/>Hi Sam,<\/span> this is a test from Settings\./);
    // One set of sizes: no narrow-screen rules, so a phone shows what a computer shows (owner, 25 Nov).
    expect(mail.html).not.toContain('max-width:520px');
    expect(mail.html).toContain('<meta name="color-scheme" content="light dark">');
    // The letter is a white sheet on a pale page (owner, 24 Nov), light colours inline.
    expect(mail.html).toContain('bgcolor="#eef2f0" class="cd-page"');
    expect(mail.html).toContain('bgcolor="#ffffff" class="cd-sheet cd-line"');
    expect(mail.html).toContain('border:1px solid #dbe3df;border-radius:16px');
    // Apple Mail's dark surfaces go by attribute selector, which Outlook (it renames classes) should miss.
    expect(mail.html).toContain('[class~="cd-sheet"]{background-color:#242a28!important}');
    expect(mail.html).not.toMatch(/@media[^}]*\n\.cd-(page|sheet|box)\{background/);
    // Outlook's dark surfaces, one step off Apple Mail's, onto the inner layers.
    expect(mail.html).toContain('[data-ogsb] .cd-sheet{background-color:#242a27!important}');
    expect(mail.html).toContain('<td class="cd-sheet" style="border-radius:15px">');
    expect(mail.html).toContain('[data-ogsc] .cd-amber{color:#f2c46a!important}');
    expect(mail.html).toContain('[data-ogsb] .cd-line{border-color:#343d39!important}');
    // Lines between sections are filled rows, which Outlook colours, never cell borders, which it left light (25 Nov).
    expect(mail.html).toContain('[data-ogsb] .cd-rule{background-color:#343d39!important}');
    expect(mail.html).toContain('[class~="cd-rule"]{background-color:#343d3a!important}');
    expect(mail.html).not.toContain('border-top:');
    // Only the descendant form, the one Outlook is known to honour.
    expect(mail.html).not.toMatch(/\.cd-[a-z-]+\[data-ogs/);
    // The wordmark is text, so it shows at once (owner, 25 Nov): evergreen with the mint dot; white with the lime dot in dark mode.
    expect(mail.html).toContain('letter-spacing:-0.06em;color:#1f6b57">cadence<span class="cd-dot" style="color:#82c4ac">.</span>');
    expect(mail.html).toContain('[data-ogsc] .cd-mark{color:#ffffff!important}');
    expect(mail.html).toContain('.cd-dot{color:#d5e9ad!important}');
    expect(mail.images).toEqual([]);
    expect(mail.html).not.toContain('<img');
    // Plain coloured labels; the Waiting line in plain ink, not green; no arrows anywhere (owner, 24 Nov).
    expect(mail.html).toContain('class="cd-ink" style="font-family:');
    expect(mail.html).toMatch(/class="cd-ink"[^>]*>2 meetings waiting for your approval<\/a>/);
    expect(mail.html).not.toContain('Waiting for you<');
    expect(mail.html).not.toContain('&rarr;');
    expect(mail.html).not.toContain('→');
    expect(mail.html).not.toContain('&#9679;');
    expect(mail.html).not.toContain('text-transform:uppercase');
    // A preview in a page carries the pictures in the html instead.
    const preview = renderBellEmail({ kind: 'digest', images: 'inline', firstName: 'Sam', appUrl: 'https://cadence.example', timezone: 'UTC', items: [], extras: { day: { tiles: [], meetings: { label: 'Meetings in November', count: 3, goal: 8, foot: '5 to go', href: '/meetings' } } } });
    expect(preview.images).toEqual([]);
    expect(preview.html).toContain('src="data:image/gif;base64,');
  });

  it('the summary goes every workday while a number of the day is not zero, with "Your day" and the meetings bar (owner, 24 Nov)', async () => {
    await on();
    // Sam leads Alisa's pod, where one campaign runs; nothing is in anyone's bell.
    const sam = await prisma.user.create({ data: { email: 'sam@cadence.local', name: 'Sam Leader', role: 'SALES_LEADER', passwordHash: 'x', timezone: 'Europe/London', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    await prisma.campaign.create({ data: { name: 'Q4 Harbor', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-11-02', status: 'ACTIVE' } });
    expect(await runBellEmail(WED_8AM)).toMatchObject({ digests: 2 });
    // The leader (campaigns in their pods) and the admin (every campaign); FOs with every number at 0 get nothing.
    expect(fakeOutbox().map((m) => m.to).sort()).toEqual(['ria@cadence.local', 'sam@cadence.local']);
    const mail = fakeOutbox().find((m) => m.to === sam.email)!;
    expect(mail.subject).toBe('Your Cadence summary: your day');
    expect(mail.html).toContain('</span> here is your day.</div>');
    expect(mail.html).toContain('class="cd-rise"');
    expect(mail.html).toContain('Overdue in your pods');
    expect(mail.html).toMatch(/>1<\/div>\s*<div class="cd-muted"[^>]*>Campaigns running</);
    expect(mail.html).toContain('Your pods&#39; meetings in November');
    expect(mail.html).toContain('href="http://localhost:3100/campaigns?tab=active"');
    expect(mail.text).toContain('Your day: Overdue in your pods 0, Campaigns running 1');
    // The bar is an animated picture (the owner kept it, 25 Nov), light and dark, swapped by the dark mode rules; the only pictures sent.
    expect(mail.images?.map((i) => `${i.id} ${i.contentType}`)).toEqual(['cadence-bar-light image/gif', 'cadence-bar-dark image/gif']);
    expect(mail.html).toMatch(/Your pods&#39; meetings in November<\/a><span class="cd-muted"[^>]*> · \d+ to go, \d+ workdays? left<\/span>/);
    expect(mail.html).toContain('src="cid:cadence-bar-dark"');
    expect(mail.html).toContain('[data-ogsc] .cd-bar-dark{display:block!important');
    const gif = Buffer.from(mail.images!.find((i) => i.id === 'cadence-bar-light')!.base64, 'base64');
    expect(gif.subarray(0, 6).toString()).toBe('GIF89a');
    expect(gif[gif.length - 1]).toBe(0x3b);
    // It plays once: no loop instruction.
    expect(gif.includes(Buffer.from('NETSCAPE'))).toBe(false);
    expect(mail.html).not.toContain('&rarr;');
  });

  it('an FO\'s day: due today and overdue as on Tasks, their campaigns, and their meetings against the goal', async () => {
    const day = await dayFigures({ id: b.users.karson.id, role: 'JUNIOR_FO', podIds: [b.pods.Alisa.id] }, WED_8AM);
    expect(day.tiles.map((t) => t.label)).toEqual(['Due today', 'Overdue', 'Campaigns running']);
    expect(day.tiles.find((t) => t.label === 'Overdue')).toMatchObject({ href: '/tasks?tab=overdue', warn: true });
    expect(day.meetings).toMatchObject({ label: 'Meetings in November', count: 0, goal: 8, foot: expect.stringMatching(/^8 to go, \d+ workdays? left$/), href: '/meetings' });
    expect(dayHasNews(day)).toBe(false);
    const html = renderBellEmail({ kind: 'digest', firstName: 'Karson', appUrl: 'https://cadence.example', timezone: 'UTC', items: [], extras: { day: { ...day, tiles: day.tiles.map((t) => ({ ...t, value: t.label === 'Overdue' ? 3 : 12 })) } } });
    expect(html.subject).toBe('Your Cadence summary: 12 due today, 3 overdue');
    expect(html.html).toContain('class="cd-amber cd-num" style="font-family:');
  });

  it('"Move to CRM finished" stays in the bell and is never emailed (owner, 24 Nov)', async () => {
    await on();
    await prisma.user.update({ where: { id: b.users.alisa.id }, data: { emailNotifications: 'digest' } });
    const moved = await ring(b.users.alisa.id, 'move_finished', mins(WED_8AM, 600), { text: 'Move to CRM finished: 3 moved.', moveId: 'mv-1' });
    await ring(b.users.alisa.id, 'meeting_kudos', mins(WED_8AM, 600));
    await runBellEmail(WED_8AM);
    const mail = fakeOutbox().find((m) => m.to === 'alisa@cadence.local')!;
    expect(mail.html).toContain('Cheer');
    expect(mail.html).not.toContain('Move to CRM finished');
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: moved.id } })).emailedAt).toBeNull();
  });

  it('each person\'s emails follow the time zone of their own computer, and only their emails do', async () => {
    await on();
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { emailNotifications: 'digest', emailTimezone: 'America/Los_Angeles' } });
    await ring(b.users.karson.id, 'meeting_kudos', mins(WED_8AM, 600));
    // 8am in London is midnight in Los Angeles: not yet.
    await runBellEmail(WED_8AM);
    expect(fakeOutbox().filter((m) => m.to === 'karson@cadence.local')).toHaveLength(0);
    // 8am in Los Angeles.
    await runBellEmail(new Date('2026-11-25T16:05:00Z'));
    expect(fakeOutbox().filter((m) => m.to === 'karson@cadence.local')).toHaveLength(1);
    // Read from the page: a real time zone is saved; anything else is ignored.
    auth.user.mockResolvedValue({ ...b.users.karson, podIds: [], pods: [], emailTimezone: 'America/Los_Angeles' });
    await saveEmailTimezoneAction('Asia/Kolkata');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.karson.id } })).emailTimezone).toBe('Asia/Kolkata');
    await saveEmailTimezoneAction('Not/A_Zone');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.karson.id } })).emailTimezone).toBe('Asia/Kolkata');
    // The workspace's own clock is untouched.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.karson.id } })).timezone).toBe('Europe/London');
  });
});
