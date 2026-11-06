import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActionType, Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { userActor } from '@/lib/audit';
import { whyNotWorkTask } from '@/lib/auth/rbac';
import { getColdTaskBrief, getTaskBrief } from '@/lib/brief';
import { snoozeTask } from '@/lib/engine/tasks';
import { buildHome } from '@/lib/home-query';
import { replyCount, meetingsHeld } from '@/lib/outreach/metrics';
import { optOutContact } from '@/lib/outreach/transitions';
import { coldRef, COLD_CONTACT_BASE, loadSubjects, refKey } from '@/lib/subject';
import { channelBlock, optOutConfirm, shortDay, workingDayHint } from '@/lib/task-cues';
import { COLD_TASKS_HREF, dueCounts, filterOptions, heldWords, listNextActionItems, listTaskGroups, nextActionListInclude, rowSubject, type TaskAudience } from '@/lib/tasks-query';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), usePathname: () => '/tasks', useSearchParams: () => new URLSearchParams() }));

const { bulkTasksAction, completeTaskAction, finishFromTaskAction, skipTaskAction } = await import('@/lib/actions/tasks');
const { completeNextActionAction } = await import('@/lib/actions/next-actions');
const { TaskActions } = await import('@/components/tasks/task-actions');
const { TaskComposer, outlookComposeHref } = await import('@/components/tasks/task-composer');
const { TaskList } = await import('@/components/tasks/task-list');
const { NextActionControls } = await import('@/components/tasks/next-action-controls');
const { NextActionList, NextActionPanel } = await import('@/components/tasks/next-action-list');
const { ColdBriefPanel } = await import('@/components/tasks/cold-brief');
const { WorkingDayHint } = await import('@/components/tasks/working-day-hint');

/**
 * S6 (cold outreach PLAN 4.3, W6): one Tasks list for CRM and cold work (D2), the same screen
 * filtered to cold work for Cold outreach > Tasks. Each test is named after its bug.
 */

