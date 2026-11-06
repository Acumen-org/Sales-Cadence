import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/current-user';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { failureWords, finishMoveIfSettled, preflightMove, processMoveItem, queueMove, retryFailedItems, runMoveQueue, undoMoveItem } from '@/lib/sandbox/move';
import { latestMoves, listMoves, loadMovePage, undoConfirmWords } from '@/lib/sandbox/moves-query';
import { listContacts } from '@/lib/sandbox/query';
import { optOutContact } from '@/lib/outreach/transitions';
import { pushNextAction } from '@/lib/next-actions';
import { retryFailedWrites } from '@/lib/engine/sync-retry';
import { enrollmentStatusLabel, enrollmentTone } from '@/lib/enrollment-labels';
import { membershipLabel } from '@/lib/campaign-membership';
import { runSandboxRetention } from '@/lib/sandbox/retention';
import { updateContact } from '@/lib/sandbox/contacts';
import { undoMoveAction } from '@/lib/actions/sandbox-move';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';
import { sessionOf } from './helpers/cold-campaign';

/**
 * W5 (cold outreach PLAN 4.5 and 8.6): Move to CRM and Undo, in the order of work that is the fix.
 * Each test is named after the bug it closes.
 */

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => '/cold-outreach/moves', useSearchParams: () => new URLSearchParams(), redirect: (to: string) => { throw new Error(`redirect:${to}`); }, notFound: () => { throw new Error('not found'); } }));

let b: Basics;
const actorOf = async (id: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { pods: true } });
  return { actor: toActor({ id: u.id, role: u.role, podIds: u.pods.map((p) => p.podId) }), audit: userActor(u) };
};
const mock = () => getMockTwentyClient();
const created = () => mock().writes.filter((w) => w.op === 'createPerson');

/** D3: a positive outcome, so the contact is "Ready to move", not "No conversation yet". */
async function meetingBooked(contactId: string, userId: string) {
  const call = await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId, sandboxContactId: contactId, startedAt: new Date(), formDoneAt: new Date() } });
  await prisma.callForm.create({ data: { callId: call.id, userId, outcome: 'meeting_booked', nextStep: 'meeting', nextStepDate: '2026-11-20' } });
}

async function moveOne(contactId: string, who = b.users.alisa.id, opts: { failWith?: Error } = {}) {
  const { actor, audit } = await actorOf(who);
  const q = await queueMove([{ contactId, mode: 'create', noConversation: true }], actor, audit, { label: 'Intro call', action: 'CALL', dueDate: '2026-11-20' });
  if (!q.ok) throw new Error(q.error);
  // The CRM fails once, after the dialog's check: on the worker's first call.
  if (opts.failWith) mock().failNext = opts.failWith;
  await runMoveQueue();
  return prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
}

/** A running cold campaign for the contact, with one pending step. */
async function inCampaign(contactId: string, foUserId: string, podId: string) {
  const campaign = await prisma.campaign.create({ data: { name: `Q4 Harbor ${contactId.slice(0, 4)}`, audience: 'SANDBOX', sequenceId: b.sequence.id, podId, personIds: [contactId], startDate: '2026-11-05', status: 'ACTIVE' } });
  const enrollment = await prisma.enrollment.create({ data: { sandboxContactId: contactId, foUserId, podId, campaignId: campaign.id, sequenceId: b.sequence.id, startDate: '2026-11-05', status: 'ACTIVE', currentStep: 0, audience: 'SANDBOX' } });
  const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action: 'CALL', label: 'Call 1', dueDate: '2026-11-06', dueAt: new Date('2026-11-06T09:00:00Z'), plannedDate: '2026-11-06' } });
  return { campaign, enrollment, task };
}

