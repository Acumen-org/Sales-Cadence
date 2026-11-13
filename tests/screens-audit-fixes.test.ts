import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { todayIn } from '@/lib/dates';
import { flowCounter, listNextActionItems } from '@/lib/tasks-query';
import { listCampaigns } from '@/lib/campaigns-query';
import { campaignPeoplePage } from '@/lib/campaign-people-page';
import { listAccounts } from '@/lib/accounts-query';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, getCurrentUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => '/tasks', useSearchParams: () => new URLSearchParams() }));

const { snoozeStepAction } = await import('@/lib/actions/tasks');
const { liveSelection } = await import('@/components/tasks/task-list');
const { readRecoveryCopy } = await import('@/components/tasks/task-composer');
const { dropFlashFromAddress } = await import('@/components/flash');
const { withOpenTab } = await import('@/components/reports/breakdown-switch');

/** Fixes from the screens audit (16-cadence-screens.md), each test named after its row. */

const session = (u: { id: string; email: string; name: string; role: Role; timezone: string; twentyMemberId: string | null; dailyCap: number | null }, podIds: string[]): SessionUser => ({ id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds, pods: podIds.map((id) => ({ id, name: id })) });

describe('screens audit: pure helpers', () => {
  it('R01: the bulk bar counts only ticked rows still open in the list', () => {
    const ticked = new Set(['a', 'b', 'c']);
    expect([...liveSelection(ticked, [{ id: 'b' }, { id: 'd' }])]).toEqual(['b']);
    expect(liveSelection(ticked, []).size).toBe(0);
  });

  it('R04: an unsaved copy kept in the browser is offered back, and one equal to the saved message is dropped', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    try {
      expect(readRecoveryCopy('t1', { subject: 'Hi', html: '<p>a</p>' })).toBeNull();
      store.set('cadence:recovery:t1', JSON.stringify({ subject: 'Hi', html: '<p>edited</p>', text: 'edited' }));
      expect(readRecoveryCopy('t1', { subject: 'Hi', html: '<p>a</p>' })).toEqual({ subject: 'Hi', html: '<p>edited</p>', text: 'edited' });
      expect(readRecoveryCopy('t1', { subject: 'Hi', html: '<p>edited</p>' })).toBeNull();
      expect(store.has('cadence:recovery:t1')).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it('R07: Task flow counts steps, names the other tasks, and never reads 0 / n', () => {
    expect(flowCounter(0, 5, 7)).toBe('1 / 5 steps, 2 other tasks');
    expect(flowCounter(2, 5, 5)).toBe('3 / 5 steps');
    expect(flowCounter(-1, 5, 7)).toBe('Not in this tab');
  });

  it('R09: a faded toast leaves the address so a reload does not show it again', () => {
    const replaced: string[] = [];
    vi.stubGlobal('window', { location: { href: 'http://x/tasks?tab=today&flash=Done.&flashTone=warn#a' }, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) } });
    try {
      dropFlashFromAddress();
      expect(replaced).toEqual(['/tasks?tab=today#a']);
    } finally { vi.unstubAllGlobals(); }
  });

  it('R21: a Reports link built before the breakdown switched keeps the table now open', () => {
    expect(withOpenTab('/reports?tab=fos&from=2026-11-01&view=calls', 'campaigns', 'http://x/reports?tab=campaigns')).toBe('/reports?tab=campaigns&from=2026-11-01&view=calls');
    expect(withOpenTab('/reports?tab=campaigns', 'campaigns', 'http://x/reports')).toBeNull();
    expect(withOpenTab('/reports/export?tab=fos', 'campaigns', 'http://x/reports')).toBeNull();
    expect(withOpenTab('/tasks?tab=fos', 'campaigns', 'http://x/reports')).toBeNull();
  });
});

describe('integration audit: routes that skip sign-in', () => {
  it('V10: every route under /api/v1 and /api/integrations goes through a handler that checks a key', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name === 'route.ts' ? [path.join(dir, d.name)] : []));
    const routes = [...files(path.join(process.cwd(), 'src/app/api/v1')), ...files(path.join(process.cwd(), 'src/app/api/integrations'))];
    expect(routes.length).toBeGreaterThan(5);
    for (const file of routes) expect(fs.readFileSync(file, 'utf8'), file).toMatch(/from '@\/lib\/(public-api\/http|sandbox\/bellwether-http)'/);
    const { middleware } = await import('@/middleware');
    const { NextRequest } = await import('next/server');
    expect(middleware(new NextRequest('http://x/api/integrations/other/thing')).status).toBe(307);
    expect(middleware(new NextRequest('http://x/api/integrations/bellwether/v1/ping')).status).toBe(200);
  });
});

