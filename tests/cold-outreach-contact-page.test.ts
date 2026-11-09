import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { userActor } from '@/lib/audit';
import { checkReady } from '@/lib/sandbox/ready';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { countryChoices } from '@/lib/sandbox/normalize';
import { optOutConfirm } from '@/lib/outreach/confirm-words';
import { HIDDEN_CALL } from '@/lib/calls/access';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';
import { sessionOf } from './helpers/cold-campaign';

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => '/cold-outreach', useSearchParams: () => new URLSearchParams(), redirect: (to: string) => { throw new Error(`redirect:${to}`); }, notFound: () => { throw new Error('not found'); } }));

const { default: ContactPage } = await import('@/app/(app)/cold-outreach/[id]/page');
const { loadContactPage, nextWords, phoneWords } = await import('@/lib/sandbox/contact-page');
const { updateContact, detailsVersion } = await import('@/lib/sandbox/contacts');
const sandboxActions = await import('@/lib/actions/sandbox');
const { queueMove, runMoveQueue, undoMoveItem } = await import('@/lib/sandbox/move');
const { Flash } = await import('@/components/flash');

/**
 * Stage S10 (cold outreach W8): the cold contact page, `/cold-outreach/[id]` (PLAN 4.2), drawn the way
 * the server first paints it, and the Edit dialog's server side. One test per bug id, named after it.
 */

let b: Basics;
let alisa: SessionUser;
let karson: SessionUser;
let ria: SessionUser;
/** The seeded names: Alisa (Senior FO), Karson (Junior FO), Ria (admin). */
let A: string;
let K: string;
let R: string;

/** The page as the server first paints it, for `user`, with these search params. */
async function draw(id: string, user: SessionUser, sp: Record<string, string> = {}): Promise<string> {
  auth.requireUser.mockResolvedValue(user);
  return renderToStaticMarkup(await ContactPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) }));
}
const guardOf = (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds });
const fd = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return f; };
/** The text of the page, tags dropped and entities read, for sentences that span elements. */
/** The fields the contact's latest edit wrote. */
const lastEditFields = async (id: string) => ((await prisma.auditLog.findFirst({ where: { entityId: id, action: 'edited' }, orderBy: { createdAt: 'desc' } }))?.details as { fields?: string[] } | null)?.fields;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

async function runningCampaign(contactId: string, foUserId: string, podId: string, name = 'Q4 Harbor') {
  const campaign = await prisma.campaign.create({ data: { name, audience: 'SANDBOX', sequenceId: b.sequence.id, podId, personIds: [contactId], startDate: '2026-11-05', status: 'ACTIVE' } });
  const enrollment = await prisma.enrollment.create({ data: { sandboxContactId: contactId, foUserId, podId, campaignId: campaign.id, sequenceId: b.sequence.id, startDate: '2026-11-05', status: 'ACTIVE', currentStep: 0, audience: 'SANDBOX' } });
  const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action: 'CALL', label: 'Call 1', dueDate: '2099-11-06', dueAt: new Date('2099-11-06T09:00:00Z'), plannedDate: '2099-11-06' } });
  return { campaign, enrollment, task };
}

async function meetingBooked(contactId: string, userId: string) {
  const call = await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId, sandboxContactId: contactId, startedAt: new Date(), formDoneAt: new Date() } });
  await prisma.callForm.create({ data: { callId: call.id, userId, outcome: 'meeting_booked', nextStep: 'meeting', nextStepDate: '2099-11-20', notes: 'Booked a demo for the PHH pilot.' } });
  return call;
}

beforeEach(async () => {
  await resetDb();
  b = await seedBasics();
  alisa = await sessionOf(b.users.alisa.id);
  karson = await sessionOf(b.users.karson.id);
  ria = await sessionOf(b.users.ria.id);
  [A, K, R] = [b.users.alisa.name, b.users.karson.name, b.users.ria.name];
});