// Wednesday 4 Nov 2026, midday in London (the seeded users' zone).
const NOW = new Date('2026-11-04T12:00:00Z');
const TODAY = '2026-11-04';
const session = (u: { id: string; email: string; name: string; role: Role; timezone: string; twentyMemberId: string | null; dailyCap: number | null }, podIds: string[]): SessionUser => ({ id: u.id, email: u.email, name: u.name, role: u.role, timezone: u.timezone, twentyMemberId: u.twentyMemberId, dailyCap: u.dailyCap, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
const draw = (el: unknown, props: Record<string, unknown>) => renderToStaticMarkup(createElement(el as never, props as never));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

const ACTIONS: Record<string, { stepId: string; actionId: string; label: string; stepIndex: number; actionIndex: number }> = {
  EMAIL: { stepId: 'step-d1', actionId: 'act-email-1', label: 'Email 1', stepIndex: 0, actionIndex: 0 },
  LINKEDIN_CONNECT: { stepId: 'step-d1', actionId: 'act-li-connect-1', label: 'LinkedIn connect', stepIndex: 0, actionIndex: 1 },
  CALL: { stepId: 'step-d3', actionId: 'act-call-1', label: 'Call 1', stepIndex: 1, actionIndex: 0 },
};

describe('one Tasks list for CRM and cold work', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    auth.requireUser.mockResolvedValue(session(b.users.alisa, [b.pods.Alisa.id]));
  });

  /** A cold contact in a campaign with one open step, as the engine would have made it. */
  async function coldStep(over: { action?: ActionType; dueDate?: string; contactId?: string; contact?: Parameters<typeof readyContact>[2]; foUserId?: string; enrollmentId?: string; status?: 'ACTIVE' | 'PAUSED'; pauseReason?: string; campaignId?: string } = {}) {
    const action = over.action ?? 'EMAIL';
    const contact = over.contactId ? await prisma.sandboxContact.findUniqueOrThrow({ where: { id: over.contactId } }) : await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: `Doe${Math.floor(Math.random() * 1e6)}`, ...over.contact });
    const foUserId = over.foUserId ?? b.users.alisa.id;
    const enrollment = over.enrollmentId ? await prisma.enrollment.findUniqueOrThrow({ where: { id: over.enrollmentId } }) : await prisma.enrollment.create({ data: { sandboxContactId: contact.id, foUserId, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-02', status: over.status ?? 'ACTIVE', pauseReason: over.pauseReason ?? null, audience: 'SANDBOX', campaignId: over.campaignId ?? null, currentStep: 0 } });
    const a = ACTIONS[action];
    const dueDate = over.dueDate ?? TODAY;
    const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId, stepIndex: a.stepIndex, stepId: a.stepId, stepDay: a.stepIndex ? 3 : 1, actionIndex: a.actionIndex, actionId: a.actionId, action, label: a.label, dueDate, dueAt: new Date(`${dueDate}T09:00:00Z`), plannedDate: dueDate } });
    return { contact, enrollment, task };
  }
  /** A CRM person's step, the same way. */
  async function crmStep(personId: string, dueDate = TODAY, action: ActionType = 'EMAIL') {
    const enrollment = await prisma.enrollment.create({ data: { personId, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-02', audience: 'CRM', currentStep: 0 } });
    const a = ACTIONS[action];
    return prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId: b.users.alisa.id, stepIndex: a.stepIndex, stepId: a.stepId, stepDay: 1, actionIndex: a.actionIndex, actionId: a.actionId, action, label: a.label, dueDate, dueAt: new Date(`${dueDate}T09:00:00Z`), plannedDate: dueDate } });
  }
  const alisa = () => session(b.users.alisa, [b.pods.Alisa.id]);
  const list = (audience: TaskAudience, tab: 'today' | 'overdue' | 'upcoming' | 'done' = 'today', over: { foUserId?: string } = {}) => listTaskGroups(alisa(), { tab, audience, ...over }, NOW);

  it('B157: cold work is on the Tasks screen, in its tabs and with its snooze, beside CRM work and with no tag on the rows', async () => {
    const today = await coldStep();
    await coldStep({ dueDate: '2026-11-02' });
    await coldStep({ dueDate: '2026-11-09' });
    await crmStep('person-01');
    const all = await list('all');
    expect(all.counts).toEqual({ today: 2, overdue: 1, upcoming: 1, done: 0 });
    // One list, no tag: a row is a name and a firm, whichever kind it is.
    expect(all.rows.map((r) => rowSubject(r.enrollment).name)).toEqual(expect.arrayContaining([`${today.contact.firstName} ${today.contact.lastName}`, 'Nina Halvorsen']));
    // Cold outreach > Tasks: the same list, cold work only.
    const cold = await list('cold');
    expect(cold.counts).toEqual({ today: 1, overdue: 1, upcoming: 1, done: 0 });
    expect(cold.rows.every((r) => r.enrollment.sandboxContactId && !r.enrollment.personId)).toBe(true);
    // Snooze works on a cold step as on any: it moves to its day.
    await snoozeTask({ taskId: today.task.id, toDate: '2026-11-05' }, { actor: userActor(b.users.alisa), now: NOW });
    expect((await list('cold')).counts).toEqual({ today: 0, overdue: 1, upcoming: 2, done: 0 });
  });

  it('B158: Cold outreach > Tasks opens with no filter carried over from Contacts', () => {
    const url = new URL(COLD_TASKS_HREF, 'http://x');
    expect(url.pathname).toBe('/cold-outreach/tasks');
    expect([...url.searchParams.keys()]).toEqual([]);
  });

  it('B117: the badge counts exactly what the list it opens holds, for all work and for cold work', async () => {
    // One step whose email is overdue and whose LinkedIn is due today: one item, on Overdue, as the list puts it.
    const { enrollment, contact } = await coldStep({ dueDate: '2026-11-03' });
    await coldStep({ action: 'LINKEDIN_CONNECT', enrollmentId: enrollment.id, contactId: contact.id, dueDate: TODAY });
    await coldStep({ dueDate: TODAY });
    await crmStep('person-01');
    const other = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.nextAction.create({ data: { sandboxContactId: other.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: TODAY, audience: 'SANDBOX' } });
    for (const audience of ['all', 'cold'] as const) {
      const badge = await dueCounts(b.users.alisa.id, audience, TODAY);
      const steps = await listTaskGroups(alisa(), { tab: 'today', audience, foUserId: b.users.alisa.id }, NOW);
      const next = await listNextActionItems(alisa(), { tab: 'today', audience, foUserId: b.users.alisa.id }, NOW);
      expect(badge, audience).toEqual({ today: steps.counts.today + next.counts.today, overdue: steps.counts.overdue + next.counts.overdue });
    }
    expect(await dueCounts(b.users.alisa.id, 'cold', TODAY)).toEqual({ today: 2, overdue: 1 });
  });

  it('N030: every tab counts in the database, past any cap, and the list says how many it shows', async () => {
    const ids = Array.from({ length: 230 }, (_, i) => `c-n030-${i}`);
    await prisma.sandboxContact.createMany({ data: ids.map((id, i) => ({ id, source: 'MANUAL' as const, firstName: 'Bulk', lastName: `Contact ${i}`, ownerId: b.users.alisa.id, podId: b.pods.Alisa.id })) });
    await prisma.nextAction.createMany({ data: ids.map((id, i) => ({ sandboxContactId: id, foUserId: b.users.alisa.id, label: 'Call', action: 'CALL' as const, dueDate: i < 210 ? '2026-11-02' : TODAY, audience: 'SANDBOX' as const })) });
    const overdue = await listNextActionItems(alisa(), { tab: 'overdue', audience: 'cold' }, NOW, 200);
    expect(overdue.counts.overdue).toBe(210);
    expect(overdue.counts.today).toBe(20);
    expect(overdue.rows).toHaveLength(200);
    expect(overdue.total).toBe(210);
  });

  it('B159: a task the reader cannot work says why, where its controls would be', async () => {
    const other = await readyContact(b.users.leigh.id, b.pods.Leigh.id);
    const na = await prisma.nextAction.create({ data: { sandboxContactId: other.id, foUserId: b.users.leigh.id, label: 'Follow up', action: 'EMAIL', dueDate: TODAY, audience: 'SANDBOX' }, include: nextActionListInclude });
    const daniel = session(b.users.daniel, [b.pods.Leigh.id]);
    const why = whyNotWorkTask(daniel, 'Leigh Chen');
    expect(why).toBe("This is Leigh Chen's task. Junior FOs can work only their own tasks.");
    const html = draw(NextActionPanel, { item: na, today: TODAY, timezone: 'Europe/London', nextUrl: '/tasks', nextWorkingDay: '2026-11-05', mayWork: false, whyNot: why });
    expect(html).toContain('Junior FOs can work only their own tasks.');
    expect(html).not.toContain('>Done<');
  });

  it('B160: held steps name their campaign and who paused it', async () => {
    const campaign = await prisma.campaign.create({ data: { name: 'Q4 Harbor', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-11-02', status: 'PAUSED' } });
    await coldStep({ status: 'PAUSED', pauseReason: 'campaign_paused', campaignId: campaign.id });
    await coldStep({ status: 'PAUSED', pauseReason: 'campaign_paused', campaignId: campaign.id });
    await prisma.auditLog.create({ data: { entityType: 'campaign', entityId: campaign.id, action: 'paused', actorType: 'USER', actorLabel: 'Leigh Chen' } });
    const r = await list('cold');
    expect(r.held).toBe(2);
    expect(heldWords(r.heldBy)).toBe('2 steps held: Q4 Harbor paused by Leigh Chen');
  });

  it('B161: a cold call step closes only with its call and its form, in a list as on its own', async () => {
    const { task } = await coldStep({ action: 'CALL' });
    const bulk = await bulkTasksAction(form({ taskIds: task.id, op: 'complete', disposition: 'no_answer' }));
    expect(bulk).toEqual({ ok: false, error: 'Call 1: a cold call step closes with its call and its form' });
    expect(await completeTaskAction(form({ taskId: task.id, chosenAction: 'CALL', disposition: 'no_answer' }))).toEqual(expect.objectContaining({ ok: false }));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('PENDING');
    // On screen: Call and "Called from another phone?" stand where Done would; no quick Log call.
    const html = draw(TaskActions, { taskId: task.id, action: 'CALL', nextUrl: null, prevUrl: null, twentyUrl: null, nextWorkingDay: '2026-11-05', canPickSnoozeDate: true, dispositions: [], skipReasons: [], steps: [], currentStep: 0, canManageEnrollment: true, callSlot: createElement('span', null, 'Called from another phone?') });
    expect(html).toContain('Called from another phone?');
    expect(html).not.toContain('Log call');
  });

  it('B162: the FO filter offers every role their own work', async () => {
    for (const u of [b.users.ria, b.users.alisa, b.users.karson]) {
      const options = await filterOptions(session(u, []));
      expect(options.fos.map((f) => f.id), u.name).toContain(u.id);
    }
  });

  it('B210: the list checks nothing per row: its reads do not grow with the rows', async () => {
    type QueryEventClient = { $on: (event: 'query', cb: () => void) => void };
    let seen = 0;
    (prisma as unknown as QueryEventClient).$on('query', () => { seen += 1; });
    const count = async () => { seen = 0; await list('cold'); await new Promise((r) => setTimeout(r, 50)); return seen; };
    for (let i = 0; i < 3; i++) await coldStep({ action: 'CALL' });
    const few = await count();
    for (let i = 0; i < 25; i++) await coldStep({ action: 'CALL' });
    expect(await count()).toBe(few);
  });

  it('B212: Done says what happened, and a stale Done or Skip says why nothing changed', async () => {
    const { task, contact } = await coldStep();
    expect(await completeTaskAction(form({ taskId: task.id }))).toEqual(expect.objectContaining({ ok: true, message: expect.stringMatching(/^Done/) }));
    expect(await completeTaskAction(form({ taskId: task.id }))).toEqual({ ok: false, error: 'This task was already completed or skipped (possibly by an observed email or call).' });
    const second = await coldStep({ contactId: contact.id, enrollmentId: task.enrollmentId, action: 'LINKEDIN_CONNECT', dueDate: '2026-11-05' });
    await optOutContact(contact.id, { source: 'contact_page', actor: userActor(b.users.alisa) });
    await prisma.task.update({ where: { id: second.task.id }, data: { state: 'PENDING' } });
    expect(await skipTaskAction(form({ taskId: second.task.id, reasonKey: 'other' }))).toEqual({ ok: false, error: 'This contact asked not to be contacted; nothing was changed.' });
  });

  it('N031: "They replied" ends a cold sequence as replied, counts one reply, and asks what comes next', async () => {
    const { task, enrollment } = await coldStep({ action: 'LINKEDIN_CONNECT' });
    const r = await finishFromTaskAction(form({ taskId: task.id, kind: 'replied' }));
    expect(r).toEqual({ ok: true, message: 'Sequence ended: they replied. Set a next step, or move them to the CRM.' });
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('REPLIED');
    const period = { from: new Date(NOW.getTime() - 86_400_000), to: new Date(Date.now() + 86_400_000) };
    expect(await replyCount({ kind: 'all' }, 'cold', period)).toBe(1);
    // Saying it twice is still one reply.
    await finishFromTaskAction(form({ taskId: task.id, kind: 'replied' }));
    expect(await replyCount({ kind: 'all' }, 'cold', period)).toBe(1);
    // The cold panel offers the three endings a cold contact has.
    const html = draw(TaskActions, { taskId: task.id, action: 'EMAIL', nextUrl: null, prevUrl: null, twentyUrl: null, nextWorkingDay: '2026-11-05', canPickSnoozeDate: true, dispositions: [], skipReasons: [], steps: [], currentStep: 0, canManageEnrollment: true, endReasons: 'cold' });
    expect(html).not.toContain('Ran its course');
  });

  it('N056: an email step with no email, or a LinkedIn step with no profile, keeps Done off and says why', () => {
    expect(channelBlock('EMAIL', { firstName: 'Jane', email: null, linkedinUrl: null })).toBe('No email for Jane: add one or skip this step.');
    expect(channelBlock('LINKEDIN_CONNECT', { firstName: 'Jane', email: 'j@x.com', linkedinUrl: null })).toBe('No LinkedIn profile for Jane: add one or skip this step.');
    expect(channelBlock('EMAIL', { firstName: 'Jane', email: 'j@x.com', linkedinUrl: null })).toBeNull();
    const html = draw(TaskActions, { taskId: 't1', action: 'EMAIL', nextUrl: null, prevUrl: null, twentyUrl: null, nextWorkingDay: '2026-11-05', canPickSnoozeDate: true, dispositions: [], skipReasons: [], steps: [], currentStep: 0, canManageEnrollment: true, doneBlocked: 'No email for Jane: add one or skip this step.' });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Done/);
    expect(html).toContain('No email for Jane: add one or skip this step.');
  });

  it('N057: the composer names who it goes to, copies the subject or all of it, opens Outlook, and holds the LinkedIn profile', () => {
    const email = draw(TaskComposer, { taskId: 't1', subject: 'A quick idea', body: 'Hello Jane', label: 'Email 1', channel: 'EMAIL', recipient: { name: 'Jane Doe', firstName: 'Jane', email: 'jane@harbor.com' } });
    expect(email).toContain('Jane Doe</span> &lt;jane@harbor.com&gt;');
    for (const words of ['Copy address', 'Copy subject', 'Copy all', 'Open in Outlook']) expect(email).toContain(words);
    expect(outlookComposeHref('jane@harbor.com', 'A quick idea', 'Hello')).toBe('https://outlook.office.com/mail/deeplink/compose?to=jane%40harbor.com&subject=A+quick+idea&body=Hello');
    const none = draw(TaskComposer, { taskId: 't1', subject: 'A quick idea', body: 'Hello', label: 'Email 1', channel: 'EMAIL', recipient: { name: 'Jane Doe', firstName: 'Jane', email: null }, addDetailsHref: '/x' });
    expect(none).toContain('No email for Jane: add one or skip this step.');
    const li = draw(TaskComposer, { taskId: 't2', subject: null, body: 'Hi', label: 'LinkedIn connect', channel: 'LINKEDIN', recipient: { name: 'Jane Doe', firstName: 'Jane', email: null }, profileUrl: 'https://www.linkedin.com/in/jane' });
    expect(li).toContain('href="https://www.linkedin.com/in/jane"');
  });

  it('N103: a weekend date says so and offers the next working day', () => {
    expect(workingDayHint('2026-11-07', [1, 2, 3, 4, 5])).toEqual({ words: 'Sat 7 Nov is not a working day.', moveTo: '2026-11-09' });
    expect(workingDayHint('2026-11-09', [1, 2, 3, 4, 5])).toBeNull();
    expect(shortDay('2026-11-09')).toBe('Mon 9 Nov');
    expect(draw(WorkingDayHint, { date: '2026-11-08', workingDays: [1, 2, 3, 4, 5], onMove: () => {} })).toContain('Move to Mon 9 Nov');
  });

  it('N105: each control names the contact it is for', () => {
    const steps = draw(TaskActions, { taskId: 't1', action: 'EMAIL', nextUrl: null, prevUrl: null, twentyUrl: null, nextWorkingDay: '2026-11-05', canPickSnoozeDate: true, dispositions: [], skipReasons: [], steps: [], currentStep: 0, canManageEnrollment: true, subjectName: 'Jane Doe', stepLabel: 'Email 1' });
    expect(steps).toContain('aria-label="Done: Email 1 for Jane Doe"');
    expect(steps).toContain('aria-label="Skip: Email 1 for Jane Doe"');
    const next = draw(NextActionControls, { id: 'n1', nextUrl: '/tasks', nextWorkingDay: '2026-11-05', repeats: false, subjectName: 'Jane Doe', label: 'Call back' });
    expect(next).toContain('aria-label="Done: Call back for Jane Doe"');
  });

  it('B058: a cold step opens with its message, the contact, the firm\'s colleagues and the cold history', async () => {
    const { task, contact } = await coldStep();
    const colleague = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Ola', lastName: 'Colleague' });
    await prisma.personCache.create({ data: { id: 'person-firm-1', firstName: 'Cora', lastName: 'Crm', companyName: 'Rivera Wealth Partners' } });
    await prisma.sandboxNote.create({ data: { sandboxContactId: contact.id, authorName: 'Alisa Marsh', body: 'Prefers mornings' } });
    expect(await getTaskBrief(task.id, alisa())).toBeNull();
    const brief = (await getColdTaskBrief(task.id, alisa()))!;
    expect(brief.action.subject).toBe('A quick idea for your team');
    expect(brief.href).toBe(`${COLD_CONTACT_BASE}/${contact.id}`);
    expect(brief.contact.ownerName).toBe('Alisa Marsh');
    expect(brief.colleagues).toEqual(expect.arrayContaining([expect.objectContaining({ key: `c:${colleague.id}`, inCrm: false }), expect.objectContaining({ key: 'p:person-firm-1', inCrm: true, href: '/people/person-firm-1' })]));
    expect(brief.history).toEqual([expect.objectContaining({ kind: 'note', detail: 'Prefers mornings' })]);
    expect(brief.nextStep?.step.day).toBe(3);
  });

  it('B059: "Asked not to be contacted" asks first, naming what it does, and then opts the contact out', async () => {
    expect(optOutConfirm('opted_out', 'Jane Doe')).toEqual(expect.objectContaining({ title: 'Jane Doe asked not to be contacted?', confirmLabel: 'Opt out', tone: 'danger', effects: expect.arrayContaining(['This sequence ends as Opted out.']) }));
    expect(optOutConfirm('none', 'Jane Doe')).toBeNull();
    const { task, contact } = await coldStep();
    expect(await skipTaskAction(form({ taskId: task.id, reasonKey: 'opted_out' }))).toEqual(expect.objectContaining({ ok: true }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id } })).status).toBe('OPTED_OUT');
  });

  it('PLAN 8.13: no link for a cold contact on Tasks leads to a /people page', async () => {
    const { task, contact } = await coldStep();
    const na = await prisma.nextAction.create({ data: { sandboxContactId: contact.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: TODAY, audience: 'SANDBOX' }, include: nextActionListInclude });
    const brief = (await getColdTaskBrief(task.id, alisa()))!;
    const html = [
      draw(NextActionList, { items: [na], selectedId: na.id, today: TODAY, showFo: true, href: (id: string) => `/tasks?next=${id}` }),
      draw(NextActionPanel, { item: na, today: TODAY, timezone: 'Europe/London', nextUrl: '/tasks', nextWorkingDay: '2026-11-05', mayWork: true }),
      draw(ColdBriefPanel, { brief, timezone: 'Europe/London' }),
      draw(TaskList, { rows: [{ id: task.id, personName: 'Jane', companyName: null, label: 'Email 1', action: 'EMAIL', stepIndex: 0, stepDay: 1, due: TODAY, snoozed: false, state: 'PENDING', foName: 'Alisa', campaignName: null }], selectedId: null, today: TODAY, showFo: true, hrefTemplate: '/tasks?task=__ID__', dispositions: [], skipReasons: [], fos: [], nextWorkingDay: '2026-11-05', canPickSnoozeDate: true, bulkEnabled: true }),
    ].join('');
    expect(html).toContain('Cold contact');
    const links = hrefs(html);
    expect(links).toContain(`${COLD_CONTACT_BASE}/${contact.id}`);
    expect(links.filter((h) => h.startsWith('/people/'))).toEqual([]);
  });

  it('S3 (D3): a Closed contact has no work, so it is on no to-do list: not in Tasks, not in Home\'s Up next', async () => {
    const closed = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { lastOutcome: 'not_interested', lastOutcomeAt: new Date('2026-11-03T15:00:00Z') });
    const ended = await prisma.enrollment.create({ data: { sandboxContactId: closed.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-02', status: 'EXITED', exitReason: 'not_interested', audience: 'SANDBOX' } });
    await prisma.task.create({ data: { enrollmentId: ended.id, foUserId: b.users.alisa.id, stepIndex: 0, stepId: 'step-d1', stepDay: 1, actionIndex: 0, actionId: 'act-email-1', action: 'EMAIL', label: 'Email 1', dueDate: TODAY, dueAt: NOW, plannedDate: TODAY, state: 'CANCELLED' } });
    expect((await loadSubjects([coldRef(closed.id)])).get(refKey(coldRef(closed.id)))?.state).toBe('closed');
    const all = await list('all');
    expect(all.rows.some((r) => r.enrollment.sandboxContactId === closed.id)).toBe(false);
    expect((await buildHome(alisa(), NOW)).my.nextTasks).toEqual([]);
  });

  it('S4: a meeting next step is recorded, not done, and counts as a meeting held', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const na = await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Meeting', action: 'CALL', kind: 'MEETING', dueDate: TODAY, audience: 'SANDBOX' } });
    const html = draw(NextActionControls, { id: na.id, nextUrl: '/tasks', nextWorkingDay: '2026-11-05', repeats: false, kind: 'MEETING', meetingHref: '/meetings/new?personId=p1' });
    expect(html).toContain('Record meeting');
    expect(html).toContain('Add to Meetings');
    expect(await completeNextActionAction(form({ id: na.id }))).toEqual({ ok: true, message: 'Meeting recorded as held.' });
    expect(await meetingsHeld({ kind: 'rep', userId: b.users.alisa.id }, 'cold', { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) })).toBe(1);
  });

  it('S5: a cold email row says whether it closes itself, and a bounced contact carries its chip on the row', async () => {
    const list = draw(TaskList, { rows: [{ id: 't1', personName: 'Jane', companyName: 'Harbor', label: 'Email 1', action: 'EMAIL', stepIndex: 0, stepDay: 1, due: TODAY, snoozed: false, state: 'PENDING', foName: 'Alisa', campaignName: null, warning: 'Email bounced' }], selectedId: null, today: TODAY, showFo: false, hrefTemplate: '/tasks?task=__ID__', dispositions: [], skipReasons: [], fos: [], nextWorkingDay: '2026-11-05', canPickSnoozeDate: true, bulkEnabled: false });
    expect(list).toContain('Email bounced');
    const composer = draw(TaskComposer, { taskId: 't1', subject: 'Hi', body: 'Hello', label: 'Email 1', channel: 'EMAIL', closeWords: 'Click Done after sending.' });
    expect(composer).toContain('Click Done after sending.');
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { possibleBounceAt: new Date() });
    const na = await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Send the deck', action: 'EMAIL', dueDate: TODAY, audience: 'SANDBOX' }, include: nextActionListInclude });
    const panel = draw(NextActionPanel, { item: na, today: TODAY, timezone: 'Europe/London', nextUrl: '/tasks', nextWorkingDay: '2026-11-05', mayWork: true, warning: 'Possible bounce', closeWords: 'Closes itself when you send from Outlook.' });
    expect(panel).toContain('Possible bounce');
    expect(panel).toContain('Closes itself when you send from Outlook.');
  });
});
