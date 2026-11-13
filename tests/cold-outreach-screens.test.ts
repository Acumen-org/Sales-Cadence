import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { coldOutreachRedirect } from '@/lib/cold-outreach-paths';
import { COLD_CAMPAIGNS_HREF, COLD_CONTACT_BASE, COLD_FROM_BELLWETHER_HREF, COLD_MOVES_HREF, coldMoveHref, coldRef, subjectHref } from '@/lib/subject';
import { COLD_TASKS_HREF } from '@/lib/tasks-query';
import { campaignTitle } from '@/lib/campaigns-query';
import { coldCues } from '@/lib/sandbox/cues';
import { listPushes } from '@/lib/sandbox/pushes-query';
import { SubjectBadges } from '@/components/subject-badges';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';
import { sessionOf } from './helpers/cold-campaign';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, getCurrentUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => '/cold-outreach', useSearchParams: () => new URLSearchParams(), redirect: (to: string) => { throw new Error(`redirect ${to}`); }, notFound: () => { throw new Error('not found'); } }));

const { globalSearchAction } = await import('@/lib/actions/search');
const { TaskList } = await import('@/components/tasks/task-list');
const { taskGridClass } = await import('@/components/tasks/tasks-screen');
const { LIVE } = await import('@/components/live-refresh');

/**
 * Stage S10 (cold outreach W8): the section's screens, the rename, Settings, search and the step strip.
 * One test per bug id, named after it.
 */
describe('Cold outreach: the address and the rename (S10)', () => {
  it('every /sandbox address redirects to its /cold-outreach page, keeping the query string', () => {
    expect(coldOutreachRedirect('/sandbox', '')).toBe('/cold-outreach');
    expect(coldOutreachRedirect('/sandbox/', '')).toBe('/cold-outreach');
    expect(coldOutreachRedirect('/sandbox', '?owner=mine&q=jane')).toBe('/cold-outreach?owner=mine&q=jane');
    expect(coldOutreachRedirect('/sandbox', '?tab=contacts&status=moved')).toBe('/cold-outreach?status=moved');
    expect(coldOutreachRedirect('/sandbox', '?tab=work')).toBe('/cold-outreach/tasks');
    expect(coldOutreachRedirect('/sandbox', '?tab=moves&state=failed')).toBe('/cold-outreach/moves?state=failed');
    expect(coldOutreachRedirect('/sandbox', '?tab=campaigns&view=finished&q=harbor')).toBe('/cold-outreach/campaigns?q=harbor&tab=finished');
    expect(coldOutreachRedirect('/sandbox/c-123', '?move=1')).toBe('/cold-outreach/c-123?move=1');
    expect(coldOutreachRedirect('/sandbox/moves/m-1', '')).toBe('/cold-outreach/moves/m-1');
    expect(coldOutreachRedirect('/sandbox/campaigns/k-9', '?page=2')).toBe('/campaigns/k-9?page=2');
    // Only the old section's own addresses move.
    expect(coldOutreachRedirect('/sandboxes', '')).toBeNull();
    expect(coldOutreachRedirect('/tasks', '?audience=cold')).toBeNull();
    expect(coldOutreachRedirect('/cold-outreach', '')).toBeNull();
  });

  it('the middleware answers an old address with a 307 to the new one, before the sign-in check', async () => {
    const { middleware } = await import('@/middleware');
    const { NextRequest } = await import('next/server');
    const res = middleware(new NextRequest('http://cadence.local/sandbox/abc?move=1'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname + new URL(res.headers.get('location')!).search).toBe('/cold-outreach/abc?move=1');
  });

  it('D1: no page or component shows the words "sandbox" or "Twenty"; they say Cold outreach and CRM', () => {
    const word = /(?<![A-Za-z_./$-])(Twenty|[Ss]andbox)(?![A-Za-z_(])/;
    const literal = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|>[^<>{}\n]+</g;
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'api') walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*|\{\/\*|import )/.test(line)) return;
          for (const m of line.match(literal) ?? []) {
            // Internal keys (`sandbox:<id>` in a select's value) are not words anyone reads.
            if (word.test(m) && !/^[`'"](sandbox|Sandbox|twenty|Twenty)[`'"]$/.test(m) && !m.includes('sandbox_') && !/sandbox'\}:\$\{/.test(m) && !m.includes('/sandbox')) found.push(`${path.relative(process.cwd(), p)}:${i + 1}: ${m}`);
          }
        });
      }
    };
    walk(path.join(process.cwd(), 'src', 'app'));
    walk(path.join(process.cwd(), 'src', 'components'));
    expect(found).toEqual([]);
  });

  it('every cold link is built under /cold-outreach: contacts, Campaigns, Moves, From Bellwether', () => {
    expect(COLD_CONTACT_BASE).toBe('/cold-outreach');
    expect(subjectHref(coldRef('c1'))).toBe('/cold-outreach/c1');
    // Cold work is done from Tasks with everything else (owner, 9 Nov 2026).
    expect(COLD_TASKS_HREF).toBe('/tasks');
    expect(COLD_CAMPAIGNS_HREF).toBe('/cold-outreach/campaigns');
    expect(COLD_MOVES_HREF).toBe('/cold-outreach/moves');
    expect(coldMoveHref('m1')).toBe('/cold-outreach/moves/m1');
    expect(COLD_FROM_BELLWETHER_HREF).toBe('/cold-outreach/from-bellwether');
  });
});