describe('Cold contact page: layout and cues (S10, PLAN 4.2)', () => {
  it('B141: the CRM person layout: record header, the blocker with its fix, one row of buttons, the six tabs, no always-editable form', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe' });
    const html = await draw(c.id, alisa);
    expect(html).toContain('Jane Doe');
    expect(html).toContain(`Advisor · Rivera Wealth Partners · ${A} · Pod Alisa`);
    for (const t of ['Overview', 'Campaigns', 'Tasks', 'Activity', 'Emails', 'Notes']) expect(html).toMatch(new RegExp(`>${t}(<| )`));
    for (const label of ['Email', 'LinkedIn', 'Log a call', 'Set next step', 'Move to CRM', 'More']) expect(html).toContain(label);
    // Read-only details with an Edit dialog, a one-line next step; no form of inputs on the page.
    expect(html).not.toContain('name="firstName"');
    expect(html).not.toContain('name="label"');
    expect(html).toContain('>Edit<');
    // No next step yet: the blocker says so and offers the fix (4.0).
    expect(text(html)).toContain('Jane has no next step. Set one, or add Jane to a campaign.');
    // The step strip is gone (owner, 9 Nov 2026).
    expect(html).not.toContain('This contact is here');
    expect(html).toContain('No next step');
  });

  it('B142: phone with its type and extension, email with its verification, designations and tags', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+16465550499', phoneExtension: '7', phoneType: 'direct', emailVerification: 'risky', designations: ['CFP', 'CFA'], tags: ['SEC IAPD', 'Top 100'] });
    const html = text(await draw(c.id, alisa));
    expect(phoneWords('+16465550499', '7')).toBe('(646) 555-0499 ext. 7');
    expect(html).toContain('(646) 555-0499 ext. 7 Direct');
    expect(html).toContain('Risky');
    expect(html).toContain('CFP');
    expect(html).toContain('Top 100');
    expect(html).toContain('PHH');
  });

  it('B143 B017: the Source card names a possible CRM match and a possible duplicate, each linked', async () => {
    const person = await prisma.personCache.findFirstOrThrow({ where: { deletedAt: null } });
    const twin = await readyContact(b.users.karson.id, b.pods.Alisa.id, { firstName: 'Janet', lastName: 'Doe' });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe', possibleCrmPersonId: person.id, possibleDuplicateId: twin.id });
    const html = await draw(c.id, alisa);
    expect(text(html)).toContain(`Possibly in the CRM: ${person.firstName} ${person.lastName}`.trim());
    expect(html).toContain(`href="/people/${person.id}"`);
    expect(text(html)).toContain('Possibly the same as Janet Doe');
    expect(html).toContain(`href="/cold-outreach/${twin.id}"`);
  });

  it('B068: "Newer details from Bellwether" is a chip linking to the note', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const note = await prisma.sandboxNote.create({ data: { sandboxContactId: c.id, body: 'Newer details from Bellwether: email jane@northstar.com added. Check them before the next step.', authorName: 'Alisa (Bellwether)' } });
    const html = await draw(c.id, alisa);
    expect(html).toContain('Newer details from Bellwether');
    expect(html).toContain(`href="/cold-outreach/${c.id}?tab=notes#note-${note.id}"`);
    expect(await draw(c.id, alisa, { tab: 'notes' })).toContain(`id="note-${note.id}"`);
  });

  it('B205: the pusher by name and the push day in the workspace zone; later sends listed; the opt-out confirm asks why', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { pushedByEmail: 'alisa@cadence.local', pushedByName: null, sourceNote: 'Met at the FPA booth.' });
    const first = await prisma.bellwetherPush.create({ data: { idempotencyKey: 'p1', bodyHash: 'h', state: 'DONE', pushedByEmail: 'alisa@cadence.local', contactCount: 1, createdAt: new Date('2026-11-03T23:30:00Z') } });
    await prisma.bellwetherPushItem.create({ data: { pushId: first.id, bellwetherContactId: 'bw:1', result: 'created', sandboxContactId: c.id, createdAt: new Date('2026-11-03T23:30:00Z') } });
    const again = await prisma.bellwetherPush.create({ data: { idempotencyKey: 'p2', bodyHash: 'h', state: 'DONE', pushedByEmail: 'karson@cadence.local', contactCount: 1, createdAt: new Date('2026-11-05T12:00:00Z') } });
    await prisma.bellwetherPushItem.create({ data: { pushId: again.id, bellwetherContactId: 'bw:1', result: 'duplicate_in_sandbox', sandboxContactId: c.id, createdAt: new Date('2026-11-05T12:00:00Z') } });
    const html = text(await draw(c.id, alisa));
    // 23:30 UTC on 3 Nov is still 3 Nov in Chicago, the workspace zone.
    expect(html).toContain(`From Bellwether, sent by ${A} on 3 Nov 2026`);
    expect(html).toContain(`Sent again by ${K} on 5 Nov 2026`);
    expect(html).toContain('Met at the FPA booth.');
    expect(html).not.toContain('sent by alisa@cadence.local');
    expect(optOutConfirm({ name: 'Jane Doe' }).reason).toEqual(expect.objectContaining({ required: true }));
  });

  it('B154 B155 B104: the checklist in plain nouns, "4 of 5 done", then "CRM details complete", then green "Ready to move"; readiness warnings shown', async () => {
    const r = checkReady({ firstName: 'Jane', lastName: 'Doe', companyName: 'Harbor', email: null, emailVerification: null, badEmail: false, phone: null, phoneType: null, badPhone: false, additionalPhones: [], status: 'ACTIVE', jobTitle: null, linkedinUrl: null, city: null, productInterest: [], ownerId: null, podId: null }, { owner: null, podName: null, settings: DEFAULT_SETTINGS.sandbox });
    expect(r.missing.map((m) => m.text)).toEqual(['Email or direct phone', 'Owner (claim it)', 'Pod']);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { jobTitle: null, linkedinUrl: null });
    let html = text(await draw(c.id, alisa));
    expect(html).toContain('CRM checklist');
    expect(html).toContain('CRM details complete');
    expect(html).not.toContain('Ready to move');
    expect(html).toContain('No conversation yet');
    // B104: what is worth adding before the move.
    expect(html).toContain('Worth adding before the move: No job title · No LinkedIn');
    await meetingBooked(c.id, b.users.alisa.id);
    html = text(await draw(c.id, alisa));
    expect(html).toContain('Ready to move');
    expect(html).toContain('Positive outcome: Meeting booked');
    const gap = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: null, phone: null });
    html = text(await draw(gap.id, alisa));
    expect(html).toContain('4 of 5 done');
    expect(html).toContain('Email or direct phone');
    expect(html).not.toMatch(/Needs [a-z]/);
  });

  it('B050: the checklist offers a pod picker when the owner works in several pods', async () => {
    await prisma.userPod.create({ data: { userId: b.users.alisa.id, podId: b.pods.Leigh.id } });
    const both = await sessionOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const html = await draw(c.id, both);
    expect(html).toMatch(/<select name="podId" aria-label="Pod"/);
    expect(html).toContain('Pod Leigh');
    // A contact with no pod says Pod is missing; the pod picker fixes it.
    const r = await sandboxActions.setPodAction(fd({ id: c.id, podId: b.pods.Leigh.id }));
    auth.requireUser.mockResolvedValue(both);
    expect(r).toEqual(expect.objectContaining({ ok: true }));
  });

  it('N073: "Wrong number" and "Email bounced" chips; Call on the bad number asks first; Email says it bounced', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { badPhone: true, badEmail: true });
    // 10:00 in Chicago, inside calling hours.
    const m = (await loadContactPage(c.id, alisa, new Date('2026-11-04T16:00:00Z')))!;
    expect(m.cue.chips.map((x) => x.label)).toEqual(expect.arrayContaining(['Wrong number', 'Email bounced']));
    expect(m.call.blocked).toBeNull();
    expect(m.call.warning).toContain('This number was marked wrong');
    expect(m.email.blocked).toBe('Email bounced: find a new one');
    const html = text(await draw(c.id, alisa));
    expect(html).toContain('Wrong number');
    expect(html).toContain('Email bounced: find a new one');
  });

  it('N074: Email opens the mail app and LinkedIn the profile, from the header', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: 'jane@harbor.com', linkedinUrl: 'linkedin.com/in/jane-doe' });
    const html = await draw(c.id, alisa);
    expect(html).toContain('href="mailto:jane@harbor.com"');
    expect(html).toContain('href="https://www.linkedin.com/in/jane-doe"');
  });

  it('B089: why Call is blocked shows under the button as text, with the fix', async () => {
    const other = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Bob', lastName: 'Lee' });
    await prisma.callLog.create({ data: { source: 'TWILIO_IMPORT', direction: 'OUTBOUND', status: 'COMPLETED', userId: b.users.alisa.id, sandboxContactId: other.id, startedAt: new Date(Date.now() - 3_600_000), formDueAt: new Date(Date.now() - 3_000_000) } });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe' });
    const html = await draw(c.id, alisa);
    const words = text(html);
    expect(words).toContain('Form first');
    expect(words).toContain('Fill in the form for your call with Bob Lee first.');
    // The blocker names the call and opens its form (4.0: "Your 14:05 call with Bob needs its form").
    expect(words).toMatch(/Your call with Bob Lee \(.+\) needs its form before you can call again\. Fill it in/);
    // Log a call waits too, and says why.
    expect((await loadContactPage(c.id, alisa))!.logCall.blocked).toMatch(/^Fill in the form for your call with Bob Lee/);
  });

  it('B202: a contact I may not work says why at the top, and the buttons say why under them', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe' });
    const m = (await loadContactPage(c.id, karson))!;
    expect(m.readOnly).toBe(`This is ${A}'s contact. Ask ${A} or your pod leader.`);
    expect(m.blocker).toEqual(expect.objectContaining({ text: m.readOnly, fix: null }));
    const html = text(await draw(c.id, karson));
    expect(html).toContain(`This is ${A}'s contact. Ask ${A} or your pod leader.`);
    expect(html).toContain(`${A}'s contact`);
    // Edit is not offered; the reason is.
    expect(m.edit.may).toBe(false);
    // Buttons a role can never use are hidden: Biz Ops reads, and is told so.
    const bea = await prisma.user.create({ data: { email: 'bea@cadence.local', name: 'Bea Ops', role: 'BIZ_OPS', passwordHash: 'x', timezone: 'Europe/London' } });
    const ops = await draw(c.id, await sessionOf(bea.id));
    expect(text(ops)).toContain('Biz Ops can view cold contacts but cannot change them.');
    for (const label of ['Log a call', 'Set next step', '>More<', 'Claim']) expect(ops).not.toContain(label);
  });

  it('B050: a leader in two pods claiming a contact with no pod chooses its pod with the claim, and the claim works', async () => {
    await prisma.user.update({ where: { id: b.users.leigh.id }, data: { role: 'SALES_LEADER', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    const leigh = await sessionOf(b.users.leigh.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Nopod', ownerId: null, claimedAt: null, podId: null });
    const m = (await loadContactPage(c.id, leigh))!;
    expect(m.claimPods?.map((p) => p.id).sort()).toEqual([b.pods.Alisa.id, b.pods.Leigh.id].sort());
    // Claim and call cannot choose a pod, so Call says "Claim first" instead.
    expect(m.call.claim).toBe(false);
    expect(m.call.blocked).toBe('Claim first');
    expect(await draw(c.id, leigh)).toContain('aria-label="Pod to claim it into"');
    auth.requireUser.mockResolvedValue(leigh);
    const fd = new FormData();
    fd.append('ids', c.id);
    fd.set('podId', b.pods.Leigh.id);
    expect(await sandboxActions.claimContactsAction(fd)).toEqual(expect.objectContaining({ ok: true }));
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ ownerId: b.users.leigh.id, podId: b.pods.Leigh.id }));
    // A rep in one pod needs no choice.
    const d = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null, claimedAt: null, podId: null });
    expect((await loadContactPage(d.id, karson))!.claimPods).toBeNull();
  });

  it('B053: a contact already in the CRM: Log a call is off and says why, as Call and Set next step do', async () => {
    const p = (await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, dnd: false, optedOut: false } }));
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { crmMatchPersonId: p.id });
    const m = (await loadContactPage(c.id, alisa))!;
    expect(m.logCall.blocked).toBe('Outreach stopped: in the CRM');
    expect(m.nextStep.blocked).toBe('Outreach stopped: in the CRM');
  });

  it('B149: an unclaimed contact is Claim-only for reps: "Claim and call", every other button "Claim first", the blocker offers Claim', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', ownerId: null, claimedAt: null });
    const m = (await loadContactPage(c.id, karson))!;
    expect(m.call.claim).toBe(true);
    expect(m.email.blocked).toBe('Claim first');
    expect(m.linkedin.blocked).toBe('Claim first');
    expect(m.nextStep.blocked).toBe('Claim first');
    expect(m.logCall.blocked).toBe('Claim first');
    expect(m.blocker).toEqual(expect.objectContaining({ text: 'Nobody owns Jane yet. Claim Jane to call, email or set a next step.', fix: expect.objectContaining({ kind: 'claim' }) }));
    const html = text(await draw(c.id, karson));
    expect(html).toContain('Claim and call');
    expect(html).toContain('Claim first');
    // Opt out never needs a claim (8.1).
    expect(m.more.mayOptOut).toBe(true);
    // An admin does not own contacts: Assign, not Claim.
    const forAdmin = (await loadContactPage(c.id, ria))!;
    expect(forAdmin.blocker?.fix?.kind).toBe('assign');
    expect(forAdmin.call.claim).toBe(false);
  });

  it('B148 B203: a result travels as ?flash= and survives the refresh, saying what happens next; a refusal stays, red', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2099-11-05', audience: 'SANDBOX' } });
    let html = text(await draw(c.id, alisa, { flash: 'Saved.' }));
    expect(html).toContain('Saved. Next: Call on Thu 5 Nov.');
    expect(nextWords({ state: 'no_next_step', next: null }, 'Jane')).toBe('Next: set a next step, or add Jane to a campaign.');
    // Losing a claim race: the refusal says who won, and stays (role alert, no timer).
    const unclaimed = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null, claimedAt: null });
    auth.requireUser.mockResolvedValue(alisa);
    expect(await sandboxActions.claimContactsAction(fd({ ids: unclaimed.id }))).toEqual(expect.objectContaining({ ok: true }));
    auth.requireUser.mockResolvedValue(karson);
    const lost = await sandboxActions.claimContactsAction(fd({ ids: unclaimed.id }));
    expect(lost).toEqual({ ok: false, error: `${A} claimed this contact first.` });
    html = await draw(unclaimed.id, karson, { flash: lost.ok ? '' : lost.error, flashTone: 'error' });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(`${A} claimed this contact first.`);
    expect(text(html)).not.toContain('first. Next:');
    // One toast: the latest outcome only, never an old error beside a new success (B203).
    expect(renderToStaticMarkup(createElement(Flash, { message: 'Saved.' }))).toContain('role="status"');
    expect(readFileSync('src/components/action-form.tsx', 'utf8')).toMatch(/onInput=\{\(\) => \{ if \(result && !result\.ok\) setResult\(null\); \}\}/);
  });
});

