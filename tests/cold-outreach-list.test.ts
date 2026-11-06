import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { userActor } from '@/lib/audit';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';
import { sessionOf } from './helpers/cold-campaign';

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const nav = vi.hoisted(() => ({ search: '' }));
// A dialog draws its contents in place here (the real one portals into the open page).
vi.mock('@/components/modal', () => ({ Modal: ({ children }: { children: unknown }) => children }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => '/cold-outreach', useSearchParams: () => new URLSearchParams(nav.search) }));

const { listContacts, LIST_PAGE, phoneDigits } = await import('@/lib/sandbox/query');
const { flashHref, listHref, ownerPatch, resolveListParams, scopeFor, viewHref } = await import('@/lib/sandbox/list-view');
const { repPath } = await import('@/lib/sandbox/path');
const { createContact } = await import('@/lib/sandbox/contacts');
const { countryOfPhone, displayName } = await import('@/lib/sandbox/normalize');
const { assignContactsAction, claimContactsAction, createContactAction, setNextStepsAction } = await import('@/lib/actions/sandbox');
const { PeopleTable, shownSelection } = await import('@/components/people/people-table');
const { PeopleToolbar } = await import('@/components/people/people-toolbar');
const { ColdBulkActions } = await import('@/components/sandbox/cold-bulk-actions');
const { AddContactButton, AddContactDialog, refusalWords } = await import('@/components/sandbox/add-contact');
const { keptListUrl } = await import('@/components/sandbox/list-link');
const { TaskFlash } = await import('@/components/tasks/task-flash');

const draw = (el: unknown, props: Record<string, unknown>) => renderToStaticMarkup(createElement(el as never, props as never));
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const bulk = { owners: [], pods: [], today: '2026-11-06', workingDays: [1, 2, 3, 4, 5] };

/**
 * Stage S10: the Cold outreach contacts list (PLAN 4.1) and the manager's pod views (4.8). One test
 * per bug id, named after it.
 */