describe('Cold outreach screens (S10)', () => {
  let b: Basics;
  let alisa: SessionUser;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    alisa = await sessionOf(b.users.alisa.id);
  });

  it('B115: a cold campaign\'s page is titled "Q4 Harbor · Campaigns · Cold outreach", a CRM one\'s "· Campaigns"', async () => {
    const cold = await prisma.campaign.create({ data: { name: 'Q4 Harbor', audience: 'SANDBOX', podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-09', createdById: b.users.alisa.id } });
    const crm = await prisma.campaign.create({ data: { name: 'Spring push', audience: 'CRM', podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-09', createdById: b.users.alisa.id } });
    expect(await campaignTitle(cold.id)).toBe('Q4 Harbor · Campaigns · Cold outreach');
    expect(await campaignTitle(crm.id)).toBe('Spring push · Campaigns');
    const { generateMetadata } = await import('@/app/(app)/cold-outreach/[id]/page');
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe' });
    expect(await generateMetadata({ params: Promise.resolve({ id: c.id }) })).toEqual({ title: 'Jane Doe · Cold outreach' });
  });

  it('B115: a call page is titled with who the call was with, never just "Cadence"', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe' });
    const call = await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: new Date() } });
    const { generateMetadata } = await import('@/app/(app)/calls/[id]/page');
    expect(await generateMetadata({ params: Promise.resolve({ id: call.id }) })).toEqual({ title: 'Call with Jane Doe · Cold outreach' });
  });

  it('B057: From Bellwether lists every push with its counts, and each contact with its result and why', async () => {
    const added = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe' });
    const unclaimed = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Bob', lastName: 'Lee', ownerId: null, podId: null });
    await prisma.bellwetherPush.create({ data: {
      idempotencyKey: 'k1', bodyHash: 'h', state: 'DONE', pushedByEmail: 'alisa@cadence.local', ownerId: b.users.alisa.id, contactCount: 4,
      response: { results: [{ bellwetherContactId: 'bw-4', result: 'rejected', reason: 'suppressed', detail: 'This person asked not to be contacted.', warnings: [] }] },
      items: { create: [
        { bellwetherContactId: 'bw-1', result: 'created', sandboxContactId: added.id },
        { bellwetherContactId: 'bw-2', result: 'created', sandboxContactId: unclaimed.id },
        { bellwetherContactId: 'bw-3', result: 'already_in_crm', crmPersonId: (await prisma.personCache.findFirstOrThrow()).id },
        { bellwetherContactId: 'bw-4', result: 'rejected', reason: 'suppressed' },
      ] },
    } });
    const { rows, total } = await listPushes(await sessionOf(b.users.ria.id), 1);
    expect(total).toBe(1);
    expect(rows[0]).toEqual(expect.objectContaining({ added: 2, unclaimed: 1, inCrm: 1, refused: 1, merged: 0 }));
    expect(rows[0].by).toMatch(/^Alisa/);
    const byName = new Map(rows[0].contacts.map((c) => [c.name, c]));
    expect(byName.get('Jane Doe')).toEqual(expect.objectContaining({ result: 'Added', href: `/cold-outreach/${added.id}` }));
    expect(byName.get('Bob Lee')).toEqual(expect.objectContaining({ result: 'Added, unclaimed', tone: 'amber' }));
    expect(byName.get('Bellwether contact bw-4')).toEqual(expect.objectContaining({ result: 'Refused', why: 'This person asked not to be contacted.' }));
  });

  it('B057: From Bellwether is scoped like every leader view: a leader sees the pushes for their pods, Biz Ops and admins every push', async () => {
    const sally = await prisma.user.create({ data: { email: 'sally@cadence.local', name: 'Sally Leader', role: 'SALES_LEADER', passwordHash: 'x', timezone: 'Europe/London', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    const bea = await prisma.user.create({ data: { email: 'bea@cadence.local', name: 'Bea Ops', role: 'BIZ_OPS', passwordHash: 'x', timezone: 'Europe/London' } });
    const pushOf = (key: string, email: string, podId: string | null) => prisma.bellwetherPush.create({ data: { idempotencyKey: key, bodyHash: 'h', state: 'DONE', pushedByEmail: email, podId, contactCount: 0 } });
    const mine = await pushOf('p-alisa', 'alisa@cadence.local', b.pods.Alisa.id);
    const theirs = await pushOf('p-leigh', 'leigh@cadence.local', b.pods.Leigh.id);
    // Before the pod was kept: Karson (Alisa's pod) and Daniel (Leigh's) pushed with no pod on the push.
    const oldOurs = await pushOf('p-old-karson', 'Karson@Cadence.local', null);
    const oldTheirs = await pushOf('p-old-daniel', 'daniel@cadence.local', null);
    const ids = async (u: SessionUser) => (await listPushes(u, 1)).rows.map((r) => r.id).sort();
    expect(await ids(await sessionOf(sally.id))).toEqual([mine.id, oldOurs.id].sort());
    expect(await ids(await sessionOf(bea.id))).toEqual([mine.id, theirs.id, oldOurs.id, oldTheirs.id].sort());
    expect(await ids(await sessionOf(b.users.ria.id))).toHaveLength(4);
    // A push records its pod: the owner's.
    const { push, envelope, bwContact, enableBellwether, disableBellwether } = await import('./helpers/sandbox');
    enableBellwether();
    try {
      const res = await push(envelope([bwContact()]));
      expect(res.status).toBe(200);
      expect((await prisma.bellwetherPush.findUniqueOrThrow({ where: { id: res.body.pushId } })).podId).toBe(b.pods.Alisa.id);
    } finally {
      disableBellwether();
    }
  });

  it('PLAN 4.0: one badge per contact from one function, in the table\'s words, and the warning chips beside it', async () => {
    const today = '2026-11-06';
    const unclaimed = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null });
    const bare = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { badPhone: true, emailVerification: 'risky' });
    const stepped = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { possibleBounceAt: new Date('2026-11-04T10:00:00Z') });
    await prisma.nextAction.create({ data: { sandboxContactId: stepped.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2026-11-05', audience: 'SANDBOX' } });
    const opted = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { status: 'OPTED_OUT', optedOutAt: new Date('2026-11-03T12:00:00Z') });
    const cues = await coldCues([unclaimed.id, bare.id, stepped.id, opted.id], { today });
    expect(cues.get(unclaimed.id)!.badge).toEqual(expect.objectContaining({ label: 'Unclaimed', tone: 'amber' }));
    expect(cues.get(bare.id)!.badge).toEqual(expect.objectContaining({ label: 'No next step', tone: 'amber' }));
    expect(cues.get(bare.id)!.chips.map((c) => c.label)).toEqual(['Wrong number', 'Email risky']);
    // N083: overdue is red, and the next step is labelled.
    expect(cues.get(stepped.id)!.badge).toEqual(expect.objectContaining({ label: 'Call · Thu 5 Nov', tone: 'red' }));
    expect(cues.get(stepped.id)!.next).toEqual(expect.objectContaining({ label: 'Call', due: '2026-11-05', overdue: true }));
    expect(cues.get(stepped.id)!.chips.map((c) => c.label)).toEqual(['Possible bounce']);
    expect(cues.get(opted.id)!.badge).toEqual(expect.objectContaining({ label: 'Do not contact · 3 Nov 2026', tone: 'red' }));
    const html = renderToStaticMarkup(createElement(SubjectBadges, { badge: cues.get(bare.id)!.badge, chips: cues.get(bare.id)!.chips }));
    expect(html).toContain('No next step');
    expect(html).toContain('Wrong number');
  });

  it('B116: Ctrl K finds cold contacts and cold campaigns, each marked with what it is, a contact with its status badge', async () => {
    auth.requireUser.mockResolvedValue(alisa);
    const jane = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jané', lastName: 'Quarrington', badPhone: true });
    await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Old', lastName: 'Quarrington', status: 'OPTED_OUT', optedOutAt: new Date('2026-11-03T12:00:00Z') });
    const coldCampaign = await prisma.campaign.create({ data: { name: 'Quarrington push', audience: 'SANDBOX', podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-09', createdById: b.users.alisa.id } });
    const hits = await globalSearchAction('quarrington');
    const cold = hits.filter((h) => h.kind === 'cold');
    expect(cold.map((h) => h.title)).toEqual(['Jané Quarrington', 'Old Quarrington']);
    expect(cold[0]).toEqual(expect.objectContaining({ chip: 'Cold contact', href: `/cold-outreach/${jane.id}`, badge: expect.objectContaining({ label: 'No next step' }) }));
    expect(cold[1].badge).toEqual(expect.objectContaining({ label: 'Do not contact · 3 Nov 2026', tone: 'red' }));
    expect(hits.find((h) => h.kind === 'cold_campaign')).toEqual(expect.objectContaining({ id: coldCampaign.id, chip: 'Cold campaign', href: `/campaigns/${coldCampaign.id}` }));
    // Accents and phone digits find the same contact; a short number is not read as a phone (B055, B206).
    expect((await globalSearchAction('jane quarrington')).some((h) => h.id === jane.id)).toBe(true);
    expect((await globalSearchAction(jane.phone!.slice(-7))).some((h) => h.id === jane.id)).toBe(true);
    expect((await globalSearchAction('people-01')).some((h) => h.kind === 'cold')).toBe(false);
  });

  it('B211: Cold outreach pages refresh themselves, as Home, Tasks and Activity do', () => {
    for (const path of ['/cold-outreach', '/cold-outreach/abc', '/cold-outreach/tasks', '/cold-outreach/moves/m1']) expect(LIVE.test(path)).toBe(true);
    expect(LIVE.test('/reports')).toBe(false);
  });

  it('B211: the live refresh number moves when a next step is set, a contact arrives or a call is logged', async () => {
    const { GET } = await import('@/app/api/version/route');
    auth.requireUser.mockResolvedValue(await sessionOf(b.users.alisa.id));
    const version = async () => ((await (await GET()).json()) as { version: number }).version;
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const v0 = await version();
    await new Promise((r) => setTimeout(r, 20));
    await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2099-01-05', audience: 'SANDBOX' } });
    const v1 = await version();
    expect(v1).toBeGreaterThan(v0);
    await new Promise((r) => setTimeout(r, 20));
    await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const v2 = await version();
    expect(v2).toBeGreaterThan(v1);
    await new Promise((r) => setTimeout(r, 20));
    await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: new Date() } });
    expect(await version()).toBeGreaterThan(v2);
  });

  it('N057: from 1280px the contact card sits beside the composer, in its own column, not below it', () => {
    // The list is wide enough to read without lines cut off (owner, 13 Nov 2026).
    expect(taskGridClass('list', true)).toContain('xl:grid-cols-[320px_minmax(0,1fr)_300px]');
    expect(taskGridClass('list', false)).toBe('grid items-start gap-4 xl:grid-cols-[360px_minmax(0,1fr)]');
    expect(taskGridClass('flow', true)).toContain('xl:grid-cols-[minmax(0,1fr)_380px]');
  });

  it('PLAN 4.0: the Tasks row of a cold contact carries its warning chips (N073 Wrong number, N046 Form due)', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { badPhone: true });
    await prisma.callLog.create({ data: { source: 'TWILIO_IMPORT', twilioCallSid: 'CA-s10', userId: b.users.alisa.id, sandboxContactId: c.id, direction: 'OUTBOUND', status: 'COMPLETED', toNumber: c.phone!, fromNumber: '+13125550000', startedAt: new Date(), formDueAt: new Date() } });
    const cue = (await coldCues([c.id])).get(c.id)!;
    expect(cue.chips.map((x) => x.label)).toEqual(['Wrong number', 'Form due']);
    const html = renderToStaticMarkup(createElement(TaskList, { rows: [{ id: 't1', personName: 'Sam Rivera', companyName: 'Rivera Wealth', label: 'Call 1', action: 'CALL', stepIndex: 0, stepDay: 1, due: '2026-11-06', snoozed: false, state: 'PENDING', foName: 'Alisa', campaignName: null, chips: cue.chips }], selectedId: null, today: '2026-11-06', showFo: false, hrefTemplate: '/tasks?task=__ID__', dispositions: [], skipReasons: [], fos: [], nextWorkingDay: '2026-11-09', canPickSnoozeDate: true, bulkEnabled: false }));
    expect(html).toContain('Wrong number');
    expect(html).toContain('title="Form due"');
  });
});