describe('Cold contact page: refusals from a stale tab (S11b)', () => {
  it('B148 B203: a note or next step refused in a stale tab keeps the page as it was, so the refusal stays on screen; the note box sends its refusal to the toast', async () => {
    const { revalidatePath } = await import('next/cache');
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { status: 'OPTED_OUT', optedOutAt: new Date() } });
    auth.requireUser.mockResolvedValue(alisa);
    vi.mocked(revalidatePath).mockClear();
    const note = await sandboxActions.addNoteAction(fd({ id: c.id, body: 'Left a message' }));
    expect(note).toEqual(expect.objectContaining({ ok: false, error: expect.any(String) }));
    const next = await sandboxActions.setNextActionAction(fd({ id: c.id, label: 'Call back', action: 'CALL', dueDate: '2099-01-05' }));
    expect(next).toEqual(expect.objectContaining({ ok: false, error: expect.any(String) }));
    // Nothing was re-read: the dialog and the note box keep their message.
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(await prisma.nextAction.count({ where: { sandboxContactId: c.id } })).toBe(0);
    // The composer's refusal goes to the page's toast (replaced by the next result), never left beside it.
    const src = readFileSync('src/components/sandbox/contact-page.tsx', 'utf8');
    expect(src).toContain("else say(r.error, 'error'); return r.ok ? { ok: true } : { ok: false, error: '' };");
  });
});

