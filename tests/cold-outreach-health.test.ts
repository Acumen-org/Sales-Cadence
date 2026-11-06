import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { todayIn, addDays } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { NIGHTLY_MARKER, nightlyLoop, readNightly, type NightlyJob } from '@/lib/nightly';
import { outreachHealth, ringHealth, HEALTH_KEY } from '@/lib/outreach/health';
import { importTwilioCalls, importStatus } from '@/lib/calls/import';
import type { TwilioReader } from '@/lib/calls/twilio';
import { bellWords } from '@/lib/notifications';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => '/settings', useSearchParams: () => new URLSearchParams() }));
const { loadColdOutreachSettings } = await import('@/lib/sandbox/cold-settings');
const { ColdOutreachSettings } = await import('@/components/settings/cold-outreach-settings');

/**
 * Stage S11a (W13): the nightly jobs in a loop of their own (N087), and the admin health card with
 * its bell (PLAN 4.7).
 */

/** A promise and the hand that settles it, to hold a job open. */
function gate() {
  let open!: () => void;
  const done = new Promise<void>((resolve) => { open = resolve; });
  return { done, open };
}

/** Noon in the workspace's zone, a day well after the nightly hour. */
const middayOn = (day: string) => new Date(`${day}T18:00:00Z`);

