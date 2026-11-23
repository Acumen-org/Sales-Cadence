import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { invalidateSettingsCache, saveSettingsSection, DEFAULT_SETTINGS } from '@/lib/settings';
import { digestDue, inWorkHours, runBellEmail } from '@/lib/bell-email/run';
import { escapeHtml, renderBellEmail } from '@/lib/bell-email/template';
import { fakeOutbox } from '@/lib/bell-email/send';
import { saveEmailSettingsAction } from '@/lib/actions/settings';
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

  it('the email has its own dark colours, for mail apps in dark mode and for Outlook on the web', () => {
    const mail = renderBellEmail({ kind: 'test', firstName: 'Sam', appUrl: 'https://cadence.example', timezone: 'UTC', items: [{ kind: 'meeting_approval', name: 'Intro', company: null, title: 'Approve it', detail: null, href: '/meetings/approval', linkLabel: 'Open', at: new Date() }] });
    expect(mail.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(mail.html).toMatch(/@media \(prefers-color-scheme:dark\)\{[\s\S]*\.cd-card\{background:#171f1c!important/);
    expect(mail.html).toContain('[data-ogsb] .cd-card,.cd-card[data-ogsb]{background:#171f1c!important');
    expect(mail.html).toContain('class="cd-amber"');
  });
});