describe('Cold contact page: tabs (S10)', () => {
  it('B144 B145: every membership incl. scheduled holds; Add to campaign; Pause and Exit where the reader may; exits read "Moved to CRM" / "Opted out"', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await runningCampaign(c.id, b.users.alisa.id, b.pods.Alisa.id);
    await prisma.campaign.create({ data: { name: 'Spring push', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [c.id], startDate: '2099-11-12', status: 'SCHEDULED' } });
    const old = await prisma.campaign.create({ data: { name: 'Old one', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-10-01', status: 'COMPLETED' } });
    await prisma.enrollment.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, campaignId: old.id, sequenceId: b.sequence.id, startDate: '2026-10-01', status: 'EXITED', exitReason: 'opted_out', audience: 'SANDBOX' } });
    const html = text(await draw(c.id, alisa, { tab: 'sequences' }));
    expect(html).toMatch(/In Spring push ?, starts Thu 12 Nov/);
    expect(html).toContain('Q4 Harbor');
    expect(html).toContain('Add to campaign');
    expect(html).toContain('Pause');
    expect(html).toContain('Exit');
    expect(html).toContain('Opted out');
    expect(html).not.toMatch(/>Removed</);
    expect(html).toContain('Call 1: Due');
    // A Junior FO cannot pause his colleague's campaign: no controls, no dead buttons.
    const forKarson = (await loadContactPage(c.id, karson))!;
    expect(forKarson.memberships.find((e) => e.name === 'Q4 Harbor')!.mayManage).toBe(false);
  });

  it('S7 rule: a draft campaign does not hold the contact on its page', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.campaign.create({ data: { name: 'Q4 Draft', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [c.id], startDate: '2099-11-12', status: 'DRAFT' } });
    const m = (await loadContactPage(c.id, alisa))!;
    // Not a hold, not "in a campaign", and nothing it blocks: the contact can still join a campaign.
    expect(m.holds).toEqual([]);
    expect(m.drafts.map((d) => d.name)).toEqual(['Q4 Draft']);
    expect(m.cue.state).toBe('no_next_step');
    expect(m.mayEnroll).toBe(true);
    const { coldAudienceIssues } = await import('@/lib/sandbox/campaigns');
    expect(await coldAudienceIssues([c.id], { podId: b.pods.Alisa.id, podName: 'Pod Alisa', foIds: [b.users.alisa.id] })).toEqual([]);
    const html = text(await draw(c.id, alisa, { tab: 'sequences' }));
    expect(html).toMatch(/In draft: ?Q4 Draft ?\(not started\)/);
    expect(html).not.toContain('Upcoming');
    expect(html).toContain('Not in a campaign.');
  });

  it('B140: Activity shows every event in words: pushed, claimed, assigned, enrolled, skipped, exited, opted out, moved and undone', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane' });
    const { enrollment, task } = await runningCampaign(c.id, b.users.alisa.id, b.pods.Alisa.id);
    await prisma.task.update({ where: { id: task.id }, data: { state: 'SKIPPED', skipReason: 'Email bounced', completedAt: new Date() } });
    for (const action of ['pushed', 'claimed', 'assigned', 'move_queued', 'sandbox_moved', 'move_undone', 'opted_out']) await prisma.auditLog.create({ data: { entityType: 'sandbox_contact', entityId: c.id, action, actorType: 'USER', actorId: b.users.alisa.id, actorLabel: `${A}`, details: action === 'opted_out' ? { source: 'contact_page' } : undefined } });
    await prisma.auditLog.create({ data: { entityType: 'enrollment', entityId: enrollment.id, action: 'enrolled', actorType: 'USER', actorId: b.users.alisa.id, actorLabel: `${A}` } });
    await prisma.auditLog.create({ data: { entityType: 'enrollment', entityId: enrollment.id, action: 'exited', actorType: 'SYSTEM', actorLabel: 'Cadence', details: { reason: 'moved_to_crm' } } });
    const m = (await loadContactPage(c.id, alisa))!;
    const titles = m.history.map((h) => h.title);
    for (const want of ['Sent from Bellwether', 'Claimed', 'Given to a new owner', 'Queued to move to the CRM', 'Moved to the CRM', 'Move to the CRM undone', 'Opted out', 'Enrolled', 'Ended: moved to the CRM', 'Call 1 skipped: Email bounced']) {
      expect(titles.some((t) => t.startsWith(want)), want).toBe(true);
    }
    // S8: through describeAudit, never a raw action name.
    expect(titles.join(' ')).not.toMatch(/move_queued|sandbox_moved|opted_out/);
    expect(text(await draw(c.id, alisa, { tab: 'activity' }))).toContain('Move to the CRM undone');
  });

  it('N051: a call\'s notes and recording show only to the rep, the owner and Reports viewers', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const call = await meetingBooked(c.id, b.users.alisa.id);
    await prisma.callLog.update({ where: { id: call.id }, data: { recordingSid: 'RE123' } });
    const own = (await loadContactPage(c.id, alisa))!.history.find((h) => h.key === `c${call.id}`)!;
    expect(own.detail).toBe('Booked a demo for the PHH pilot.');
    expect(own.recordingHref).toBe(`/api/calls/${call.id}/recording`);
    const other = (await loadContactPage(c.id, karson))!.history.find((h) => h.key === `c${call.id}`)!;
    expect(other.detail).toBe(HIDDEN_CALL);
    expect(other.recordingHref).toBeNull();
    expect(other.title).toContain('Meeting booked');
  });

  it('S5: the Emails tab lists sent, replies and bounces newest first, and says when tracking is off', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.sandboxEmail.create({ data: { sandboxContactId: c.id, userId: b.users.alisa.id, kind: 'SENT', internetMessageId: 'm1', subject: 'Intro to PHH', at: new Date('2026-11-03T10:00:00Z') } });
    await prisma.sandboxEmail.create({ data: { sandboxContactId: c.id, userId: b.users.alisa.id, kind: 'REPLY', internetMessageId: 'm2', subject: 'Re: Intro to PHH', at: new Date('2026-11-04T10:00:00Z') } });
    const html = text(await draw(c.id, alisa, { tab: 'emails' }));
    expect(html).toContain('Email tracking is off. Emails show here only when a step is marked Done.');
    expect(html.indexOf('Re: Intro to PHH')).toBeLessThan(html.indexOf('Intro to PHH Alisa'));
    expect(html).toContain('Reply');
    expect(html).toContain(`${A}'s mailbox`);
  });

  it('Tasks: open and done steps and next steps, each linked to Tasks', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const { task } = await runningCampaign(c.id, b.users.alisa.id, b.pods.Alisa.id);
    const next = await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Send the deck', action: 'EMAIL', dueDate: '2099-11-09', audience: 'SANDBOX' } });
    await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Intro call', action: 'CALL', dueDate: '2026-11-02', state: 'DONE', closedAt: new Date('2026-11-02T15:00:00Z'), audience: 'SANDBOX' } });
    const html = await draw(c.id, alisa, { tab: 'tasks' });
    expect(html).toContain(`/tasks?task=${task.id}`);
    expect(html).toContain(`/tasks?next=${next.id}`);
    expect(html).not.toContain('/cold-outreach/tasks');
    expect(text(html)).toContain('Email: Send the deck');
    expect(text(html)).toContain('Call: Intro call');
    expect(text(html)).toMatch(/Done\s+Call: Intro call/);
  });
});