describe('Cold outreach: the contacts list (S10)', () => {
  let b: Basics;
  let alisa: SessionUser, karson: SessionUser, ria: SessionUser;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    [alisa, karson, ria] = await Promise.all([sessionOf(b.users.alisa.id), sessionOf(b.users.karson.id), sessionOf(b.users.ria.id)]);
    nav.search = '';
  });

  /** A Sales Leader of Alisa's pod: leaders open on their pod (N081). */
  async function leader() {
    const u = await prisma.user.create({ data: { email: 'pam@cadence.local', name: 'Pam Leader', role: 'SALES_LEADER', passwordHash: 'x', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    return sessionOf(u.id);
  }

  it('B055: a search is a phone number only at 7 or more digits, and a pasted Bellwether id or CRD finds its contact', async () => {
    const jane = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Okafor', email: 'jane@okafor-wealth.com', phone: '+13125550123', bellwetherContactId: '105943:i:777', individualCrd: '4455667' });
    // Many numbers share a short run of digits; none of them may match "555" or "1".
    for (let i = 0; i < 5; i++) await readyContact(b.users.alisa.id, b.pods.Alisa.id, { lastName: `Rivera${'abcde'[i]}`, email: `sam.${'abcde'[i]}@rivera-wealth.com`, phone: `+1312555${String(i).padStart(4, '0')}` });
    expect(phoneDigits('555')).toBeNull();
    expect(phoneDigits('(312) 555-0123')).toBe('3125550123');
    expect((await listContacts(alisa, { q: '555' })).total).toBe(0);
    expect((await listContacts(alisa, { q: '1' })).total).toBe(0);
    for (const q of ['3125550123', '(312) 555-0123', '312 555 0123', '+1 312 555 0123', '105943:i:777', '4455667']) expect(ids((await listContacts(alisa, { q })).rows), q).toEqual([jane.id]);
  });

  it('B206: search ignores accents, both in what is typed and in what is stored', async () => {
    const muller = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jürgen', lastName: 'Müller', companyName: 'Société Générale Privée' });
    const plain = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Anna', lastName: 'Muller' });
    expect(ids((await listContacts(alisa, { q: 'muller' })).rows)).toEqual(ids([muller, plain]));
    expect(ids((await listContacts(alisa, { q: 'Müller' })).rows)).toEqual(ids([muller, plain]));
    expect(ids((await listContacts(alisa, { q: 'jurgen' })).rows)).toEqual([muller.id]);
    expect(ids((await listContacts(alisa, { q: 'societe generale' })).rows)).toEqual([muller.id]);
    expect(ids((await listContacts(alisa, { q: 'SOCIÉTÉ' })).rows)).toEqual([muller.id]);
  });

  it('N085: a Chinese, Japanese or Korean name is found in either order, with or without a space, and shown family name first', async () => {
    const wang = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: '小明', lastName: '王', sortName: '王 小明' });
    const kim = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: '민준', lastName: '김' });
    for (const q of ['王小明', '小明王', '王 小明', '小明 王']) expect(ids((await listContacts(alisa, { q })).rows), q).toEqual([wang.id]);
    expect(ids((await listContacts(alisa, { q: '김민준' })).rows)).toEqual([kim.id]);
    expect((await listContacts(alisa, { q: '王小明' })).rows[0].name).toBe('王小明');
    expect(displayName('Jane', 'Doe')).toBe('Jane Doe');
  });

  it('N079: search covers every status and owner from the list, with a status badge on each; an empty result says which filter hides matches', async () => {
    const live = await readyContact(b.users.karson.id, b.pods.Alisa.id, { firstName: 'Grace', lastName: 'Hopper' });
    const moved = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Grace', lastName: 'Kelly', status: 'MOVED', movedAt: new Date() });
    const opted = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Grace', lastName: 'Jones', status: 'OPTED_OUT', optedOutAt: new Date('2026-11-03T12:00:00Z') });
    const found = await listContacts(alisa, { q: 'grace' });
    expect(found.params.view).toBe('any');
    expect(ids(found.rows)).toEqual(ids([live, moved, opted]));
    expect(found.rows.find((r) => r.id === opted.id)!.badge).toEqual(expect.objectContaining({ label: 'Do not contact · 3 Nov 2026', tone: 'red' }));
    expect(found.rows.find((r) => r.id === moved.id)!.badge.label).toBe('In CRM · Open');
    // Alisa chose her own contacts: Grace Hopper is Karson's, so the empty list says so and offers every owner.
    const mine = await listContacts(alisa, { q: 'hopper', view: 'mine' });
    expect(mine.rows).toEqual([]);
    expect(mine.empty!.hints).toEqual([expect.objectContaining({ words: '1 match with another status.', label: 'Search every status' })]);
    const noNext = await listContacts(alisa, { q: 'hopper', view: 'no_next_step' });
    expect(noNext.empty!.hints).toEqual(expect.arrayContaining([expect.objectContaining({ words: 'None of yours; 1 match with any owner.', label: 'Show every owner', href: '/cold-outreach?view=no_next_step&q=hopper&owner=' })]));
    expect((await listContacts(alisa, { q: 'nobody-at-all' })).empty).toEqual(expect.objectContaining({ title: 'Nothing matches “nobody-at-all”', hints: [] }));
  });

  it('B207: a value the list does not know is ignored, never a crash', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    for (const sp of [{ source: 'nonsense' }, { owner: 'not-a-user' }, { pod: 'no-such-pod' }, { view: 'everything!' }, { page: 'abc' }, { status: 'gone' }, { source: ['BELLWETHER', 'MANUAL'] }]) {
      const list = await listContacts(ria, sp);
      expect(ids(list.rows), JSON.stringify(sp)).toEqual([c.id]);
    }
    // A lower-case source is still that source.
    expect((await listContacts(ria, { source: 'bellwether' })).params.source).toBe('BELLWETHER');
    expect((await listContacts(ria, { source: 'manual' })).total).toBe(0);
  });

  it('B209: the list pages in the database and loads what the table shows for one page only', async () => {
    for (let i = 0; i < LIST_PAGE + 5; i++) await readyContact(b.users.alisa.id, b.pods.Alisa.id, { lastName: `Zed${String(i).padStart(3, '0')}`, sortName: `zed${String(i).padStart(3, '0')} sam` });
    const spy = vi.spyOn(prisma.sandboxContact, 'findMany');
    const first = await listContacts(ria, { view: 'all' });
    expect([first.total, first.pages, first.rows.length]).toEqual([LIST_PAGE + 5, 2, LIST_PAGE]);
    // Only the page's own contacts are read with their calls and campaigns.
    const withRelations = spy.mock.calls.filter(([args]) => (args as { select?: { calls?: unknown } })?.select?.calls);
    expect(withRelations).toHaveLength(1);
    expect((withRelations[0][0] as { where: { id: { in: string[] } } }).where.id.in).toHaveLength(LIST_PAGE);
    spy.mockRestore();
    const second = await listContacts(ria, { view: 'all', page: '2' });
    expect(second.rows.map((r) => r.name)).toEqual(['Sam Zed050', 'Sam Zed051', 'Sam Zed052', 'Sam Zed053', 'Sam Zed054']);
    // A page past the end shows the last one.
    expect((await listContacts(ria, { view: 'all', page: '9' })).page).toBe(2);
  });

  it('B056: the selection keeps only rows on screen, and another page or other filters start a fresh table', async () => {
    const selected = new Set(['a', 'b', 'c']);
    expect([...shownSelection(selected, [{ id: 'b' }, { id: 'z' }])]).toEqual(['b']);
    expect(shownSelection(selected, [{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe(selected);
    // The page keys the table by its address without the flash: a page or a filter change remounts it, a result does not.
    const ctx = { role: 'rep' as const, userId: 'u', ownerIds: new Set<string>(), podIds: new Set<string>(), myPodIds: [] };
    const key = (sp: Record<string, string>) => { const p = resolveListParams(sp, ctx); return listHref(p, { page: String(p.page) }); };
    expect(key({ view: 'all', page: '1' })).not.toBe(key({ view: 'all', page: '2' }));
    expect(key({ view: 'all' })).not.toBe(key({ view: 'all', q: 'jane' }));
    expect(key({ view: 'all', source: 'BELLWETHER' })).not.toBe(key({ view: 'all' }));
    expect(key({ view: 'all', flash: 'Claimed 2.' })).toBe(key({ view: 'all' }));
  });

  it('B118: the server says what each row allows; a Junior FO gets checkboxes and actions only for what he may do', async () => {
    const own = await readyContact(b.users.karson.id, b.pods.Alisa.id, { lastName: 'Aaa' });
    const hers = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { lastName: 'Bbb' });
    const list = await listContacts(karson, { view: 'all' });
    const row = (id: string) => list.rows.find((r) => r.id === id)!;
    expect(row(own.id).allows).toEqual(expect.objectContaining({ move: true, remove: true, next_step: true, enroll: true, claim: 'Yours already', assign: 'You cannot give contacts to someone else.' }));
    expect(row(hers.id).allows).toEqual(expect.objectContaining({ move: 'Only Alisa Marsh, the Senior FOs, Sales Leaders and Pod Managers of Pod Alisa, and admins can move this contact.', next_step: expect.stringContaining("This is Alisa Marsh's contact. Ask Alisa Marsh or your pod leader."), claim: 'Alisa Marsh owns this contact.' }));
    const html = draw(PeopleTable, { variant: 'cold', rows: list.rows, canSelect: true, bulk });
    expect(html).toMatch(new RegExp(`<input type="checkbox" disabled=""[^>]*aria-label="Select ${row(hers.id).name}"`));
    expect(html).toContain(`<input type="checkbox" aria-label="Select ${row(own.id).name}"/>`);
    // Biz Ops reads only: no checkboxes at all.
    expect(draw(PeopleTable, { variant: 'cold', rows: list.rows, canSelect: false, bulk })).not.toContain('type="checkbox"');
  });

  it('B151: the bulk bar offers only the actions that fit, says how many it acts on ("Move 1 of 3"), and why the others are left out', async () => {
    const live = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { lastName: 'Aaa' });
    const moved = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { lastName: 'Bbb', status: 'MOVED', movedAt: new Date() });
    const removed = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: '', lastName: '', sortName: null, status: 'REMOVED' });
    const rows = (await listContacts(alisa, { view: 'any', q: '' })).rows;
    const pick = rows.filter((r) => [live.id, moved.id, removed.id].includes(r.id));
    expect(pick).toHaveLength(3);
    for (const r of pick.filter((x) => x.id !== live.id)) expect(Object.values(r.allows).every((v) => v !== true)).toBe(true);
    const html = draw(ColdBulkActions, { rows: pick, ...bulk, onDone: () => {} });
    expect(html).toContain('Move 1 of 3 to CRM');
    expect(html).toContain('Move to CRM leaves out 2: In the CRM already; Removed.');
    expect(html).not.toContain('>Claim');
    // One live contact of hers: every action fits, with plain labels.
    const one = draw(ColdBulkActions, { rows: pick.filter((r) => r.id === live.id), ...bulk, onDone: () => {} });
    expect(one).toContain('>Move to CRM<');
    expect(one).not.toContain('leaves out');
  });

  it('B152: one filter row that applies as it changes: search, Owner, Pod and Source, no Apply button, the filters in force as chips', async () => {
    const list = await listContacts(karson, { view: 'no_next_step' });
    const html = draw(PeopleToolbar, { variant: 'cold', q: '', view: list.params.view, owner: 'mine', pod: '', source: '', owners: list.owners, pods: list.pods, myPodIds: list.myPodIds, offersMine: true, offersNeedsOwner: false, chips: list.chips });
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Apply');
    for (const label of ['Search contacts', 'Filter by owner', 'Filter by pod', 'Filter by source']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('Owner: you');
    expect(html).toContain('href="/cold-outreach?view=no_next_step&amp;owner="');
  });

  it('B153: the table reads like People: names and firms wrap instead of being cut off, the source date is on hover, and empty columns hide', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Alexandra', lastName: 'Montgomery-Wolstenholme', jobTitle: 'Senior Vice President, Private Wealth', companyName: 'Rivera Wealth Partners of Greater Chicago', pushedByName: 'Andrew' });
    const rows = (await listContacts(alisa, { view: 'all' })).rows;
    const html = draw(PeopleTable, { variant: 'cold', rows, canSelect: true, bulk });
    expect(html).toContain('class="block text-[13px] font-semibold leading-5 text-ink-900 hover:text-brand-700 break-words"');
    expect(html).not.toContain('max-w-[22rem] truncate');
    expect(html).toContain('Senior Vice President, Private Wealth · Rivera Wealth Partners of Greater Chicago');
    expect(html).toMatch(new RegExp(`title="Sent from Bellwether by Andrew on \\d+ \\w+ \\d{4}">Bellwether<`));
    // Nobody has a next step or a call yet: those columns hide; Name, Owner, Status and Source stay.
    expect(html).not.toContain('<th>Next</th>');
    expect(html).not.toContain('<th>Last call</th>');
    expect(html).toContain('<th>Owner</th>');
    expect(rows.find((r) => r.id === c.id)!.sub).toBe('Senior Vice President, Private Wealth · Rivera Wealth Partners of Greater Chicago');
    // An empty view has words and a way on.
    const empty = await listContacts(alisa, { view: 'closed' });
    expect(empty.empty).toEqual(expect.objectContaining({ title: 'No closed contacts', hint: expect.stringContaining('Not interested') }));
  });

  it('B163: the No next step view lists the reader\'s live contacts with no campaign and no next step, as the step strip counts them', async () => {
    const bare = await readyContact(b.users.karson.id, b.pods.Alisa.id, { lastName: 'Bare' });
    const stepped = await readyContact(b.users.karson.id, b.pods.Alisa.id, { lastName: 'Stepped' });
    await prisma.nextAction.create({ data: { sandboxContactId: stepped.id, foUserId: b.users.karson.id, label: 'Call back', action: 'CALL', dueDate: '2026-11-20', audience: 'SANDBOX' } });
    const closed = await readyContact(b.users.karson.id, b.pods.Alisa.id, { lastName: 'Closed', lastOutcome: 'not_interested', lastOutcomeAt: new Date() });
    const scheduled = await readyContact(b.users.karson.id, b.pods.Alisa.id, { lastName: 'Scheduled' });
    await prisma.campaign.create({ data: { name: 'Q4 Harbor', audience: 'SANDBOX', status: 'SCHEDULED', podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-20', createdById: b.users.alisa.id, personIds: [scheduled.id] } });
    await readyContact(b.users.alisa.id, b.pods.Alisa.id, { lastName: 'Hers' });
    const list = await listContacts(karson, { view: 'no_next_step' });
    expect(ids(list.rows)).toEqual([bare.id]);
    expect(list.rows[0].badge).toEqual(expect.objectContaining({ label: 'No next step', tone: 'amber' }));
    expect(list.chips).toEqual([expect.objectContaining({ key: 'owner', label: 'Owner: you', isDefault: true })]);
    // The step strip's "with no next step" and its link agree with the view.
    const path = await repPath(karson);
    expect(path.steps.find((s) => s.key === 'next')!.count).toBe(list.total);
    expect(list.tabs.find((t) => t.view === 'no_next_step')!.count).toBe(1);
    expect((await listContacts(karson, { view: 'closed' })).rows.map((r) => r.id)).toEqual([closed.id]);
  });

  it('PLAN 4.1: the quick views count what each holds and agree with the step strip', async () => {
    await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null });
    await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null });
    await readyContact(b.users.leigh.id, b.pods.Leigh.id, { ownerId: null });
    await readyContact(b.users.karson.id, b.pods.Alisa.id);
    await readyContact(b.users.karson.id, b.pods.Alisa.id, { crmMatchPersonId: 'person-01' });
    await readyContact(b.users.karson.id, b.pods.Alisa.id, { status: 'MOVED', movedAt: new Date() });
    await readyContact(b.users.karson.id, b.pods.Alisa.id, { status: 'OPTED_OUT', optedOutAt: new Date() });
    const list = await listContacts(karson, {});
    expect(list.params.view).toBe('mine');
    const count = Object.fromEntries(list.tabs.map((t) => [t.view, t.count]));
    expect(count).toEqual({ mine: 2, no_next_step: 1, unclaimed: 2, ready: 0, in_crm: 1, closed: 0, all: 5, moved: 1, dnc_removed: 1 });
    const path = await repPath(karson);
    expect(path.steps.find((s) => s.key === 'claim')!.count).toBe(count.unclaimed);
    expect(path.steps.find((s) => s.key === 'move')!.count).toBe(count.ready);
    // The strip's link opens the same view, with the reader's pods as a chip they can remove.
    const unclaimed = await listContacts(karson, { view: 'unclaimed' });
    expect(unclaimed.total).toBe(2);
    expect(unclaimed.chips).toEqual([expect.objectContaining({ key: 'pod', label: 'Pod: Pod Alisa', isDefault: true, href: '/cold-outreach?view=unclaimed&pod=' })]);
    expect((await listContacts(karson, { view: 'unclaimed', pod: '' })).total).toBe(3);
    // Admins own nothing: no Mine view.
    expect((await listContacts(ria, {})).tabs.map((t) => t.view)).not.toContain('mine');
  });

  it('N081: reps open on Mine, Sales Leaders on their pod, admins on everyone, and the defaults show as chips that can be removed', async () => {
    const pam = await leader();
    await readyContact(b.users.karson.id, b.pods.Alisa.id);
    await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await readyContact(b.users.leigh.id, b.pods.Leigh.id);
    const rep = await listContacts(karson, {});
    expect([rep.params.view, rep.total, rep.chips.length]).toEqual(['mine', 1, 0]);
    const lead = await listContacts(pam, {});
    expect([lead.params.view, lead.total]).toEqual(['all', 2]);
    expect(lead.chips).toEqual([expect.objectContaining({ key: 'pod', label: 'Pod: Pod Alisa', isDefault: true, href: '/cold-outreach?pod=' })]);
    expect((await listContacts(pam, { pod: '' })).total).toBe(3);
    const admin = await listContacts(ria, {});
    expect([admin.params.view, admin.total, admin.chips]).toEqual(['all', 3, []]);
  });

  it('N082: "Unclaimed" is one owner choice and never contradicts another filter; the old owner=mine&status=unclaimed shows the unclaimed', async () => {
    const free = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null });
    await readyContact(b.users.karson.id, b.pods.Alisa.id);
    const legacy = await listContacts(karson, { owner: 'mine', status: 'unclaimed' });
    expect([legacy.params.view, ids(legacy.rows)]).toEqual(['unclaimed', [free.id]]);
    expect((await listContacts(karson, { owner: 'unclaimed' })).params.view).toBe('unclaimed');
    // Choosing Unclaimed as the owner opens the Unclaimed view; a view that needs an owner drops it.
    expect(ownerPatch('unclaimed', 'no_next_step')).toEqual({ view: 'unclaimed', owner: null });
    expect(ownerPatch('unclaimed', 'all')).toEqual({ view: 'unclaimed', owner: null });
    expect(ownerPatch('mine', 'unclaimed')).toEqual({ view: 'mine', owner: null });
    expect(ownerPatch(b.users.alisa.id, 'unclaimed')).toEqual({ view: 'all', owner: b.users.alisa.id });
    const ctx = { role: 'rep' as const, userId: karson.id, ownerIds: new Set<string>(), podIds: new Set<string>(), myPodIds: [b.pods.Alisa.id] };
    const p = resolveListParams({ view: 'moved', owner: 'unclaimed' }, ctx);
    expect(viewHref(p, 'no_next_step')).toBe('/cold-outreach?view=no_next_step');
    expect(scopeFor('no_next_step', resolveListParams({ view: 'no_next_step', owner: 'unclaimed' }, ctx), ctx).owner).toBe('mine');
  });

  it('N083: Next is the earlier of the next step and the campaign step, labelled, and red when overdue', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const campaign = await prisma.campaign.create({ data: { name: 'Q4 Harbor', audience: 'SANDBOX', status: 'ACTIVE', podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-02', createdById: b.users.alisa.id } });
    const enrollment = await prisma.enrollment.create({ data: { sandboxContactId: c.id, sequenceId: b.sequence.id, campaignId: campaign.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, startDate: '2026-11-02', status: 'ACTIVE', currentStep: 0, audience: 'SANDBOX' } });
    await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId: b.users.alisa.id, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action: 'EMAIL', label: 'Email 1', dueDate: '2026-11-03', plannedDate: '2026-11-03', dueAt: new Date('2026-11-03T15:00:00Z') } });
    await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2099-01-05', audience: 'SANDBOX' } });
    const row = (await listContacts(alisa, { view: 'all' })).rows.find((r) => r.id === c.id)!;
    expect(row.next).toEqual({ label: 'Email · Q4 Harbor', day: 'Tue 3 Nov', overdue: true });
    const html = draw(PeopleTable, { variant: 'cold', rows: [row], canSelect: true, bulk });
    expect(html).toContain('<th>Next</th>');
    expect(html).toContain('<div class="font-medium text-red-600">Overdue · Tue 3 Nov</div>');
  });

  it('N046: a row with a call waiting for its form shows "Form due", and the strip\'s Forms due view lists the contacts whose forms I hold', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const call = await prisma.callLog.create({ data: { source: 'TWILIO_IMPORT', direction: 'OUTBOUND', status: 'COMPLETED', userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: new Date('2026-11-05T15:00:00Z'), formDueAt: new Date('2026-11-05T15:10:00Z') } });
    const due = await listContacts(alisa, { view: 'form_due' });
    expect(ids(due.rows)).toEqual([c.id]);
    expect(due.rows[0].chips.map((x) => x.label)).toContain('Form due');
    expect(due.rows[0].lastCall).toEqual({ outcome: 'Form due', day: '5 Nov' });
    expect(due.tabs.map((t) => t.view)).toContain('form_due');
    // Handed to Karson, the form is his to fill.
    await prisma.callLog.update({ where: { id: call.id }, data: { formUserId: b.users.karson.id } });
    expect((await listContacts(alisa, { view: 'form_due' })).total).toBe(0);
    expect((await listContacts(karson, { view: 'form_due' })).total).toBe(1);
  });

  it('N078: Assign is a button that opens a picker with an explicit Assign; nothing acts on a change; the work moves with the contact', async () => {
    const pam = await leader();
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2026-11-20', audience: 'SANDBOX' } });
    const list = await listContacts(pam, { view: 'all' });
    const owners = [{ id: b.users.karson.id, name: 'Karson', podIds: [b.pods.Alisa.id] }];
    const html = draw(ColdBulkActions, { rows: list.rows, ...bulk, owners, onDone: () => {} });
    expect(html).toContain('>Assign<');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('Nobody');
    auth.requireUser.mockResolvedValue(pam);
    const fd = new FormData();
    fd.append('ids', c.id);
    fd.set('userId', b.users.karson.id);
    fd.set(`owner:${c.id}`, b.users.alisa.id);
    expect(await assignContactsAction(fd)).toEqual(expect.objectContaining({ ok: true, message: 'Assigned 1. Their 1 next step moved too.' }));
    expect(await prisma.nextAction.findFirstOrThrow({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toEqual(expect.objectContaining({ foUserId: b.users.karson.id }));
  });

  it('PLAN 4.8: a leader\'s pod views list the pod\'s Unclaimed and No next step contacts, and a bulk Assign hands them over', async () => {
    const pam = await leader();
    const free = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null });
    const bare = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await readyContact(b.users.leigh.id, b.pods.Leigh.id, { ownerId: null });
    await readyContact(b.users.leigh.id, b.pods.Leigh.id);
    const unclaimed = await listContacts(pam, { view: 'unclaimed' });
    expect(ids(unclaimed.rows)).toEqual([free.id]);
    expect(unclaimed.rows[0].allows.assign).toBe(true);
    const noNext = await listContacts(pam, { view: 'no_next_step' });
    expect(ids(noNext.rows)).toEqual([bare.id]);
    auth.requireUser.mockResolvedValue(pam);
    const fd = new FormData();
    for (const id of [free.id, bare.id]) fd.append('ids', id);
    fd.set('userId', b.users.karson.id);
    expect(await assignContactsAction(fd)).toEqual(expect.objectContaining({ ok: true, message: 'Assigned 2.' }));
    expect((await listContacts(karson, {})).total).toBe(2);
  });

  it('B148: a result or a refusal comes back as a message on the list\'s address, so it survives the refresh; a lost claim race names the winner', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null });
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { ownerId: b.users.alisa.id, claimedAt: new Date() } });
    auth.requireUser.mockResolvedValue(karson);
    const fd = new FormData();
    fd.append('ids', c.id);
    const r = await claimContactsAction(fd);
    expect(r).toEqual({ ok: false, error: 'Alisa Marsh claimed this contact first.' });
    const href = flashHref('/cold-outreach', 'view=unclaimed&q=sam', r);
    expect(href).toBe('/cold-outreach?view=unclaimed&q=sam&flash=Alisa+Marsh+claimed+this+contact+first.&flashTone=error');
    expect(flashHref('/cold-outreach', 'view=all', { ok: true, message: 'Claimed 1. 1 not changed: X.', data: { refused: 1 } })).toContain('flashTone=warn');
    const toast = draw(TaskFlash, { message: 'Alisa Marsh claimed this contact first.', tone: 'error' });
    expect(toast).toContain('role="alert"');
    expect(toast).not.toContain('truncate');
  });

  it('B203: a later result replaces an earlier refusal; the old message never stays beside it', () => {
    const after = flashHref('/cold-outreach', 'view=all&flash=Nothing+was+changed.&flashTone=error', { ok: true, message: 'Claimed 2.' });
    expect(after).toBe('/cold-outreach?view=all&flash=Claimed+2.');
  });

  it('B192: list filters survive actions and the way back from a contact', () => {
    const ctx = { role: 'leader' as const, userId: 'u', ownerIds: new Set(['k']), podIds: new Set(['p1']), myPodIds: ['p1'] };
    const p = resolveListParams({ view: 'no_next_step', q: 'jane', owner: 'k', pod: '', source: 'MANUAL', page: '2', flash: 'Done.' }, ctx);
    expect(listHref(p)).toBe('/cold-outreach?view=no_next_step&q=jane&owner=k&pod=&source=MANUAL');
    // After an action the list stays where it was, with the result as a message.
    expect(flashHref('/cold-outreach', 'view=no_next_step&q=jane&owner=k&pod=&source=MANUAL&page=2', { ok: true, message: 'Removed 1.' })).toBe('/cold-outreach?view=no_next_step&q=jane&owner=k&pod=&source=MANUAL&page=2&flash=Removed+1.');
    // The contact page's crumb goes back to the list as it was left, without the old message.
    expect(keptListUrl('/cold-outreach', 'view=ready&pod=p1&flash=Done.&flashTone=warn')).toBe('/cold-outreach?view=ready&pod=p1');
    expect(keptListUrl('/cold-outreach', '')).toBe('/cold-outreach');
  });

  it('B208: the Owner filter lists sales reps only; admins and Biz Ops are never owners', async () => {
    await prisma.user.create({ data: { email: 'bo@cadence.local', name: 'Bo Ops', role: 'BIZ_OPS', passwordHash: 'x' } });
    const list = await listContacts(alisa, {});
    expect(list.owners.map((o) => o.name)).not.toContain(b.users.ria.name);
    expect(list.owners.map((o) => o.name)).not.toContain('Bo Ops');
    expect(list.owners.map((o) => o.id)).toEqual(expect.arrayContaining([b.users.alisa.id, b.users.karson.id, b.users.leigh.id]));
  });

  it('B201: Add contact offers Edit\'s phone types, sets no phone type without a phone, and opens clean', async () => {
    const r = await createContact({ firstName: 'No', lastName: 'Phone', phoneType: 'mobile', email: 'no.phone@example.org' }, { id: b.users.alisa.id, podIds: [b.pods.Alisa.id], ownsContacts: true }, userActor(b.users.alisa));
    expect(r.ok).toBe(true);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: (r as { id: string }).id } })).toEqual(expect.objectContaining({ phone: null, phoneType: null }));
    const html = draw(AddContactButton, { pods: [{ id: 'p', name: 'Pod Alisa' }] });
    expect(html).toContain('Add contact');
    const dialog = draw(AddContactDialog, { pods: [{ id: 'p', name: 'Pod Alisa' }], owns: true, onClose: () => {} });
    for (const t of ['Direct', 'Mobile', 'Office', 'Main line', 'Toll free', 'Unknown']) expect(dialog).toContain(`>${t}</option>`);
    expect(dialog).toMatch(/<select name="phoneType"[^>]*disabled=""/);
    expect(dialog).not.toContain('role="alert"');
  });

  it('B204: Add contact has a Country, read from a number written with + and its code; a national number from elsewhere says to choose it', async () => {
    expect(countryOfPhone('+44 20 7946 0000')).toBe('GB');
    expect(countryOfPhone('0044 20 7946 0000')).toBe('GB');
    expect(countryOfPhone('+1 312 555 0123')).toBe('US');
    expect(countryOfPhone('020 7946 0000')).toBeNull();
    const by = { id: b.users.alisa.id, podIds: [b.pods.Alisa.id], ownsContacts: true };
    expect(await createContact({ firstName: 'Ava', lastName: 'Brook', phone: '020 7946 0000' }, by, userActor(b.users.alisa))).toEqual({ ok: false, error: 'That phone number could not be read as a US number. Choose its country, or start it with + and the country code.' });
    const r = await createContact({ firstName: 'Ava', lastName: 'Brook', phone: '020 7946 0000', country: 'GB' }, by, userActor(b.users.alisa));
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: (r as { id: string }).id } })).toEqual(expect.objectContaining({ phone: '+442079460000', country: 'GB', phoneType: 'direct' }));
    expect(draw(AddContactDialog, { pods: [], owns: true, onClose: () => {} })).toContain('<option value="GB">United Kingdom</option>');
  });

  it('B139: Add contact asks about the same name at the same firm, naming the other contact, and can add anyway', async () => {
    const pat = await readyContact(b.users.karson.id, b.pods.Alisa.id, { firstName: 'Pat', lastName: 'Lee', companyName: 'Rivera Wealth Partners' });
    auth.requireUser.mockResolvedValue(alisa);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ firstName: 'pat', lastName: 'lee', companyName: 'Rivera Wealth Partners', podId: b.pods.Alisa.id })) fd.set(k, v);
    expect(await createContactAction(fd)).toEqual({ ok: false, error: 'Pat Lee at the same firm is already in Cold outreach, owned by Karson Reed. Open that contact, or add this one anyway if it is someone else.', possibleDuplicate: pat.id });
    fd.set('addAnyway', '1');
    expect(await createContactAction(fd)).toEqual(expect.objectContaining({ ok: true }));
  });

  it('N003: Add contact refuses a person who is Do not contact in the CRM, and the dialog says what that means', async () => {
    const sofia = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-07' } });
    auth.requireUser.mockResolvedValue(alisa);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ firstName: 'Sofia', lastName: 'Lindqvist', companyName: sofia.companyName!, podId: b.pods.Alisa.id })) fd.set(k, v);
    const r = await createContactAction(fd);
    expect(r).toEqual({ ok: false, error: 'Sofia Lindqvist is marked Do not contact in the CRM.' });
    expect(refusalWords((r as { error: string }).error)).toEqual({ title: 'Not added: Do not contact', text: 'Sofia Lindqvist is marked Do not contact in the CRM. Nobody may contact this person, so Cadence keeps them out of Cold outreach. If you think the CRM is wrong, ask whoever looks after the CRM.' });
  });

  it('Set next step for several contacts sets each through the guard and names those it could not', async () => {
    const own = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    const hers = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    auth.requireUser.mockResolvedValue(karson);
    const fd = new FormData();
    for (const id of [own.id, hers.id]) fd.append('ids', id);
    for (const [k, v] of Object.entries({ label: 'Intro call', action: 'CALL', dueDate: '2099-01-05' })) fd.set(k, v);
    expect(await setNextStepsAction(fd)).toEqual(expect.objectContaining({ ok: true, message: expect.stringMatching(/^Next step set for 1\. 1 not changed: This is Alisa Marsh's contact/), data: { refused: 1 } }));
    expect(await prisma.nextAction.count({ where: { sandboxContactId: own.id, state: 'OPEN', foUserId: b.users.karson.id } })).toBe(1);
    fd.set('label', '');
    expect(await setNextStepsAction(fd)).toEqual({ ok: false, error: 'Say what to do.' });
  });
});