describe('W5: Move to CRM and Undo', () => {
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    auth.requireUser.mockResolvedValue({ ...b.users.alisa, podIds: [b.pods.Alisa.id], pods: [] });
  });

  // -------------------------------------------------------------------------
  // The dialog (preflight)
  // -------------------------------------------------------------------------

  it('B110 D3: the dialog puts each contact in its group, with one line per thing the move will do', async () => {
    const { actor } = await actorOf(b.users.alisa.id);
    const ready = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await meetingBooked(ready.id, b.users.alisa.id);
    await inCampaign(ready.id, b.users.alisa.id, b.pods.Alisa.id);
    await prisma.nextAction.create({ data: { sandboxContactId: ready.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2026-11-12', crmPending: false, audience: 'SANDBOX' } });
    const quiet = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const needs = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { companyName: null, companyDomain: null, companyWebsite: null });
    const optedOut = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { status: 'OPTED_OUT', optedOutAt: new Date() });
    const pre = await preflightMove([ready.id, quiet.id, needs.id, optedOut.id], actor);
    expect(pre.counts).toEqual({ ready: 1, no_conversation: 1, needs: 1, in_crm: 0, left_out: 1 });
    const r = pre.items.find((i) => i.contactId === ready.id)!;
    expect(r).toEqual(expect.objectContaining({ group: 'ready', signal: 'Meeting booked' }));
    expect(r.plan).toEqual(['Creates firm Rivera Wealth Partners (for 2 contacts)', expect.stringMatching(/^Ends Q4 Harbor/), expect.stringMatching(/^Keeps Call Thu, 12 Nov 2026$/)]);
    expect(pre.items.find((i) => i.contactId === quiet.id)!.plan).toContain('Gets the next step below');
    expect(pre.items.find((i) => i.contactId === optedOut.id)!.reason).toBe('Opted out');
    // Sorted by name, as the result page is (B109).
    expect(pre.items.map((i) => i.name)).toEqual([...pre.items.map((i) => i.name)].sort((a, c) => a.localeCompare(c)));
  });

  it('D3: a contact with no conversation yet is moved only after the extra confirm', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    expect(await queueMove([{ contactId: c.id, mode: 'create' }], actor, audit)).toEqual({ ok: false, error: expect.stringContaining('No conversation yet') });
    expect((await queueMove([{ contactId: c.id, mode: 'create', noConversation: true }], actor, audit)).ok).toBe(true);
  });

  it('B104: readiness warnings show for every contact in the dialog', async () => {
    const { actor } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { jobTitle: null, linkedinUrl: null, city: null, emailVerification: 'risky', productInterest: [] });
    const [item] = (await preflightMove([c.id], actor)).items;
    expect(item.warnings.map((w) => w.text)).toEqual(['No job title', 'No LinkedIn', 'No city', 'Email is only risky', 'No product interest']);
  });

  it('B107: a contact already in the CRM shows that person\'s card: owner, pod, Next Action and what matched', async () => {
    const { actor } = await actorOf(b.users.alisa.id);
    const p = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, ownerMemberId: { not: null }, podOwner: { not: null }, deletedAt: null, dnd: false, optedOut: false } });
    await prisma.personCache.update({ where: { id: p.id }, data: { nextAction: 'Send the deck', nextActionDueDate: '2026-11-15' } });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: p.email });
    const [item] = (await preflightMove([c.id], actor)).items;
    expect(item.group).toBe('in_crm');
    expect(item.crmPerson).toEqual(expect.objectContaining({ id: p.id, matchedOn: 'email', sharedLine: false, ownerName: expect.any(String), podName: expect.any(String) }));
    expect(item.plan).toEqual(expect.arrayContaining([expect.stringMatching(/^Adds history to .*, who is in the CRM$/), expect.stringMatching(/own Next Action$/)]));
  });

  it('B006: a shared office line never attaches by itself, and a CRM person another contact already points to is refused', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const p = await prisma.personCache.findFirstOrThrow({ where: { phoneE164: { not: null }, deletedAt: null, dnd: false, optedOut: false } });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: p.phoneE164, phoneType: 'office', email: 'shared.line.one@other-firm.example' });
    await meetingBooked(c.id, b.users.alisa.id);
    const [item] = (await preflightMove([c.id], actor)).items;
    expect(item).toEqual(expect.objectContaining({ group: 'ready', crmPerson: expect.objectContaining({ id: p.id, sharedLine: true }) }));
    const q = await queueMove([{ contactId: c.id }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    expect((await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } })).mode).toBe('create');
    // Ticked "same person": it attaches.
    const d = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: p.phoneE164, phoneType: 'office', email: 'shared.line.two@other-firm.example' });
    await meetingBooked(d.id, b.users.alisa.id);
    const q2 = await queueMove([{ contactId: d.id, mode: 'attach', attachPersonId: p.id }], actor, audit);
    if (!q2.ok) throw new Error(q2.error);
    expect(await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q2.moveId } })).toEqual(expect.objectContaining({ mode: 'attach', attachPersonId: p.id }));
    // One CRM person, one contact: someone moved onto the person already, so a second by email is left out.
    const e = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null, id: { not: p.id }, dnd: false, optedOut: false } });
    await readyContact(b.users.alisa.id, b.pods.Alisa.id, { status: 'MOVED', twentyPersonId: e.id, email: null, phone: null });
    const twin = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: e.email });
    const [left] = (await preflightMove([twin.id], actor)).items;
    expect(left).toEqual(expect.objectContaining({ group: 'left_out', reason: expect.stringContaining('Two contacts cannot both move onto one person') }));
  });

  it('N003: a contact who is Do not contact in the CRM, by email or by name and firm, is left out', async () => {
    const { actor } = await actorOf(b.users.alisa.id);
    const p = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, companyName: { not: null }, deletedAt: null } });
    await prisma.personCache.update({ where: { id: p.id }, data: { dnd: true } });
    mock().updatePerson(p.id, { dnd: true });
    const byEmail = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: p.email });
    const byName = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: p.firstName, lastName: p.lastName, companyName: p.companyName, email: 'other.address@elsewhere-firm.com' });
    const pre = await preflightMove([byEmail.id, byName.id], actor);
    for (const i of pre.items) expect(i).toEqual(expect.objectContaining({ group: 'left_out', reason: expect.stringContaining('Do not contact in the CRM') }));
  });

  it('B103: a contact whose call form is waiting is left out, with the call named', async () => {
    const { actor } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: new Date(), formDueAt: new Date() } });
    const [item] = (await preflightMove([c.id], actor)).items;
    expect(item).toEqual(expect.objectContaining({ group: 'left_out', reason: expect.stringMatching(/call on .* is waiting for its form/) }));
  });

  it('N017: a contact whose owner has left needs a new owner, in the dialog and again in the worker', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    const q = await queueMove([{ contactId: c.id, mode: 'create', noConversation: true }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { active: false } });
    expect(await runMoveQueue()).toEqual({ done: 0, failed: 1, dryRun: 0 });
    expect(await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } })).toEqual(expect.objectContaining({ failure: 'permanent', error: `Not moved: ${b.users.karson.name} has left. Assign a new owner, then move it again.` }));
    expect(created()).toHaveLength(0);
    const [item] = (await preflightMove([c.id], actor)).items;
    expect(item).toEqual(expect.objectContaining({ group: 'needs', missing: [{ key: 'owner', text: `${b.users.karson.name} has left: assign a new owner` }] }));
  });

  it('B112: the dialog asks the CRM once for every contact, and the queue reuses the answer', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await readyContact(b.users.alisa.id, b.pods.Alisa.id)).id);
    const find = vi.spyOn(mock(), 'findPeople');
    await preflightMove(ids, actor);
    expect(find).toHaveBeenCalledTimes(1);
    await queueMove(ids.map((contactId) => ({ contactId, noConversation: true })), actor, audit);
    expect(find).toHaveBeenCalledTimes(1);
    // An answer the CRM never gave is not read as "not in the CRM".
    find.mockRejectedValueOnce(new Error('Twenty 503'));
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    expect((await preflightMove([c.id], actor)).refused).toMatch(/^The CRM did not answer/);
    find.mockRestore();
  });

  // -------------------------------------------------------------------------
  // The queue and the worker
  // -------------------------------------------------------------------------

  it('B034: nothing on the contact changes when the move is queued, a failed move leaves its own step, and the dialog\'s step goes only to contacts without one', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const own = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const step = await prisma.nextAction.create({ data: { sandboxContactId: own.id, foUserId: b.users.alisa.id, label: 'Call back Tuesday', action: 'CALL', dueDate: '2026-11-10', crmPending: false, audience: 'SANDBOX' } });
    const bare = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const q = await queueMove([own.id, bare.id].map((contactId) => ({ contactId, noConversation: true })), actor, audit, { label: 'Intro call', action: 'CALL', dueDate: '2026-11-20' });
    if (!q.ok) throw new Error(q.error);
    expect(await prisma.nextAction.findUniqueOrThrow({ where: { id: step.id } })).toEqual(expect.objectContaining({ state: 'OPEN', label: 'Call back Tuesday' }));
    expect(await prisma.nextAction.count({ where: { sandboxContactId: bare.id } })).toBe(0);
    // The CRM fails for the first: its own step is untouched.
    mock().failNext = new Error('Twenty timed out');
    await runMoveQueue();
    const items = await prisma.sandboxMoveItem.findMany({ where: { moveId: q.moveId } });
    const failed = items.find((i) => i.state === 'FAILED')!;
    expect(failed.error).toBe('The CRM did not answer. Retry in a few minutes.');
    const done = items.find((i) => i.state === 'DONE')!;
    const doneContact = done.sandboxContactId;
    const label = doneContact === own.id ? 'Call back Tuesday' : 'Intro call';
    expect(await prisma.nextAction.findFirstOrThrow({ where: { personId: done.twentyPersonId!, state: 'OPEN' } })).toEqual(expect.objectContaining({ label, audience: 'CRM', sandboxContactId: doneContact }));
    if (failed.sandboxContactId === own.id) expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: step.id } })).state).toBe('OPEN');
  });

  it('B034: Undo puts the contact\'s own next step back', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const step = await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back Tuesday', action: 'CALL', dueDate: '2026-11-10', crmPending: false, audience: 'SANDBOX' } });
    const item = await moveOne(c.id);
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: step.id } })).state).toBe('CANCELLED');
    expect((await undoMoveItem(item.id, actor, audit)).ok).toBe(true);
    expect(await prisma.nextAction.findUniqueOrThrow({ where: { id: step.id } })).toEqual(expect.objectContaining({ state: 'OPEN', personId: null, audience: 'SANDBOX' }));
    expect(await prisma.nextAction.findFirstOrThrow({ where: { personId: item.twentyPersonId! } })).toEqual(expect.objectContaining({ state: 'CANCELLED', audience: 'CRM' }));
  });

  it('N001: a contact opted out while its CRM person is being made is not moved, and the CRM person is marked Do not contact', async () => {
    const { audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2026-11-10', crmPending: false, audience: 'SANDBOX' } });
    const { actor } = await actorOf(b.users.alisa.id);
    const q = await queueMove([{ contactId: c.id, mode: 'create', noConversation: true }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    const real = mock().createPerson.bind(mock());
    const spy = vi.spyOn(mock(), 'createPerson').mockImplementationOnce(async (input) => {
      const person = await real(input);
      await optOutContact(c.id, { source: 'contact_page', actor: audit, guard: { id: b.users.karson.id, role: 'JUNIOR_FO', podIds: [b.pods.Alisa.id] } });
      return person;
    });
    expect(await runMoveQueue()).toEqual({ done: 0, failed: 1, dryRun: 0 });
    spy.mockRestore();
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    expect(item).toEqual(expect.objectContaining({ state: 'FAILED', failure: 'permanent', error: expect.stringMatching(/^Not moved: opted out during the move/) }));
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ status: 'OPTED_OUT', twentyPersonId: null }));
    expect(await prisma.personCache.findUniqueOrThrow({ where: { id: item.twentyPersonId! } })).toEqual(expect.objectContaining({ optedOut: true }));
    expect(mock().writes).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'setPersonDnd', id: item.twentyPersonId, patch: expect.objectContaining({ dnd: true }) })]));
    expect(await prisma.nextAction.count({ where: { personId: item.twentyPersonId!, state: 'OPEN' } })).toBe(0);
    // No history went to the CRM for someone who asked not to be contacted.
    expect(mock().notes.filter((n) => n.personIds.includes(item.twentyPersonId!))).toHaveLength(0);
  });

  it('B105: a contact opted out while its move waited ends "Not moved: opted out on <date>", and Retry leaves it', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const q = await queueMove([{ contactId: c.id, mode: 'create', noConversation: true }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    await optOutContact(c.id, { source: 'contact_page', actor: audit });
    await runMoveQueue();
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    expect(item).toEqual(expect.objectContaining({ state: 'FAILED', failure: 'permanent', error: expect.stringMatching(/^Not moved: opted out on \d+ \w+ \d{4}$/) }));
    expect(await retryFailedItems(q.moveId, actor)).toEqual(expect.objectContaining({ queued: 0 }));
    expect((await loadMovePage(q.moveId, actor))!.retryable).toBe(0);
  });

  it('B100: errors read in plain words; the raw text stays in the audit log', async () => {
    expect(failureWords(Object.assign(new Error('Unique constraint failed on the fields: (`twentyPersonId`)'), { code: 'P2002' }))).toEqual({ text: expect.stringContaining('already linked to another contact'), failure: 'permanent' });
    expect(failureWords(new Error('fetch failed: ECONNRESET'))).toEqual({ text: 'The CRM did not answer. Retry in a few minutes.', failure: 'transient' });
    expect(failureWords(new Error('Cannot read properties of undefined (reading \'id\')')).text).toBe('Something went wrong moving this contact. Retry, and tell an admin if it happens again.');
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id, b.users.alisa.id, { failWith: new Error('TwentyApiError: 502 Bad Gateway') });
    expect(item.error).toBe('The CRM did not answer. Retry in a few minutes.');
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: c.id, action: 'move_failed' } })).details).toEqual(expect.objectContaining({ error: 'TwentyApiError: 502 Bad Gateway' }));
  });

  it('N018: a bounced email goes to the CRM flagged, is in the history note, shows in the dialog, and is never an Email next step', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { badEmail: true });
    await prisma.sandboxEmail.create({ data: { sandboxContactId: c.id, kind: 'BOUNCE', internetMessageId: '<bounce-1@mail>', at: new Date('2026-11-02T10:00:00Z'), subject: 'Undeliverable' } });
    const [item] = (await preflightMove([c.id], actor)).items;
    expect(item.plan).toContain('Email bounced on 2 Nov 2026: it goes to the CRM flagged');
    expect(await queueMove([{ contactId: c.id, noConversation: true }], actor, audit, { label: 'Send the deck', action: 'EMAIL', dueDate: '2026-11-20' })).toEqual({ ok: false, error: expect.stringContaining('Its email bounced') });
    const moved = await moveOne(c.id);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: moved.twentyPersonId! } })).badEmail).toBe(true);
    const history = mock().notes.find((n) => n.personIds.includes(moved.twentyPersonId!) && n.title.endsWith('Cold outreach history'))!;
    expect(history.bodyMarkdown).toContain('Email bounced on 2 Nov 2026');
  });

  it('B189: CRM notes carry the year, say who moved the contact and when, keep lines apart, and say "Cold outreach"', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { pushedByEmail: 'andrew@cadence.local', pushedByName: 'Andrew', sourceNote: 'SEC IAPD' });
    await prisma.sandboxNote.create({ data: { sandboxContactId: c.id, body: 'Prefers mornings', authorName: 'Alisa', createdAt: new Date('2026-11-03T10:00:00Z') } });
    const item = await moveOne(c.id);
    const notes = mock().notes.filter((n) => n.personIds.includes(item.twentyPersonId!));
    expect(notes.map((n) => n.title)).toEqual(expect.arrayContaining(['[Cadence] Note 3 Nov 2026 by Alisa', '[Cadence] Cold outreach history']));
    const history = notes.find((n) => n.title === '[Cadence] Cold outreach history')!.bodyMarkdown;
    expect(history).toMatch(/^From Cold outreach \(pushed from Bellwether by Andrew, \d+ \w+ \d{4}\)\. Source: SEC IAPD\n\nMoved to the CRM by .* on \d+ \w+ \d{4}/);
    const person = created()[0];
    expect(person && 'input' in person ? person.input.leadSourceNotes : '').toMatch(/In Cold outreach from \d+ \w+ \d{4}, pushed from Bellwether by Andrew/);
  });

  it('B102: an enrollment a move ended reads "Moved to CRM" in green, never a red "Removed"', async () => {
    expect(enrollmentStatusLabel({ status: 'EXITED', exitReason: 'moved_to_crm' })).toBe('Moved to CRM');
    expect(enrollmentTone({ status: 'EXITED', exitReason: 'moved_to_crm' })).toBe('green');
    expect(enrollmentStatusLabel({ status: 'EXITED', exitReason: 'opted_out' })).toBe('Opted out');
    expect(membershipLabel({ kind: 'finished', enrollmentStatus: 'EXITED', exitReason: 'moved_to_crm' } as Parameters<typeof membershipLabel>[0])).toEqual({ label: 'Moved to CRM', tone: 'green' });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const { enrollment } = await inCampaign(c.id, b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id);
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).toEqual(expect.objectContaining({ status: 'EXITED', exitReason: 'moved_to_crm', audience: 'SANDBOX' }));
    expect(item.exitedEnrollmentIds).toEqual([enrollment.id]);
  });

  it('B036: a failed move stays visible on the Moves tab and the contact, its mover is told, and Retry runs the checks again', async () => {
    const { actor } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id, b.users.alisa.id, { failWith: new Error('fetch failed') });
    expect(item.state).toBe('FAILED');
    expect((await listMoves({ state: 'failed' })).map((m) => m.id)).toEqual([item.moveId]);
    expect((await latestMoves([c.id], actor)).get(c.id)).toEqual(expect.objectContaining({ state: 'FAILED', error: 'The CRM did not answer. Retry in a few minutes.' }));
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: b.users.alisa.id, kind: 'move_finished' } })).toEqual(expect.objectContaining({ payload: expect.objectContaining({ moveId: item.moveId, done: 0, failed: 1 }) }));
    // Retry: the CRM gained the person meanwhile, so the move goes to them.
    const person = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null, dnd: false, optedOut: false } });
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { email: person.email } });
    expect(await retryFailedItems(item.moveId, actor)).toEqual({ queued: 1, refused: [] });
    expect(await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(expect.objectContaining({ state: 'QUEUED', mode: 'attach', attachPersonId: person.id }));
    await runMoveQueue();
    expect((await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe('DONE');
  });

  it('B188: Retry is open to whoever may undo: the mover, the leaders of the contact\'s pod, admins', async () => {
    const c = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    const item = await moveOne(c.id, b.users.karson.id, { failWith: new Error('fetch failed') });
    const daniel = (await actorOf(b.users.daniel.id)).actor;
    expect(await retryFailedItems(item.moveId, daniel)).toEqual({ queued: 0, refused: [expect.stringContaining('Only the person who started this move')] });
    const alisa = (await actorOf(b.users.alisa.id)).actor;
    expect((await retryFailedItems(item.moveId, alisa)).queued).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The result page
  // -------------------------------------------------------------------------

  it('B109 B186: the result page lists contacts by name, dates with the year, plurals, progress, and what was left out', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const z = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Zed' });
    const a = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Abe' });
    const out = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Out', status: 'OPTED_OUT', optedOutAt: new Date() });
    const q = await queueMove([z.id, a.id, out.id].map((contactId) => ({ contactId, noConversation: true })), actor, audit);
    if (!q.ok) throw new Error(q.error);
    await runMoveQueue();
    const page = (await loadMovePage(q.moveId, actor))!;
    expect(page.rows.map((r) => r.name.split(' ')[0])).toEqual(['Abe', 'Zed']);
    expect(page.rows[0].undoUntil).toMatch(/^\d+ \w+ \d{4}$/);
    expect(page.rows[0].detail).toMatch(/^\d+ notes? written to the CRM$/);
    expect(page.rows[0].firm).toMatch(/^(Created|Linked to) firm Rivera Wealth Partners$/);
    expect(page).toEqual(expect.objectContaining({ progress: 100, settled: true, counts: { done: 2, waiting: 0, failed: 0, undone: 0 } }));
    expect(page.leftOut).toEqual([expect.objectContaining({ contactId: out.id, reason: 'Opted out' })]);
  });

  it('B186: the result of an Undo outlives the button: it goes to the toast of the page, which the move page shows after it re-reads', async () => {
    // The button leaves the page once its move is undone, so the result rides on the address.
    const src = fs.readFileSync('src/components/sandbox/move-undo.tsx', 'utf8');
    expect(src).toContain("if (r.ok) say(text, ok ? 'ok' : 'error');");
    expect(src).not.toContain('router.refresh()');
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id, b.users.alisa.id);
    auth.requireUser.mockResolvedValue(await sessionOf(b.users.alisa.id));
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { default: MovePage } = await import('@/app/(app)/cold-outreach/moves/[id]/page');
    const words = 'Undone. Jane Doe was deleted from the CRM and is back in Cold outreach.';
    // PageFrame paints its body only once mounted in a browser, so draw what it holds.
    const page = await MovePage({ params: Promise.resolve({ id: item.moveId }), searchParams: Promise.resolve({ flash: words }) });
    const { createElement } = await import('react');
    const html = renderToStaticMarkup(createElement('div', null, (page as { props: { children: unknown } }).props.children as never));
    expect(html.replace(/&#x27;/g, "'")).toContain(words);
  });

  it('B106: Undo shows only to whoever may use it, and a refusal says who can', async () => {
    const c = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    const item = await moveOne(c.id, b.users.karson.id);
    const leigh = (await actorOf(b.users.leigh.id));
    expect((await loadMovePage(item.moveId, leigh.actor))!.rows[0].canUndo).toBe(false);
    expect((await loadMovePage(item.moveId, (await actorOf(b.users.alisa.id)).actor))!.rows[0].canUndo).toBe(true);
    const refused = await undoMoveItem(item.id, leigh.actor, leigh.audit);
    expect(refused).toEqual({ ok: false, error: `Only ${b.users.karson.name}, the Senior FOs, Sales Leaders and Pod Managers of Pod Alisa, and admins can undo this move.` });
  });

  it('B098: the Undo confirm is worded by what the move did', async () => {
    expect(undoConfirmWords('create', 'Jane Doe', 'Jane Doe')).toBe('Deletes Jane Doe from the CRM and brings Jane Doe back to Cold outreach.');
    expect(undoConfirmWords('attach', 'Erin Wu', 'Erin Wu')).toBe('Erin Wu stays in the CRM; only the history moved from here is removed. Erin Wu comes back to Cold outreach.');
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id);
    const row = (await loadMovePage(item.moveId, (await actorOf(b.users.alisa.id)).actor))!.rows[0];
    expect(row.undoConfirm).toMatch(/^Deletes .* from the CRM and brings .* back to Cold outreach\.$/);
  });

  // -------------------------------------------------------------------------
  // Undo
  // -------------------------------------------------------------------------

  it('B033: Cadence\'s own writes to the CRM person never block Undo; someone else\'s edit does', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id);
    // The next-action sync runs a minute later and bumps the person's updatedAt.
    const na = await prisma.nextAction.findFirstOrThrow({ where: { personId: item.twentyPersonId!, state: 'OPEN' } });
    await prisma.nextAction.update({ where: { id: na.id }, data: { dueDate: '2026-11-21', crmPending: true } });
    await new Promise((r) => setTimeout(r, 5));
    await pushNextAction(na.id);
    expect((await prisma.twentyWrite.findFirstOrThrow({ where: { twentyId: item.twentyPersonId!, operation: 'setPersonNextAction' }, orderBy: { createdAt: 'desc' } })).resultUpdatedAt).toBe(mock().people.find((p) => p.id === item.twentyPersonId)!.updatedAt);
    expect((await undoMoveItem(item.id, actor, audit)).ok).toBe(true);
    // A person someone edited in the CRM is kept.
    const d = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const other = await moveOne(d.id);
    mock().updatePerson(other.twentyPersonId!, { jobTitle: 'Changed in the CRM', updatedAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await undoMoveItem(other.id, actor, audit)).toEqual({ ok: false, error: expect.stringMatching(/^Someone changed .* in the CRM on/) });
  });

  it('B097: an attach writes the CRM Next Action only when the person has none, and Undo puts the old one back', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    // A person with a Next Action of their own, kept only in the CRM: the move leaves it.
    const keep = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null, dnd: false, optedOut: false } });
    mock().updatePerson(keep.id, { nextAction: 'Their renewal call', nextActionDueDate: '2026-12-01' });
    const c1 = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: keep.email });
    const q1 = await queueMove([{ contactId: c1.id, mode: 'attach' }], actor, audit, { label: 'Intro call', action: 'CALL', dueDate: '2026-11-20' });
    if (!q1.ok) throw new Error(q1.error);
    await runMoveQueue();
    expect(mock().people.find((p) => p.id === keep.id)!.nextAction).toBe('Their renewal call');
    expect(await prisma.nextAction.count({ where: { personId: keep.id, state: 'OPEN' } })).toBe(0);
    // A person with none gets the step, and Undo clears it again.
    const empty = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null, id: { not: keep.id }, dnd: false, optedOut: false } });
    mock().updatePerson(empty.id, { nextAction: null, nextActionDueDate: null });
    const c2 = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: empty.email });
    const q2 = await queueMove([{ contactId: c2.id, mode: 'attach' }], actor, audit, { label: 'Intro call', action: 'CALL', dueDate: '2026-11-20' });
    if (!q2.ok) throw new Error(q2.error);
    await runMoveQueue();
    expect(mock().people.find((p) => p.id === empty.id)!.nextAction).toBe('Intro call');
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q2.moveId } });
    expect(item.personNextBefore).toEqual({ nextAction: null, nextActionDueDate: null });
    const r = await undoMoveItem(item.id, actor, audit);
    expect(r).toEqual({ ok: true, partial: false, message: expect.stringContaining('stays in the CRM; only the history moved from here was taken off') });
    expect(mock().people.find((p) => p.id === empty.id)!.nextAction).toBeNull();
    expect(mock().people.find((p) => p.id === empty.id)!.deletedAt).toBeNull();
  });

  it('B099: Undo drops the move\'s note writes still waiting to be sent, and the outbox never sends them later', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.sandboxNote.create({ data: { sandboxContactId: c.id, body: 'A note', authorName: 'Alisa' } });
    const real = mock().createNote.bind(mock());
    vi.spyOn(mock(), 'createNote').mockImplementationOnce(async () => { throw new Error('Twenty 503'); }).mockImplementation(real);
    const item = await moveOne(c.id);
    const waiting = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "TwentyWrite" WHERE status <> 'OK' AND payload->>'cadenceMoveItemId' = ${item.id}`;
    expect(waiting).toHaveLength(1);
    expect((await undoMoveItem(item.id, actor, audit)).ok).toBe(true);
    expect(await prisma.twentyWrite.count({ where: { id: waiting[0].id } })).toBe(0);
    await retryFailedWrites({ now: new Date(Date.now() + 86_400_000), ignoreBackoff: true });
    expect(mock().notes.filter((n) => n.personIds.includes(item.twentyPersonId!))).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('B101: Undo offers the campaigns the move ended, and puts the contact back where asked, its step reopened', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const { campaign, enrollment, task } = await inCampaign(c.id, b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id);
    const row = (await loadMovePage(item.moveId, actor))!.rows[0];
    expect(row.campaigns).toEqual([{ enrollmentId: enrollment.id, name: campaign.name }]);
    const r = await undoMoveItem(item.id, actor, audit, new Date(), { restoreEnrollmentIds: [enrollment.id] });
    expect(r).toEqual(expect.objectContaining({ ok: true, message: expect.stringContaining(`Back in ${campaign.name}.`) }));
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).toEqual(expect.objectContaining({ status: 'ACTIVE', personId: null, exitReason: null, audience: 'SANDBOX' }));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('PENDING');
  });

  it('B111: two contacts at one new firm say so, and the firm goes when the last of them is undone, whichever it is', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const one = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { companyName: 'Harbor Light Advisors', companyDomain: 'harborlight.example', companyWebsite: null });
    const two = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { companyName: 'Harbor Light Advisors', companyDomain: 'harborlight.example', companyWebsite: null });
    const pre = await preflightMove([one.id, two.id], actor);
    for (const i of pre.items) expect(i.plan[0]).toBe('Creates firm Harbor Light Advisors (for 2 contacts)');
    const q = await queueMove([one.id, two.id].map((contactId) => ({ contactId, noConversation: true })), actor, audit);
    if (!q.ok) throw new Error(q.error);
    await runMoveQueue();
    const items = await prisma.sandboxMoveItem.findMany({ where: { moveId: q.moveId } });
    const creator = items.find((i) => i.companyAction === 'created')!;
    const linker = items.find((i) => i.companyAction === 'linked')!;
    expect(creator.twentyCompanyId).toBe(linker.twentyCompanyId);
    // The creator first: the firm stays while the other is there; then the other: it goes.
    await undoMoveItem(creator.id, actor, audit);
    expect(mock().companies.find((co) => co.id === creator.twentyCompanyId)!.deletedAt).toBeNull();
    await undoMoveItem(linker.id, actor, audit);
    expect(mock().companies.find((co) => co.id === creator.twentyCompanyId)!.deletedAt).not.toBeNull();
  });

  it('B113: Undo deletes the person first and stops if it cannot; notes it cannot delete leave it "Undo incomplete" until Undo finishes it', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id);
    vi.spyOn(mock(), 'deletePerson').mockRejectedValueOnce(new Error('Twenty 503'));
    expect(await undoMoveItem(item.id, actor, audit)).toEqual({ ok: false, error: 'The CRM did not answer, so nothing was undone. Try again in a few minutes.' });
    expect((await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe('DONE');
    expect(mock().notes.filter((n) => n.personIds.includes(item.twentyPersonId!)).length).toBeGreaterThan(0);
    const real = mock().deleteNote.bind(mock());
    vi.spyOn(mock(), 'deleteNote').mockImplementationOnce(async () => { throw new Error('Twenty 503'); }).mockImplementation(real);
    const partial = await undoMoveItem(item.id, actor, audit);
    expect(partial).toEqual({ ok: true, partial: true, message: expect.stringMatching(/^Undo incomplete: 1 note is still on .* in the CRM\. Undo again to finish\.$/) });
    expect(await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(expect.objectContaining({ state: 'UNDO_PARTIAL', undoReport: expect.objectContaining({ personDeleted: true, notesLeft: [expect.any(String)] }) }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ACTIVE');
    expect(await undoMoveItem(item.id, actor, audit)).toEqual({ ok: true, partial: false, message: 'Undone. Nothing from this move is left in the CRM.' });
    expect((await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe('UNDONE');
    vi.restoreAllMocks();
  });

  it('B187: Undo all undoes every item of the move still in its window, behind one confirm', async () => {
    auth.requireUser.mockResolvedValue({ ...b.users.alisa, podIds: [b.pods.Alisa.id], pods: [] });
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const ids = [(await readyContact(b.users.alisa.id, b.pods.Alisa.id)).id, (await readyContact(b.users.alisa.id, b.pods.Alisa.id)).id];
    const q = await queueMove(ids.map((contactId) => ({ contactId, noConversation: true })), actor, audit);
    if (!q.ok) throw new Error(q.error);
    await runMoveQueue();
    const page = (await loadMovePage(q.moveId, actor))!;
    expect(page.undoAll).toHaveLength(2);
    const fd = new FormData();
    for (const id of page.undoAll) fd.append('itemId', id);
    expect(await undoMoveAction(fd)).toEqual({ ok: true, message: 'Undone 2.' });
    expect(await prisma.sandboxContact.count({ where: { id: { in: ids }, status: 'ACTIVE' } })).toBe(2);
  });

  it('N062: each move keeps the undo deadline it was made with; lowering the setting later changes nothing, and the refusal names the date', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id);
    expect(item.undoUntil).toEqual(new Date(item.doneAt!.getTime() + 365 * 86_400_000));
    await prisma.setting.upsert({ where: { key: 'sandbox' }, create: { key: 'sandbox', value: { undoDays: 7 } }, update: { value: { undoDays: 7 } } });
    const { invalidateSettingsCache } = await import('@/lib/settings');
    invalidateSettingsCache();
    // Retention keeps the moved contact's data until its own deadline.
    await runSandboxRetention(new Date(item.doneAt!.getTime() + 30 * 86_400_000), { remove: true });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).piiClearedAt).toBeNull();
    expect((await undoMoveItem(item.id, actor, audit, new Date(item.doneAt!.getTime() + 30 * 86_400_000))).ok).toBe(true);
    const d = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const late = await moveOne(d.id);
    const after = new Date(late.undoUntil!.getTime() + 86_400_000);
    expect(await undoMoveItem(late.id, actor, audit, after)).toEqual({ ok: false, error: expect.stringMatching(/^This move can no longer be undone: its undo window closed on \d+ \w+ \d{4}\.$/) });
  });

  it('B108: a moved contact shows who moved it and when, the person, and Undo until its deadline; the history has the move and the undo', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id);
    expect((await latestMoves([c.id], actor)).get(c.id)).toEqual(expect.objectContaining({ state: 'DONE', moverName: b.users.alisa.name, undoUntil: expect.stringMatching(/^\d+ \w+ \d{4}$/), canUndo: true, personId: item.twentyPersonId }));
    await undoMoveItem(item.id, actor, audit);
    const actions = (await prisma.auditLog.findMany({ where: { entityType: 'sandbox_contact', entityId: c.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['move_queued', 'sandbox_moved', 'move_done', 'move_undone']));
  });

  it('B155 B051: complete details alone are never "Ready to move" in the list; a positive outcome makes it so; Closed after Not interested; an unchanged save is never refused as a duplicate', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    // S10: the list shows one status badge per contact (PLAN 4.0); complete details alone read as the state they are in.
    const alisa = await sessionOf(b.users.alisa.id);
    const row = async () => (await listContacts(alisa, { view: 'all' })).rows.find((r) => r.id === c.id)!;
    expect((await row()).badge).toEqual(expect.objectContaining({ label: 'No next step' }));
    expect((await listContacts(alisa, { view: 'ready' })).total).toBe(0);
    await meetingBooked(c.id, b.users.alisa.id);
    expect((await row()).badge).toEqual(expect.objectContaining({ label: 'Ready to move', tone: 'green' }));
    const call = await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: new Date(), formDoneAt: new Date() } });
    await prisma.callForm.create({ data: { callId: call.id, userId: b.users.alisa.id, outcome: 'not_interested', nextStep: 'none', submittedAt: new Date(Date.now() + 1000) } });
    expect((await row()).badge).toEqual(expect.objectContaining({ label: expect.stringMatching(/^Closed · Not interested/), tone: 'gray' }));
    // B051: a contact the CRM has too saves its unchanged details without a duplicate refusal.
    const p = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null } });
    const also = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: p.email, crmMatchPersonId: p.id });
    expect(await updateContact(also.id, { email: p.email, firstName: also.firstName, jobTitle: 'Partner' }, userActor(b.users.alisa), { id: b.users.alisa.id, role: 'SENIOR_FO', podIds: [b.pods.Alisa.id] })).toEqual({ ok: true, id: also.id });
  });

  it('B037: a move and its undo never change the audience a row was stamped with, so past reports never change', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const touch = await prisma.touch.create({ data: { sandboxContactId: c.id, channel: 'EMAIL', direction: 'OUTBOUND', occurredAt: new Date(), summary: 'Email sent: Hello', externalId: `graph:b037:${c.id}`, audience: 'SANDBOX' } });
    const call = await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: new Date(), audience: 'SANDBOX' } });
    const { enrollment } = await inCampaign(c.id, b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id);
    const stamps = async () => [(await prisma.touch.findUniqueOrThrow({ where: { id: touch.id } })).audience, (await prisma.callLog.findUniqueOrThrow({ where: { id: call.id } })).audience, (await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).audience];
    expect(await stamps()).toEqual(['SANDBOX', 'SANDBOX', 'SANDBOX']);
    expect((await prisma.touch.findUniqueOrThrow({ where: { id: touch.id } })).personId).toBe(item.twentyPersonId);
    expect(await prisma.nextAction.findFirstOrThrow({ where: { personId: item.twentyPersonId! } })).toEqual(expect.objectContaining({ audience: 'CRM' }));
    await undoMoveItem(item.id, actor, audit);
    expect(await stamps()).toEqual(['SANDBOX', 'SANDBOX', 'SANDBOX']);
    expect((await prisma.touch.findUniqueOrThrow({ where: { id: touch.id } })).personId).toBeNull();
  });

  it('B035: a tall dialog fits the window, so its buttons stay in view at 1280x800', () => {
    const css = fs.readFileSync('src/app/globals.css', 'utf8');
    expect(css).toMatch(/\.cadence-modal \{[^}]*max-height: calc\(100dvh - 12vh - 24px\)/);
    const dialog = fs.readFileSync('src/components/sandbox/move-dialog.tsx', 'utf8');
    expect(dialog).toContain('max-h-[calc(100dvh-12vh-26px)] flex-col');
    expect(dialog).toContain('min-h-0 flex-1');
  });

  it('B005: a move finished elsewhere is never worked twice, and its mover is told once', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const item = await moveOne(c.id);
    expect(await processMoveItem(item.id)).toBe('CLAIMED_ELSEWHERE');
    await finishMoveIfSettled(item.moveId);
    expect(await prisma.notification.count({ where: { kind: 'move_finished' } })).toBe(1);
    expect(created()).toHaveLength(1);
  });
});