describe('Cold contact page: tombstones (S10)', () => {
  it('N104: an opted-out contact has a red Do not contact banner: who, when, where, and what it means', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    auth.requireUser.mockResolvedValue(karson);
    const r = await sandboxActions.optOutContactAction(fd({ id: c.id, reason: 'Asked by email' }));
    expect(r).toEqual({ ok: true, message: expect.stringContaining('Do not email, call or message this person. Cadence blocks calls and campaigns.') });
    expect(r.ok && r.message).not.toContain('Cadence will not contact');
    const html = await draw(c.id, alisa);
    const words = text(html);
    expect(html).toMatch(/bg-red-50/);
    expect(words).toMatch(new RegExp(`Do not contact since \\d+ Nov 2026, set by ${K} on the contact page\\. Why: Asked by email`));
    expect(words).toContain('Do not email, call or message this person. Cadence blocks calls and campaigns.');
    // Nothing to do here but Erase, for an admin.
    expect(words).not.toContain('Log a call');
    expect((await loadContactPage(c.id, alisa))!.more.show).toBe(false);
    expect((await loadContactPage(c.id, ria))!.more.mayErase).toBe(true);
  });

  it('B150 N027: a removed contact says who removed it, when, why and what was cleared; any sales user can still opt it out, an admin erase it', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    auth.requireUser.mockResolvedValue(alisa);
    expect(await sandboxActions.removeContactsAction(fd({ ids: c.id, reason: 'Not a fit' }))).toEqual(expect.objectContaining({ ok: true }));
    const html = text(await draw(c.id, alisa));
    expect(html).toContain('Removed contact');
    expect(html).toMatch(new RegExp(`Removed by ${A} on \\d+ Nov 2026\\. Why: Not a fit`));
    expect(html).toContain('were cleared');
    expect(html).not.toContain('Pod Alisa');
    // N027: Opt out for any sales user (Karson, not the owner), Erase for admins only.
    const forKarson = (await loadContactPage(c.id, karson))!;
    expect(forKarson.more).toEqual(expect.objectContaining({ show: true, mayOptOut: true, mayErase: false }));
    expect((await loadContactPage(c.id, ria))!.more).toEqual(expect.objectContaining({ show: true, mayErase: true }));
    auth.requireUser.mockResolvedValue(karson);
    expect(await sandboxActions.optOutContactAction(fd({ id: c.id, reason: 'Asked to stop' }))).toEqual(expect.objectContaining({ ok: true }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('OPTED_OUT');
    // Erased: who and when, everything cleared.
    auth.requireUser.mockResolvedValue(ria);
    expect(await sandboxActions.eraseContactAction(fd({ id: c.id }))).toEqual(expect.objectContaining({ ok: true }));
    const erased = text(await draw(c.id, ria));
    expect(erased).toContain('Erased contact');
    expect(erased).toMatch(new RegExp(`Erased by ${R} on \\d+ Nov 2026`));
    expect((await loadContactPage(c.id, ria))!.more.show).toBe(false);
  });

  it('B108: a moved contact says who moved it and when, links to People, offers Undo with its dated deadline; history shows the move and the undo', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe' });
    const q = await queueMove([{ contactId: c.id, mode: 'create', noConversation: true }], guardOf(alisa), userActor(b.users.alisa), { label: 'Intro call', action: 'CALL', dueDate: '2099-11-20' });
    if (!q.ok) throw new Error(q.error);
    await runMoveQueue();
    const moved = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
    expect(moved.status).toBe('MOVED');
    const html = await draw(c.id, alisa);
    const words = text(html);
    expect(words).toMatch(new RegExp(`Moved to the CRM by ${A} on \\d+ \\w+ 2026`));
    expect(words).toContain('Open in People');
    expect(html).toContain(`href="/people/${moved.twentyPersonId}"`);
    expect(words).toMatch(/Undo until \d+ \w+ 20\d\d/);
    expect(words).toContain('Undo');
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { sandboxContactId: c.id } });
    const undone = await undoMoveItem(item.id, guardOf(alisa), userActor(b.users.alisa));
    expect(undone).toEqual(expect.objectContaining({ ok: true }));
    const titles = (await loadContactPage(c.id, alisa))!.history.map((h) => h.title);
    expect(titles.some((t) => t.startsWith('Moved to the CRM'))).toBe(true);
    expect(titles.some((t) => t.startsWith('Move to the CRM undone'))).toBe(true);
  });
});