describe('nightly jobs and the health card (S11a)', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('N087: the nightly jobs run in their own loop: the tick goes on while they run, a second start does nothing, and each run records its start, end and every job\'s time', async () => {
    const now = new Date();
    const today = todayIn(workspaceTimezone(), now);
    const slow = gate();
    const ran: string[] = [];
    const jobs = (): NightlyJob[] => [
      { name: 'reconcile', crm: true, run: async () => { ran.push('reconcile'); await slow.done; return { read: 3 }; } },
      { name: 'crm check', run: async () => { ran.push('crm check'); throw new Error('The CRM timed out'); } },
      { name: 'retention', run: async () => { ran.push('retention'); return { removed: 0 }; } },
    ];
    const loop = nightlyLoop({ hour: 0, jobs });
    // The poke returns at once, with the slow job still running: the tick goes on to imports and moves.
    expect(await loop.poke(now)).toBe(true);
    await vi.waitFor(() => expect(ran).toEqual(['reconcile']));
    expect(loop.running).toBe(true);
    // While a CRM job runs the tick's own CRM sync waits its turn.
    expect(loop.crmBusy).toBe(true);
    expect((await readNightly())?.running?.startedAt).toEqual(expect.any(String));
    expect(await loop.poke(now)).toBe(false);

    slow.open();
    await loop.settled();
    expect(loop.running).toBe(false);
    expect(loop.crmBusy).toBe(false);
    // A failing job is recorded and the next one runs all the same.
    expect(ran).toEqual(['reconcile', 'crm check', 'retention']);
    const marker = (await readNightly())!;
    expect(marker).toEqual(expect.objectContaining({ day: today, running: null, durationMs: expect.any(Number), startedAt: expect.any(String), finishedAt: expect.any(String) }));
    expect(marker.jobs).toEqual([
      expect.objectContaining({ name: 'reconcile', ok: true, ms: expect.any(Number) }),
      expect.objectContaining({ name: 'crm check', ok: false, error: 'The CRM timed out' }),
      expect.objectContaining({ name: 'retention', ok: true }),
    ]);

    // A restart the same day reads the marker and does not run them again; the next day it does.
    const restarted = nightlyLoop({ hour: 0, jobs });
    expect(await restarted.poke(now)).toBe(false);
    expect(await restarted.poke(new Date(now.getTime() + 86_400_000))).toBe(true);
    await restarted.settled();
    expect(ran.filter((j) => j === 'reconcile')).toHaveLength(2);
  });

  it('N087: Settings > Cold outreach says when the nightly jobs ran and how long they took, or that they are running', async () => {
    const at = new Date();
    await prisma.setting.create({ data: { key: NIGHTLY_MARKER, value: { day: todayIn(workspaceTimezone(), at), at: at.toISOString(), durationMs: 12 * 60_000, running: { startedAt: at.toISOString() } } } });
    const html = renderToStaticMarkup(createElement(ColdOutreachSettings, { data: await loadColdOutreachSettings({ full: true }), canEdit: true, timezone: 'UTC' }));
    expect(html).toContain('for 12 minutes');
    expect(html).toContain('Running now');
  });

  it('PLAN 4.7: the health card turns each line amber past its threshold: a stuck push, a failed move, two failed imports, the nightly, a form over 24 hours, a failing mailbox', async () => {
    const now = middayOn('2026-11-10');
    const ok = async () => Object.fromEntries((await outreachHealth(now)).map((l) => [l.key, l.ok]));
    expect(await ok()).toEqual({ pushes: true, moves: true, imports: true, nightly: false, forms: true, mailboxes: true });

    await prisma.bellwetherPush.create({ data: { idempotencyKey: 'k1', bodyHash: 'h', state: 'PROCESSING', pushedByEmail: 'x@acumen-strategy.com', contactCount: 1, createdAt: new Date(now.getTime() - 11 * 60_000) } });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.sandboxMove.create({ data: { createdById: b.users.alisa.id, count: 1, state: 'DONE', createdAt: new Date(now.getTime() - 3600_000), items: { create: [{ sandboxContactId: c.id, state: 'FAILED', mode: 'create', snapshot: {}, error: 'The CRM refused the firm' }] } } });
    await prisma.setting.create({ data: { key: 'twilioImport.status', value: { at: now.toISOString(), error: 'Twilio said 401', failedInARow: 2 } } });
    await prisma.setting.create({ data: { key: NIGHTLY_MARKER, value: { day: addDays('2026-11-10', -1), at: now.toISOString(), running: { startedAt: new Date(now.getTime() - 31 * 60_000).toISOString() } } } });
    await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: new Date(now.getTime() - 26 * 3600_000), formDueAt: new Date(now.getTime() - 25 * 3600_000) } });
    await prisma.mailboxCursor.create({ data: { userId: b.users.alisa.id, folder: 'sentitems', error: 'Access denied', errorAt: now } });

    const lines = await outreachHealth(now);
    expect(lines.every((l) => !l.ok)).toBe(true);
    const words = Object.fromEntries(lines.map((l) => [l.key, l.words]));
    expect(words).toEqual({
      pushes: '1 push still being processed after 10 minutes.',
      moves: '1 move failed in the last 7 days and waits for someone.',
      imports: 'The last 2 imports from Twilio failed: Twilio said 401',
      nightly: 'Still running after 31 minutes.',
      forms: '1 form waiting more than 24 hours, the oldest for 25 hours.',
      mailboxes: '1 mailbox failing to read.',
    });
    // Admins see it in Settings; nobody else does.
    const page = async (canEdit: boolean) => renderToStaticMarkup(createElement(ColdOutreachSettings, { data: await loadColdOutreachSettings({ full: canEdit }, now), canEdit, timezone: 'UTC' }));
    expect(await page(true)).toContain('Needs a look');
    expect(await page(false)).not.toContain('Needs a look');
  });

  it('N087: the health card\'s nightly line is amber when the jobs have not run today once their hour has passed, and fine when they have', async () => {
    const now = middayOn('2026-11-10');
    const nightly = async () => (await outreachHealth(now)).find((l) => l.key === 'nightly')!;
    await prisma.setting.create({ data: { key: NIGHTLY_MARKER, value: { day: '2026-11-09', at: '2026-11-09T08:20:00.000Z', durationMs: 20 * 60_000 } } });
    expect(await nightly()).toEqual(expect.objectContaining({ ok: false, words: 'Not run today.' }));
    await prisma.setting.update({ where: { key: NIGHTLY_MARKER }, data: { value: { day: '2026-11-10', at: '2026-11-10T08:20:00.000Z', durationMs: 20 * 60_000 } } });
    expect(await nightly()).toEqual(expect.objectContaining({ ok: true, words: 'Ran today in 20 minutes.' }));
  });

  it('PLAN 4.7: a line that turns amber rings every admin\'s bell once, and again only after it was fine in between', async () => {
    const now = middayOn('2026-11-10');
    await prisma.setting.create({ data: { key: NIGHTLY_MARKER, value: { day: '2026-11-10', at: now.toISOString() } } });
    const admin2 = await prisma.user.create({ data: { email: 'ops@cadence.local', name: 'Second Admin', role: 'ADMIN', passwordHash: 'x' } });
    expect(await ringHealth(now)).toEqual([]);
    const form = await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId: b.users.alisa.id, startedAt: new Date(now.getTime() - 30 * 3600_000), formDueAt: new Date(now.getTime() - 30 * 3600_000) } });
    expect(await ringHealth(now)).toEqual(['forms']);
    const rung = await prisma.notification.findMany({ where: { kind: 'health_alert' }, orderBy: { userId: 'asc' } });
    expect(rung.map((n) => n.userId).sort()).toEqual([b.users.ria.id, admin2.id].sort());
    expect(bellWords(rung[0], { people: new Map(), contacts: new Map(), users: new Map() })).toEqual(expect.objectContaining({ name: 'Post-call forms', title: '1 form waiting more than 24 hours, the oldest for 30 hours.', href: '/cold-outreach?view=form_due' }));
    // Still amber: no second ring.
    expect(await ringHealth(now)).toEqual([]);
    // Fine again, then amber again: it rings again.
    await prisma.callLog.update({ where: { id: form.id }, data: { formDoneAt: now } });
    expect(await ringHealth(now)).toEqual([]);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: HEALTH_KEY } })).value).toEqual({ open: {} });
    await prisma.callLog.update({ where: { id: form.id }, data: { formDoneAt: null } });
    expect(await ringHealth(now)).toEqual(['forms']);
    expect(await prisma.notification.count({ where: { kind: 'health_alert' } })).toBe(4);
  });

  it('PLAN 4.7: the call import counts the runs that failed one after another, and a good run starts again from nought', async () => {
    let fail = true;
    const reader = {
      kind: 'fake',
      listCalls: async () => { if (fail) throw new Error('Twilio said 401'); return { calls: [], nextPage: null }; },
      getCall: async () => null, listRecordings: async () => [], listNumbers: async () => [], recordingMedia: async () => new Response(null),
    } as TwilioReader;
    await importTwilioCalls({ reader });
    expect((await importStatus()).failedInARow).toBe(1);
    await importTwilioCalls({ reader });
    expect(await importStatus()).toEqual(expect.objectContaining({ failedInARow: 2, lastError: 'Twilio said 401' }));
    expect((await outreachHealth()).find((l) => l.key === 'imports')!.ok).toBe(false);
    fail = false;
    await importTwilioCalls({ reader });
    expect(await importStatus()).toEqual(expect.objectContaining({ failedInARow: 0, lastError: null }));
  });
});
