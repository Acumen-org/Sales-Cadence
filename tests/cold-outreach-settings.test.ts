import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { getSettings, invalidateSettingsCache } from '@/lib/settings';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import type { TwentyClient } from '@/lib/twenty';
import type { TwentyIntrospection } from '@/lib/twenty/types';
import { codeWords, crmValueChoices, crmValueIssues, crmValueRefusal, loadColdOutreachSettings, suppressionWords } from '@/lib/sandbox/cold-settings';
import { CRM_CHECK_RUNNING, lastCrmCheck, runCrmCheck } from '@/lib/sandbox/crm-check';
import { RETENTION_FORECAST_KEY } from '@/lib/sandbox/retention';
import { COLD_OUTREACH_SETTINGS_HREF, settingsRoute } from '@/lib/settings-tabs';
import { blockAccountConfirm, deleteMeetingConfirm, exitEnrollmentConfirm, fullRefreshConfirm, removeAccessConfirm, removePodConfirm, stopCampaignConfirm, unblockAccountConfirm } from '@/lib/confirms';
import { describeEventResult } from '@/lib/event-results';
import { ColdOutreachSettings } from '@/components/settings/cold-outreach-settings';
import { ColdOutreachRulesForm } from '@/components/settings/sandbox-settings';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';
import { sessionOf } from './helpers/cold-campaign';

const auth = vi.hoisted(() => ({ user: vi.fn() }));
const nav = vi.hoisted(() => ({ redirect: vi.fn((url: string) => { throw new Error(`REDIRECT ${url}`); }) }));
vi.mock('@/lib/auth/current-user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/current-user')>()),
  requireUser: auth.user,
  requireAdmin: async () => { const u = await auth.user(); if (u.role !== 'ADMIN') throw new Error('Admin only.'); return u; },
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect: nav.redirect,
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

/**
 * Stage S10 (cold outreach W8), Settings: Settings > Cold outreach (PLAN 4.7, as the owner amended
 * it), the Team Remove dialog on ConfirmDialog, the confirms that were still sentences, and "CRM"
 * wherever Settings said "Twenty". One test per bug id, named after it.
 */

/** The CRM's person fields as the real metadata API lists them, with options and their labels. */
function crmWithOptions(): TwentyIntrospection {
  const sel = (name: string, options: string[], labels: Record<string, string> = {}) => ({ name, type: 'SELECT', options, optionLabels: labels });
  return { source: 'metadata', objects: [{ nameSingular: 'person', namePlural: 'people', fields: [
    sel('leadSource', ['BELLWETHER', 'LEADGEN', 'FPA_EVENT'], { BELLWETHER: 'Bellwether', LEADGEN: 'Lead gen', FPA_EVENT: 'FPA event' }),
    sel('contactType', ['PROSPECT', 'CLIENTS', 'PARTNER']),
    sel('listCategory', ['COLD_BD', 'MONTHLY'], { COLD_BD: 'Cold BD', MONTHLY: 'Monthly' }),
    sel('pipelineStageField', ['PROSPECT', 'QUALIFY'], { PROSPECT: 'Prospect', QUALIFY: 'Qualify' }),
  ] }] };
}

const form = (values: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  return fd;
};
const RULES = { enabled: 'on', requireFirm: 'on', requireEmailOrPhone: 'on', requireOwnerLogin: 'on', requirePod: 'on', cleanupAutoCreated: 'on', moveBatchLimit: '50', undoDays: '365', retentionInactiveDays: '180', retentionUnworkedDays: '90', leadSource: 'BELLWETHER', leadSourceFallback: 'LEADGEN', contactType: ['PROSPECT'], listCategory: 'COLD_BD', pipelineStage: 'PROSPECT' };

/** The <section> of the card titled `title`, from a rendered page. */
function card(html: string, title: string): string {
  return html.split('<section').map((s) => `<section${s}`).find((s) => s.includes(`<h2 class="card-title">${title}</h2>`)) ?? '';
}