describe('Cold contact page: the Edit dialog, server side (S10)', () => {
  it('B052: a save that changes only the title keeps the wrong-number and bounce flags, the email verification and the extension', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { badPhone: true, badEmail: true, emailVerification: 'risky', phoneExtension: '7', phone: '+13125550199' });
    // Even when the unchanged email and phone come along, nothing they carry is reset.
    const r = await updateContact(c.id, { jobTitle: 'Partner', email: c.email, phone: '+1 312 555 0199', country: 'US' }, userActor(b.users.alisa), guardOf(alisa), { version: await detailsVersion(c.id) });
    expect(r).toEqual({ ok: true, id: c.id });
    expect(await lastEditFields(c.id)).toEqual(['jobTitle']);
    const after = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
    expect(after).toEqual(expect.objectContaining({ jobTitle: 'Partner', badPhone: true, badEmail: true, emailVerification: 'risky', phoneExtension: '7' }));
    // A new number clears the wrong-number flag and takes the Ext box.
    await updateContact(c.id, { phone: '+1 312 555 0123', phoneExtension: '42' }, userActor(b.users.alisa), guardOf(alisa), { version: await detailsVersion(c.id) });
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ phone: '+13125550123', phoneExtension: '42', badPhone: false, badEmail: true }));
  });

  it('N024: a dialog opened before someone else saved is refused with who and when; their edit stays', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const leighView = await detailsVersion(c.id);
    // Alisa fixes the phone and email first.
    expect(await updateContact(c.id, { phone: '+1 312 555 0111', email: 'jane.new@rivera-wealth.com' }, userActor(b.users.alisa), guardOf(alisa), { version: await detailsVersion(c.id) })).toEqual(expect.objectContaining({ ok: true }));
    const saved = await prisma.auditLog.findFirstOrThrow({ where: { entityId: c.id, action: 'edited' } });
    // Ria, from a page loaded before that save, changes only the title.
    const stale = await updateContact(c.id, { jobTitle: 'Managing Partner' }, userActor(b.users.ria), guardOf(ria), { version: leighView, timezone: 'Europe/London' });
    const at = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(saved.createdAt);
    expect(stale).toEqual({ ok: false, error: `${A} changed this contact at ${at}; reload to see it.` });
    const after = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
    expect(after).toEqual(expect.objectContaining({ phone: '+13125550111', email: 'jane.new@rivera-wealth.com', jobTitle: 'Advisor' }));
    // Reloaded, the same edit goes through, and only the title is written.
    expect(await updateContact(c.id, { jobTitle: 'Managing Partner' }, userActor(b.users.ria), guardOf(ria), { version: await detailsVersion(c.id) })).toEqual({ ok: true, id: c.id });
    expect(await lastEditFields(c.id)).toEqual(['jobTitle']);
    // The page hands the dialog that version.
    expect((await loadContactPage(c.id, alisa))!.edit.version).toBe(await detailsVersion(c.id));
  });

  it('B138: country is picked from a list; an unknown one is refused "Pick a country"; Germany stays DE, never GE', async () => {
    const choices = countryChoices();
    expect(choices[0]).toEqual({ code: 'US', name: 'United States' });
    expect(choices).toContainEqual({ code: 'DE', name: 'Germany' });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    auth.requireUser.mockResolvedValue(alisa);
    expect(await sandboxActions.updateContactAction(fd({ id: c.id, country: 'Atlantis', version: await detailsVersion(c.id) }))).toEqual({ ok: false, error: 'Pick a country.' });
    expect(await sandboxActions.updateContactAction(fd({ id: c.id, country: 'DE', version: await detailsVersion(c.id) }))).toEqual({ ok: true, message: 'Saved.' });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).country).toBe('DE');
    expect((await loadContactPage(c.id, alisa))!.countries.length).toBeGreaterThan(200);
  });

  it('B051: duplicates are checked only for identity fields that changed; a contact the CRM has too still saves', async () => {
    const p = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null } });
    const also = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: p.email, crmMatchPersonId: p.id });
    expect(await updateContact(also.id, { email: p.email, jobTitle: 'Partner' }, userActor(b.users.alisa), guardOf(alisa))).toEqual({ ok: true, id: also.id });
    expect(await lastEditFields(also.id)).toEqual(['jobTitle']);
    // Nothing that differs: nothing written, and said so.
    expect(await updateContact(also.id, { jobTitle: 'Partner' }, userActor(b.users.alisa), guardOf(alisa))).toEqual({ ok: true, id: also.id, unchanged: true });
    const other = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const taken = await updateContact(c.id, { email: other.email }, userActor(b.users.alisa), guardOf(alisa));
    expect(taken).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('already in Cold outreach') }));
  });

  it('B139: the same name at the same firm asks first, names the other contact, and saves when told to', async () => {
    await readyContact(b.users.karson.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Doe' });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Jane', lastName: 'Smith' });
    auth.requireUser.mockResolvedValue(alisa);
    const r = await sandboxActions.updateContactAction(fd({ id: c.id, lastName: 'Doe', version: await detailsVersion(c.id) }));
    expect(r).toEqual(expect.objectContaining({ ok: false, error: `Jane Doe at the same firm is already in Cold outreach, owned by ${K}. Open that contact, or save anyway if it is someone else.` }));
    expect((r as { data?: { possibleDuplicate?: string } }).data?.possibleDuplicate).toBeTruthy();
    expect(await sandboxActions.updateContactAction(fd({ id: c.id, lastName: 'Doe', saveAnyway: '1', version: await detailsVersion(c.id) }))).toEqual({ ok: true, message: 'Saved.' });
  });
});