describe('screens audit: queries and actions', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    auth.requireUser.mockResolvedValue(session(b.users.alisa, [b.pods.Alisa.id]));
  });

  const enroll = (personId: string, campaignId: string | null, status: 'ACTIVE' | 'REPLIED' | 'MEETING' = 'ACTIVE', repliedAt: Date | null = null) =>
    prisma.enrollment.create({ data: { personId, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, campaignId, startDate: '2026-11-02', audience: 'CRM', currentStep: 0, status, repliedAt } });

  it('R03: the People tile counts the whole campaign while a search narrows the list', async () => {
    const people = await prisma.personCache.findMany({ take: 3, orderBy: { id: 'asc' }, select: { id: true, lastName: true } });
    const campaign = await prisma.campaign.create({ data: { name: 'Studio', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-11-02', status: 'ACTIVE', personIds: people.map((p) => p.id) } });
    for (const p of people) await enroll(p.id, campaign.id);
    const page = await campaignPeoplePage({ id: campaign.id, personIds: campaign.personIds, plannerDraft: null, publishedPlan: null }, undefined, people[0].lastName ?? '');
    expect(page.total).toBeLessThan(3);
    expect(page.stats.people).toBe(3);
  });

  it('R12, R13: the list counts everyone who replied, meetings included, and every search word must match', async () => {
    const [p1, p2] = await prisma.personCache.findMany({ take: 2, orderBy: { id: 'asc' }, select: { id: true } });
    const harbor = await prisma.campaign.create({ data: { name: 'Q4 Harbor', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-11-02', status: 'ACTIVE' } });
    await prisma.campaign.create({ data: { name: 'Q4 Other', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-11-02', status: 'ACTIVE' } });
    await enroll(p1.id, harbor.id, 'REPLIED', new Date());
    await enroll(p2.id, harbor.id, 'MEETING', new Date());
    const admin = session(b.users.ria, []);
    const found = await listCampaigns(admin, { q: 'Q4 Harbor' });
    expect(found.map((c) => c.name)).toEqual(['Q4 Harbor']);
    expect(found[0].counts.replied).toBe(2);
    expect((await listCampaigns(admin, { q: 'Q4' })).length).toBe(2);
  });

  it('R06: Done chips count finished created tasks, as the tab does', async () => {
    const person = await prisma.personCache.findFirstOrThrow({ select: { id: true } });
    await prisma.nextAction.create({ data: { personId: person.id, foUserId: b.users.alisa.id, label: 'Email', action: 'EMAIL', dueDate: todayIn('Europe/London'), state: 'DONE', lastDoneAt: new Date(), audience: 'CRM' } });
    const r = await listNextActionItems(session(b.users.alisa, [b.pods.Alisa.id]), { tab: 'done', audience: 'all', foUserId: b.users.alisa.id });
    expect(r.counts.done).toBe(1);
    expect(r.channelCounts.EMAIL).toBe(1);
  });

  it('R11: a step snoozes all its actions to one day, or none of them', async () => {
    const person = await prisma.personCache.findFirstOrThrow({ select: { id: true } });
    const e = await enroll(person.id, null);
    const today = todayIn('Europe/London');
    const task = (action: 'EMAIL' | 'LINKEDIN_MESSAGE', actionIndex: number, state: 'PENDING' | 'DONE' = 'PENDING') => prisma.task.create({ data: { enrollmentId: e.id, foUserId: b.users.alisa.id, stepIndex: 0, stepId: 'step-d1', stepDay: 1, actionIndex, actionId: `act-${actionIndex}`, action, label: action, dueDate: today, dueAt: new Date(), plannedDate: today, state } });
    const a = await task('EMAIL', 0);
    const done = await task('LINKEDIN_MESSAGE', 1, 'DONE');
    const fd = new FormData(); fd.set('taskIds', `${a.id},${done.id}`); fd.set('toDate', 'next');
    expect((await snoozeStepAction(fd)).ok).toBe(false);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: a.id } })).snoozedTo).toBeNull();
    const c = await task('LINKEDIN_MESSAGE', 2);
    fd.set('taskIds', `${a.id},${c.id}`);
    expect((await snoozeStepAction(fd)).ok).toBe(true);
    const after = await prisma.task.findMany({ where: { id: { in: [a.id, c.id] } }, select: { snoozedTo: true } });
    expect(after[0].snoozedTo).not.toBeNull();
    expect(after[0].snoozedTo).toBe(after[1].snoozedTo);
  });

  it('R17, R18: the people figures follow the filter and "in a campaign" counts the People column\'s people, once each', async () => {
    const admin = session(b.users.ria, []);
    const company = (await prisma.personCache.groupBy({ by: ['companyId'], where: { companyId: { not: null }, deletedAt: null }, _count: { _all: true }, orderBy: { _count: { companyId: 'desc' } }, take: 1 }))[0].companyId!;
    const [p1, p2] = await prisma.personCache.findMany({ where: { companyId: company, deletedAt: null }, take: 2, orderBy: { id: 'asc' }, select: { id: true } });
    const c1 = await prisma.campaign.create({ data: { name: 'One', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-11-02', status: 'ACTIVE' } });
    await enroll(p1.id, c1.id);
    await enroll(p2.id, c1.id);
    await prisma.personCache.update({ where: { id: p2.id }, data: { deletedAt: new Date() } });
    const row = (await listAccounts(admin, {})).rows.find((r) => r.id === company)!;
    expect(row.inSequence).toBe(1);
    const pod = (await prisma.personCache.findUniqueOrThrow({ where: { id: p1.id }, select: { podOwner: true } })).podOwner;
    const whose = pod ? [{ podOwner: pod }] : [{ id: p1.id }];
    const wide = await listAccounts(admin, { peopleWhere: whose });
    const narrow = await listAccounts(admin, { q: 'zzzz-no-such-account', peopleWhere: whose });
    expect(wide.peopleInFilter).toBeGreaterThan(0);
    expect(narrow.peopleInFilter).toBe(0);
  });
});