/** Every element in a tree a server component returned, without rendering it. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as ReactNode)];
}

describe('Settings > Cold outreach (S10, PLAN 4.7)', () => {
  let b: Basics;
  let ria: SessionUser;
  let alisa: SessionUser;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    ria = await sessionOf(b.users.ria.id);
    alisa = await sessionOf(b.users.alisa.id);
    vi.restoreAllMocks();
    auth.user.mockResolvedValue(ria);
    nav.redirect.mockClear();
  });

  it('B060: CRM values are selects filled from the CRM\'s own options; a typo is refused on save and never written', async () => {
    vi.spyOn(getMockTwentyClient(), 'introspect').mockResolvedValue(crmWithOptions());
    const choices = await crmValueChoices();
    expect(choices.why).toBeNull();
    expect(choices.fields.listCategory).toEqual({ fromCrm: true, options: [{ value: 'COLD_BD', label: 'Cold BD' }, { value: 'MONTHLY', label: 'Monthly' }] });
    expect(choices.fields.leadSource.options.map((o) => o.label)).toEqual(['Bellwether', 'Lead gen', 'FPA event']);

    const { saveSandboxSettingsAction } = await import('@/lib/actions/settings');
    // Before: any text was saved and written into the CRM on every move.
    expect(await saveSandboxSettingsAction(form({ ...RULES, pipelineStage: 'PROSPCT' }))).toEqual({ ok: false, error: 'Pipeline stage "PROSPCT" is not one of the CRM\'s options. Pick one from the list.' });
    expect(await saveSandboxSettingsAction(form({ ...RULES, contactType: ['PROSPECT', 'CLIENT'] }))).toEqual({ ok: false, error: expect.stringContaining('Contact type "CLIENT"') });
    expect((await getSettings()).sandbox.pipelineStage).toBe('PROSPECT');
    expect(await saveSandboxSettingsAction(form({ ...RULES, leadSource: 'FPA_EVENT', listCategory: 'MONTHLY', pipelineStage: 'QUALIFY', contactType: ['PROSPECT', 'PARTNER'] }))).toEqual({ ok: true, message: 'Cold outreach settings saved.' });
    invalidateSettingsCache();
    expect((await getSettings()).sandbox).toEqual(expect.objectContaining({ leadSource: 'FPA_EVENT', listCategory: 'MONTHLY', pipelineStage: 'QUALIFY', contactType: ['PROSPECT', 'PARTNER'] }));

    // The form: a select per value and a box per contact type, never a free-text box.
    const html = renderToStaticMarkup(createElement(ColdOutreachRulesForm, { s: (await getSettings()).sandbox, choices }));
    for (const name of ['leadSource', 'leadSourceFallback', 'listCategory', 'pipelineStage']) {
      expect(html).toContain(`<select name="${name}"`);
      expect(html).not.toContain(`<input name="${name}"`);
    }
    expect(html).toMatch(/name="contactType" checked="" value="PARTNER"/);
    expect(html).toMatch(/name="contactType" value="CLIENTS"\/><span>Client<\/span>/);

    // A value the CRM dropped since it was saved is named, and the page says what moves do meanwhile.
    const gone = crmValueIssues({ ...(await getSettings()).sandbox, pipelineStage: 'RETAIN' }, choices);
    expect(gone).toEqual(['Pipeline stage "Retain" is not an option in the CRM any more: moves write no pipeline stage until you pick one.']);
    expect(crmValueRefusal({ ...(await getSettings()).sandbox, pipelineStage: 'RETAIN' }, choices)).toMatch(/^Pipeline stage "RETAIN"/);
  });

  it('B060: when the CRM cannot say, the selects hold the values Cadence knows, and the page says so', async () => {
    const down = { introspect: async () => { throw new Error('ECONNREFUSED'); } } as unknown as TwentyClient;
    const choices = await crmValueChoices({ client: down });
    expect(choices.why).toBe('The CRM could not be reached');
    expect(choices.fields.pipelineStage).toEqual({ fromCrm: false, options: [{ value: 'PROSPECT', label: 'Prospect' }, { value: 'QUALIFY', label: 'Qualify' }, { value: 'RETAIN', label: 'Retain' }] });
    expect(choices.fields.leadSource.options.map((o) => o.value)).toEqual(expect.arrayContaining(['BELLWETHER', 'LEADGEN']));
    // The demo workspace lists no options either: still a select, never a text box.
    expect((await crmValueChoices()).why).toBe('The demo workspace lists no options');
    const html = renderToStaticMarkup(createElement(ColdOutreachRulesForm, { s: (await getSettings()).sandbox, choices }));
    expect(html).toContain('The CRM could not be reached, so these lists hold the values Cadence knows.');
    expect(crmValueRefusal({ ...(await getSettings()).sandbox, listCategory: 'COLD-BD' }, choices)).toBe('List category "COLD-BD" is not one Cadence knows. Pick one from the list.');
  });

  it('B213: selects show friendly names, and suppression kinds, reasons and sources read in words, every underscore', async () => {
    vi.spyOn(getMockTwentyClient(), 'introspect').mockResolvedValue(crmWithOptions());
    expect(suppressionWords({ kind: 'phone_subject', reason: 'do_not_contact', source: 'call_form' })).toEqual({ kind: 'Shared line, for one person only', reason: 'Do not contact', source: 'Post-call form' });
    expect(suppressionWords({ kind: 'individual_crd', reason: 'opted_out', source: null })).toEqual({ kind: 'Individual CRD', reason: 'Opted out', source: null });
    expect(codeWords('a_new_kind_of_reason')).toBe('A new kind of reason');
    await prisma.suppression.create({ data: { kind: 'email', valueHash: 'h1', label: 'j***@acme.com', reason: 'do_not_contact', source: 'bellwether' } });
    await prisma.suppression.create({ data: { kind: 'phone_subject', valueHash: 'h2', label: '+1 *** *** 0123', reason: 'opted_out', source: 'call_form', subjectId: 'c1' } });
    const html = renderToStaticMarkup(createElement(ColdOutreachSettings, { data: await loadColdOutreachSettings({ full: true }), canEdit: true, timezone: 'UTC' }));
    const list = card(html, 'Suppression list');
    expect(list).toContain('<th class="px-4 py-2 font-normal">Why</th>');
    expect(list).toContain('Do not contact');
    expect(list).toContain('Shared line, for one person only');
    expect(list).toContain('Post-call form');
    expect(list).not.toMatch(/do not_contact|do_not_contact|phone_subject|call_form/);
    // Friendly names in the selects: the constant is the value, never the words.
    expect(card(html, 'Rules')).toMatch(/<option value="COLD_BD"( selected="")?>Cold BD<\/option>/);
    // Counts are plural only when they are.
    expect(card(html, 'CRM cleanup')).toContain('0 people · 0 in the last 7 days');
  });

  it('B168: the nightly CRM check records every run; Run now runs it, says what it found, and a second run waits', async () => {
    await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    expect(await lastCrmCheck()).toBeNull();
    const night = await runCrmCheck({ by: 'nightly', client: null });
    expect(night).toEqual({ ran: true, stats: { checked: 1, flagged: 0, cleared: 0, asked: false } });
    expect(await lastCrmCheck()).toEqual(expect.objectContaining({ by: 'nightly', error: null, stats: { checked: 1, flagged: 0, cleared: 0, asked: false } }));

    const { runCrmCheckNowAction } = await import('@/lib/actions/settings');
    expect(await runCrmCheckNowAction()).toEqual({ ok: true, message: 'Checked 1 contact: 0 contacts newly found in the CRM.' });
    expect(await lastCrmCheck()).toEqual(expect.objectContaining({ by: ria.name }));
    // Only admins run it.
    auth.user.mockResolvedValue(alisa);
    await expect(runCrmCheckNowAction()).rejects.toThrow('Admin only.');
    auth.user.mockResolvedValue(ria);

    // One run at a time: a live lease answers in words instead of racing it.
    await prisma.setting.create({ data: { key: 'coldOutreachCrmCheck.lease', value: { token: 'other', until: new Date(Date.now() + 60_000).toISOString() } } });
    expect(await runCrmCheck({ by: 'nightly', client: null })).toEqual({ ran: false, busy: true, error: CRM_CHECK_RUNNING });
    expect(await runCrmCheckNowAction()).toEqual({ ok: false, error: CRM_CHECK_RUNNING });

    // A failed run is recorded and shown.
    await prisma.setting.delete({ where: { key: 'coldOutreachCrmCheck.lease' } });
    vi.spyOn(prisma.sandboxContact, 'findMany').mockRejectedValueOnce(new Error('The database went away'));
    expect(await runCrmCheck({ by: 'nightly', client: null })).toEqual({ ran: true, error: 'The database went away' });
    await prisma.setting.create({ data: { key: 'nightlyRanOn', value: { day: '2026-11-01', at: '2026-11-01T08:00:00.000Z' } } });
    const html = renderToStaticMarkup(createElement(ColdOutreachSettings, { data: await loadColdOutreachSettings({ full: true }), canEdit: true, timezone: 'UTC' }));
    const check = card(html, 'Nightly CRM check');
    expect(check).toContain('Run now');
    expect(check).toContain('Failed');
    expect(check).toContain('The database went away. It runs again tonight.');
    expect(check).toContain('Late');
  });

  it('B168: retention is shown read only from the nightly forecast: when, how many, the next date, Move to CRM needed, removed last night, the warning period; no switch and no Run now', async () => {
    const at = new Date('2027-01-28T08:00:00Z');
    const item = (id: string, dueOn: string) => ({ id, ownerId: b.users.alisa.id, podId: b.pods.Alisa.id, dueOn, basis: 'inactive', lastActivityAt: '2026-08-01T00:00:00.000Z' });
    await prisma.setting.create({ data: { key: RETENTION_FORECAST_KEY, value: { at: at.toISOString(), horizonDays: 30, total: 4, items: [item('a', '2027-01-29'), item('b', '2027-02-01'), item('c', '2027-02-01'), item('d', '2027-02-20')], moveToCrmNeeded: { count: 2, ids: ['x', 'y'] }, removedTonight: 3 } } });
    const data = await loadColdOutreachSettings({ full: true });
    expect(data.retention).toEqual(expect.objectContaining({ total: 4, next: { on: '2027-01-29', count: 1 }, atNextRun: 1, warned: 3, warnDays: 7, moveToCrmNeeded: 2, removedLastRun: 3, inactiveDays: 180, unworkedDays: 90 }));
    const html = renderToStaticMarkup(createElement(ColdOutreachSettings, { data, canEdit: true, timezone: 'UTC' }));
    const retention = card(html, 'Retention');
    expect(retention).toContain('Always on, and nobody needs to do anything.');
    expect(retention).toContain('4 contacts would be removed');
    expect(retention).toContain('1 contact on Fri, 29 Jan 2027');
    expect(retention).toContain('will be removed tonight');
    expect(retention).toContain('Owners are told 7 days ahead: 3 contacts due within that time.');
    expect(retention).toContain('2 contacts: Move to CRM needed');
    expect(retention).toContain('3 contacts');
    expect(retention).not.toMatch(/<button|<input|<form|Run now|Paused|Pause/);

    // Before the first nightly run: it says so, and still offers nothing to press.
    await prisma.setting.delete({ where: { key: RETENTION_FORECAST_KEY } });
    const empty = card(renderToStaticMarkup(createElement(ColdOutreachSettings, { data: await loadColdOutreachSettings({ full: true }), canEdit: true, timezone: 'UTC' })), 'Retention');
    expect(empty).toContain('Not yet: the first nightly run records it');
    expect(empty).not.toMatch(/<button/);
  });

  it('PLAN 4.7: Bellwether\'s connection: the key, the last push, pushes cut off or stuck, and contacts Cadence failed on in the last 7 days', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 20 * 60_000);
    const done = await prisma.bellwetherPush.create({ data: { idempotencyKey: 'k1', bodyHash: 'h', state: 'DONE', pushedByEmail: 'alisa@cadence.local', contactCount: 2, createdAt: new Date(now.getTime() - 5 * 60_000) } });
    await prisma.bellwetherPush.create({ data: { idempotencyKey: 'k2', bodyHash: 'h', state: 'PROCESSING', pushedByEmail: 'alisa@cadence.local', contactCount: 1, createdAt: old } });
    await prisma.bellwetherPush.create({ data: { idempotencyKey: 'k3', bodyHash: 'h', state: 'FAILED', pushedByEmail: 'alisa@cadence.local', contactCount: 1, createdAt: old } });
    await prisma.bellwetherPushItem.create({ data: { pushId: done.id, bellwetherContactId: 'bw-1', result: 'rejected', reason: 'internal_error' } });
    await prisma.auditLog.create({ data: { entityType: 'bellwether', entityId: 'p', action: 'push_swept', actorType: 'SYSTEM', actorLabel: 'Cadence' } });
    const data = await loadColdOutreachSettings({ full: true }, now);
    expect(data.bellwether).toEqual(expect.objectContaining({ enabled: true, lastPush: { at: done.createdAt, by: b.users.alisa.name }, stuck: 1, failed: 1, week: { pushes: 3, contacts: 0, cutOff: 1, internalErrors: 1 } }));
    const html = card(renderToStaticMarkup(createElement(ColdOutreachSettings, { data, canEdit: true, timezone: 'UTC' })), 'Bellwether');
    expect(html).toContain('3 pushes · 0 contacts added');
    expect(html).toContain('Stuck now');
    expect(html).toContain('1 push not sent again yet.');
    expect(html).toContain('1 contact');
  });

  it('B215: a non-admin opening Settings > Cold outreach reads it, told who can change it, and is never sent to Tasks', async () => {
    const keys = ['twenty', 'rules', 'users', 'cold-outreach', 'activity'];
    expect(COLD_OUTREACH_SETTINGS_HREF).toBe('/settings?tab=cold-outreach');
    expect(settingsRoute('cold-outreach', false, keys)).toEqual({ tab: 'cold-outreach' });
    expect(settingsRoute('users', false, keys)).toEqual({ redirect: '/settings?tab=cold-outreach' });
    expect(settingsRoute(undefined, false, keys)).toEqual({ redirect: '/settings?tab=cold-outreach' });

    const { default: SettingsPage } = await import('@/app/(app)/settings/page');
    auth.user.mockResolvedValue(alisa);
    const page = await SettingsPage({ searchParams: Promise.resolve({ tab: 'cold-outreach' }) });
    expect(nav.redirect).not.toHaveBeenCalled();
    const tab = elements(page).find((e) => typeof e.type === 'function' && e.type.name === 'ColdOutreachTab');
    expect(tab?.props).toEqual(expect.objectContaining({ admin: false }));
    await expect(SettingsPage({ searchParams: Promise.resolve({ tab: 'users' }) })).rejects.toThrow('REDIRECT /settings?tab=cold-outreach');
    expect(nav.redirect).not.toHaveBeenCalledWith('/tasks');

    // What they read: the rules in words, who can change them, nothing to press, no suppression list.
    vi.spyOn(getMockTwentyClient(), 'introspect').mockRejectedValue(new Error('a reader never asks the CRM'));
    await prisma.suppression.create({ data: { kind: 'email', valueHash: 'h1', label: 'j***@acme.com', reason: 'do_not_contact' } });
    const data = await loadColdOutreachSettings({ full: false });
    expect(data.choices).toBeNull();
    expect(data.suppressions).toEqual({ total: 1, rows: [] });
    const html = renderToStaticMarkup(createElement(ColdOutreachSettings, { data, canEdit: false, timezone: 'UTC' }));
    expect(html).toContain(`Read only. Only an admin (${b.users.ria.name}) can change Cold outreach settings`);
    expect(html).toContain('Bellwether (else Lead gen)');
    expect(html).toContain('Cold BD');
    expect(html).not.toMatch(/<form|<button|<select|Run now|Clean up now|j\*\*\*@acme\.com/);
    // And the server refuses them anyway.
    const { saveSandboxSettingsAction } = await import('@/lib/actions/settings');
    await expect(saveSandboxSettingsAction(form(RULES))).rejects.toThrow('Admin only.');
  });

  it('N062: the Undo window says it applies to new moves only; existing moves keep their deadline', async () => {
    const s = (await getSettings()).sandbox;
    const note = 'Applies to new moves only; existing moves keep their deadline.';
    expect(renderToStaticMarkup(createElement(ColdOutreachRulesForm, { s, choices: await crmValueChoices() }))).toContain(note);
    expect(renderToStaticMarkup(createElement(ColdOutreachSettings, { data: await loadColdOutreachSettings({ full: false }), canEdit: false, timezone: 'UTC' }))).toContain(note);
  });

  it('the Settings tab says "Cold outreach" and "CRM", and the old ?tab=sandbox still opens Cold outreach', async () => {
    const { default: SettingsPage } = await import('@/app/(app)/settings/page');
    await expect(SettingsPage({ searchParams: Promise.resolve({ tab: 'sandbox' }) })).rejects.toThrow('REDIRECT /settings?tab=cold-outreach');
    const page = await SettingsPage({ searchParams: Promise.resolve({ tab: 'cold-outreach' }) });
    const tabs = elements(page).find((e) => Array.isArray(e.props.tabs))?.props.tabs as { key: string; label: string }[];
    expect(tabs.map((t) => t.label)).toEqual(expect.arrayContaining(['CRM', 'Cold outreach']));
    expect(tabs.map((t) => t.label).join(' ')).not.toMatch(/Twenty|Sandbox/);
    expect(elements(page).find((e) => typeof e.type === 'function' && e.type.name === 'ColdOutreachTab')?.props).toEqual(expect.objectContaining({ admin: true }));
  });

  it('PLAN 8.8: Team > Remove access lists everything the leaver holds, each with where it goes, and needs a taker whenever any of it does', () => {
    const work = { contacts: 12, coldNextSteps: 2, crmNextActions: 1, meetings: 1, enrollments: 4, forms: 1, callerNumber: '+13125550100' };
    const all = removeAccessConfirm('Nora Lane', work);
    expect(all.title).toBe('Remove access for Nora Lane?');
    expect(all.effects).toEqual([
      'Nora Lane is signed out and can no longer sign in. Their history stays.',
      '12 cold contacts go to whoever takes over, with their campaigns and next steps. A contact in a pod that person is not in waits for the pod\'s leaders under "Needs a new owner".',
      '3 open next steps (1 meeting) go to them. The CRM ones are updated in the CRM too.',
      '4 live campaign enrollments and their pending steps go to them.',
      '1 call form waiting go to them to fill in; the calls stay Nora Lane\'s.',
      'Their calling number, +13125550100, is let go or moved to them, as you choose below.',
    ]);
    expect(all).toEqual(expect.objectContaining({ needsTaker: true, tone: 'danger', confirmLabel: 'Remove access' }));
    // Only a calling number: no taker unless it is moved (the dialog asks).
    expect(removeAccessConfirm('Nora Lane', { ...work, contacts: 0, coldNextSteps: 0, crmNextActions: 0, meetings: 0, enrollments: 0, forms: 0 }).needsTaker).toBe(false);
    expect(removeAccessConfirm('Sam Ho', null)).toEqual(expect.objectContaining({ needsTaker: false, effects: ['Sam Ho is signed out and can no longer sign in. Their history stays.', 'Sam Ho holds no open work.'] }));
    // The dialog is the one ConfirmDialog, no longer an inline form.
    const panel = fs.readFileSync(path.join(process.cwd(), 'src/components/settings/users-panel.tsx'), 'utf8');
    expect(panel).toMatch(/<ConfirmDialog \{\.\.\.confirm\}/);
    expect(panel).not.toMatch(/<ActionForm action=\{setUserAccessAction\}/);
  });

  it('ConfirmDialog: the confirms that were sentences have a short title and name every effect', () => {
    const all = [
      stopCampaignConfirm({ name: 'Q4 Harbor', restartable: true }), stopCampaignConfirm(), exitEnrollmentConfirm({ name: 'Jane Doe', campaign: 'Q4 Harbor' }), exitEnrollmentConfirm(),
      deleteMeetingConfirm({ title: 'Intro call', inCrm: true }), fullRefreshConfirm(), removePodConfirm('Pod Alisa'), blockAccountConfirm('Acme'), unblockAccountConfirm('Acme'),
    ];
    for (const c of all) {
      expect(c.title.length).toBeLessThan(70);
      expect(c.title.endsWith('?')).toBe(true);
      expect(c.effects?.length).toBeGreaterThan(0);
    }
    expect(stopCampaignConfirm({ name: 'Q4 Harbor', restartable: true })).toEqual(expect.objectContaining({ title: 'Stop Q4 Harbor?', tone: 'danger', effects: ['Everyone still in it leaves it, marked "Campaign stopped".', 'Every open step is cancelled. Steps mirrored as tasks in the CRM are closed there too.', 'It cannot be resumed; you can restart it from the beginning later.'] }));
    expect(exitEnrollmentConfirm({ name: 'Jane Doe', campaign: 'Q4 Harbor' }).title).toBe('Take Jane Doe out of Q4 Harbor?');
    expect(deleteMeetingConfirm({ title: 'Intro call', inCrm: true }).effects).toContain('Its record in the CRM is deleted too.');
    expect(deleteMeetingConfirm({ title: null, inCrm: false }).effects).not.toContain('Its record in the CRM is deleted too.');
    expect(JSON.stringify(all)).not.toMatch(/twenty|sandbox/i);
    // No ActionButton or ActionForm is handed a bare sentence any more (the prop takes ConfirmOptions only).
    const src = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? src(path.join(dir, e.name)) : /\.tsx$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const sentences = src(path.join(process.cwd(), 'src')).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => /confirm="|confirm=\{`/.test(l) && !l.includes('UndoMoveButton')).map((l) => `${path.relative(process.cwd(), f)}: ${l.trim().slice(0, 80)}`));
    expect(sentences).toEqual([]);
  });

  it('Settings never says "Twenty" or "sandbox" to a user: tab, cards, buttons, messages and the Activity log', async () => {
    // Prose in the Settings screens and the messages their actions return: strings and JSX text with a space in them.
    const files = ['src/app/(app)/settings/page.tsx', ...fs.readdirSync('src/components/settings').map((f) => `src/components/settings/${f}`), 'src/components/action-form.tsx', 'src/lib/actions/settings.ts', 'src/lib/actions/admin.ts', 'src/lib/event-results.ts', 'src/lib/confirms.ts', 'src/lib/sandbox/cold-settings.ts', 'src/lib/settings-tabs.ts'];
    const prose = files.flatMap((f) => {
      const code = fs.readFileSync(path.join(process.cwd(), f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^import .*$/gm, '');
      const strings = code.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`|>[^<>{}]+</g) ?? [];
      // Case matters: `/api/webhooks/twenty` and `settings.sandbox` are code, "Twenty" and "Sandbox" are words.
      return strings.filter((t) => / /.test(t) && /\bTwenty\b|\bSandbox\b|\bthe sandbox\b|\bsandbox contact/.test(t)).map((t) => `${f}: ${t.slice(0, 90)}`);
    });
    expect(prose).toEqual([]);
    expect(describeEventResult('twenty_task_done_completed')).toBe('Closed from the CRM');
    expect(describeEventResult('person_deleted')).toBe('Contact deleted in the CRM');
    // The whole Cold outreach tab, as an admin and as a reader.
    for (const full of [true, false]) {
      const html = renderToStaticMarkup(createElement(ColdOutreachSettings, { data: await loadColdOutreachSettings({ full }), canEdit: full, timezone: 'UTC' }));
      expect(html.replace(/(href|name|action)="[^"]*"/g, '')).not.toMatch(/twenty|sandbox/i);
    }
  });
});
