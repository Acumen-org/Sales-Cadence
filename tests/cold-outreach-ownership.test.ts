import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { addNote, assignContact, claimContact, setContactPod } from '@/lib/sandbox/contacts';
import { assignableOwners, leaverWork, leaverWorkWords, needsNewOwner, reassignStrandedNextActions, transferContact } from '@/lib/outreach/ownership';
import { canAct, loadColdSubject, type GuardActor } from '@/lib/outreach/guard';
import { sandboxAudienceIssues } from '@/lib/sandbox/campaigns';
import { setColdNextStep } from '@/lib/sandbox/work';
import { pendingForms } from '@/lib/calls/form';
import { pendingFormBlock } from '@/lib/calls/gate';
import { closeFormWithoutForm, handFormTo } from '@/lib/calls/form-tools';
import { setUserAccessAction, updateUserAction } from '@/lib/actions/users';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { enableBellwether, envelope, bwContact, push } from './helpers/sandbox';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * W3 (cold outreach PLAN 8.8): who owns a cold contact, what moves with it, and what happens to a
 * rep's work when their access is removed or their pods change. Each test is named after its bug.
 */

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let b: Basics;
const g = (u: { id: string; role: Role }, podIds: string[]): GuardActor => ({ id: u.id, role: u.role, podIds });
const session = (u: Basics['users']['ria'], podIds: string[] = []): SessionUser => ({ ...u, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const form = (fields: Record<string, string | string[]>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x); return fd; };

async function user(name: string, role: Role, pods: string[]) {
  return prisma.user.create({ data: { email: `${name.toLowerCase()}@cadence.local`, name, role, passwordHash: 'x', pods: { create: pods.map((podId) => ({ podId })) } } });
}

/** A cold contact in a running campaign with one pending step, and an open next step. */
async function workingContact(ownerId: string, podId: string) {
  const c = await readyContact(ownerId, podId);
  const campaign = await prisma.campaign.create({ data: { name: `Q4 Harbor ${c.id.slice(0, 4)}`, audience: 'SANDBOX', sequenceId: b.sequence.id, podId, personIds: [c.id], startDate: '2026-11-05', status: 'ACTIVE' } });
  const enrollment = await prisma.enrollment.create({ data: { sandboxContactId: c.id, foUserId: ownerId, podId, campaignId: campaign.id, sequenceId: b.sequence.id, startDate: '2026-11-05', status: 'ACTIVE', currentStep: 0, audience: 'SANDBOX' } });
  const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId: ownerId, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action: 'CALL', label: 'Call 1', dueDate: '2026-11-06', dueAt: new Date('2026-11-06T09:00:00Z'), plannedDate: '2026-11-06' } });
  const next = await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: ownerId, label: 'Call back', action: 'CALL', dueDate: '2026-11-09', crmPending: false, audience: 'SANDBOX' } });
  return { c, campaign, enrollment, task, next };
}

describe('W3: ownership and team changes', () => {
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    auth.requireUser.mockResolvedValue(session(b.users.ria));
  });

  it('B049: giving a contact to someone moves its open next step, its running campaign and that campaign\'s pending steps with it', async () => {
    const { c, enrollment, task, next } = await workingContact(b.users.karson.id, b.pods.Alisa.id);
    const r = await assignContact(c.id, b.users.alisa.id, userActor(b.users.alisa), null, g(b.users.alisa, [b.pods.Alisa.id]), b.users.karson.id);
    expect(r).toEqual(expect.objectContaining({ ok: true, moved: '1 next step and 1 campaign (1 step)' }));
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ ownerId: b.users.alisa.id, podId: b.pods.Alisa.id }));
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).foUserId).toBe(b.users.alisa.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).foUserId).toBe(b.users.alisa.id);
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: next.id } })).foUserId).toBe(b.users.alisa.id);
    // A campaign run by a pod the new owner is not in cannot follow them: the assign says so and changes nothing.
    const other = await workingContact(b.users.leigh.id, b.pods.Leigh.id);
    const refused = await assignContact(other.c.id, b.users.alisa.id, userActor(b.users.ria), b.pods.Alisa.id, g(b.users.ria, []));
    expect(refused).toEqual({ ok: false, error: expect.stringContaining('is not in Pod Leigh, which runs') });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: other.c.id } })).ownerId).toBe(b.users.leigh.id);
  });

  it('B147: a claim carries the open next step and pending steps; letting go of a contact with work is refused', async () => {
    const { c, task, next } = await workingContact(b.users.karson.id, b.pods.Alisa.id);
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { ownerId: null, claimedAt: null } });
    expect(await claimContact(c.id, { id: b.users.alisa.id, podIds: [b.pods.Alisa.id], role: 'SENIOR_FO' }, userActor(b.users.alisa))).toEqual({ ok: true, id: c.id });
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: next.id } })).foUserId).toBe(b.users.alisa.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).foUserId).toBe(b.users.alisa.id);
    const release = await assignContact(c.id, null, userActor(b.users.alisa), null, g(b.users.alisa, [b.pods.Alisa.id]));
    expect(release).toEqual({ ok: false, error: expect.stringContaining('Hand it to someone instead') });
    // With no work left it goes, and keeps its pod (B050).
    const bare = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    expect((await assignContact(bare.id, null, userActor(b.users.alisa), null, g(b.users.alisa, [b.pods.Alisa.id]))).ok).toBe(true);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: bare.id } })).toEqual(expect.objectContaining({ ownerId: null, podId: b.pods.Alisa.id }));
  });

  it('B050: the pod is kept when the new owner is in it, else becomes their only pod, else the giver chooses; it is never empty', async () => {
    const pam = await user('Pam', 'POD_MANAGER', [b.pods.Alisa.id, b.pods.Leigh.id]);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    // Pam is in Pod Alisa: the pod stays.
    expect((await transferContact(c.id, pam.id, { actor: userActor(b.users.ria), guard: g(b.users.ria, []) })).ok).toBe(true);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).podId).toBe(b.pods.Alisa.id);
    // Andrew is only in Pod Andrew: it becomes his.
    expect((await transferContact(c.id, b.users.andrew.id, { actor: userActor(b.users.ria), guard: g(b.users.ria, []) })).ok).toBe(true);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).podId).toBe(b.pods.Andrew.id);
    // Back to Pam, who is not in Pod Andrew and is in two: the giver must choose.
    const ask = await transferContact(c.id, pam.id, { actor: userActor(b.users.ria), guard: g(b.users.ria, []) });
    expect(ask).toEqual(expect.objectContaining({ ok: false, reason: 'Pam is in Pod Alisa and Pod Leigh. Choose which pod this contact belongs to.' }));
    expect((await transferContact(c.id, pam.id, { actor: userActor(b.users.ria), guard: g(b.users.ria, []), podId: b.pods.Leigh.id })).ok).toBe(true);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ ownerId: pam.id, podId: b.pods.Leigh.id }));
    // The pod picker never takes an owned contact's pod away, nor gives it one its owner is not in.
    expect(await setContactPod(c.id, null, userActor(b.users.ria), g(b.users.ria, []))).toEqual({ ok: false, error: expect.stringContaining('always has a pod') });
    expect(await setContactPod(c.id, b.pods.Andrew.id, userActor(b.users.ria), g(b.users.ria, []))).toEqual({ ok: false, error: expect.stringContaining('not in that pod') });
  });

  it('B050: the database refuses an owned contact with no pod, and a multi-pod owner\'s push and claim succeed under it', async () => {
    await expect(prisma.sandboxContact.create({ data: { source: 'MANUAL', firstName: 'No', lastName: 'Pod', ownerId: b.users.alisa.id } })).rejects.toThrow();
    const leigh2 = await prisma.user.update({ where: { id: b.users.leigh.id }, data: { pods: { create: [{ podId: b.pods.Andrew.id }] } } });
    enableBellwether();
    const pushed = await push(envelope([bwContact()], { pushedBy: { email: leigh2.email, name: leigh2.name } }));
    expect(pushed.body.results[0].result).toBe('created');
    const contact = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: pushed.body.results[0].cadenceContactId } });
    expect(contact.ownerId).toBe(leigh2.id);
    expect([b.pods.Andrew.id, b.pods.Leigh.id]).toContain(contact.podId);
    const unclaimed = await prisma.sandboxContact.create({ data: { source: 'MANUAL', firstName: 'Una', lastName: 'Claimed' } });
    expect(await claimContact(unclaimed.id, { id: leigh2.id, podIds: [b.pods.Leigh.id, b.pods.Andrew.id], role: 'SENIOR_FO' }, userActor(leigh2), b.pods.Andrew.id)).toEqual({ ok: true, id: unclaimed.id });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: unclaimed.id } })).podId).toBe(b.pods.Andrew.id);
  });

  it('B119: contacts go only to active sales reps of the contact\'s pod', async () => {
    const bea = await user('Bea', 'BIZ_OPS', []);
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const alisa = g(b.users.alisa, [b.pods.Alisa.id]);
    expect(await assignContact(c.id, b.users.leigh.id, userActor(b.users.alisa), null, alisa)).toEqual({ ok: false, error: expect.stringContaining('Leigh') });
    expect(await assignContact(c.id, b.users.ria.id, userActor(b.users.alisa), null, alisa)).toEqual({ ok: false, error: expect.stringContaining('an admin') });
    expect(await assignContact(c.id, bea.id, userActor(b.users.alisa), null, alisa)).toEqual({ ok: false, error: expect.stringContaining('in Biz Ops') });
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { active: false } });
    expect(await assignContact(c.id, b.users.karson.id, userActor(b.users.alisa), null, alisa)).toEqual({ ok: false, error: expect.stringContaining('no longer has access') });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).ownerId).toBe(b.users.alisa.id);
  });

  it('B208: the Assign list holds sales reps only, and a leader\'s only the reps of their own pods', async () => {
    await user('Bea', 'BIZ_OPS', []);
    const leader = (await assignableOwners({ id: b.users.alisa.id, role: 'SENIOR_FO', podIds: [b.pods.Alisa.id] })).map((u) => u.name);
    expect(leader.sort()).toEqual([b.users.alisa.name, b.users.karson.name].sort());
    const admin = (await assignableOwners({ id: b.users.ria.id, role: 'ADMIN', podIds: [] })).map((u) => u.name);
    expect(admin).not.toContain(b.users.ria.name);
    expect(admin).not.toContain('Bea');
    expect(admin).toEqual(expect.arrayContaining([b.users.leigh.name, b.users.daniel.name]));
    expect(await assignableOwners({ id: b.users.karson.id, role: 'JUNIOR_FO', podIds: [b.pods.Alisa.id] })).toEqual([]);
  });

  it('B193: a claim that is refused says why', async () => {
    const bea = await user('Bea', 'BIZ_OPS', []);
    const mine = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    expect(await claimContact(mine.id, { id: bea.id, podIds: [], role: 'BIZ_OPS' }, userActor(bea))).toEqual({ ok: false, error: 'Biz Ops can view cold contacts but cannot change them.' });
    expect(await claimContact(mine.id, { id: b.users.karson.id, podIds: [b.pods.Alisa.id], role: 'JUNIOR_FO' }, userActor(b.users.karson))).toEqual({ ok: false, error: 'This contact is already yours.' });
    expect(await claimContact(mine.id, { id: b.users.alisa.id, podIds: [b.pods.Alisa.id], role: 'SENIOR_FO' }, userActor(b.users.alisa))).toEqual({ ok: false, error: `${b.users.karson.name} claimed this contact first.` });
  });

  it('B149: the first write on an unclaimed contact claims it, with its open next step', async () => {
    const c = await prisma.sandboxContact.create({ data: { source: 'BELLWETHER', firstName: 'Ann', lastName: 'Unclaimed', podId: b.pods.Alisa.id } });
    const next = await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call', action: 'CALL', dueDate: '2026-11-09', crmPending: false, audience: 'SANDBOX' } });
    expect((await addNote(c.id, 'Spoke to the gatekeeper', b.users.karson, userActor(b.users.karson), g(b.users.karson, [b.pods.Alisa.id]))).ok).toBe(true);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ ownerId: b.users.karson.id, podId: b.pods.Alisa.id }));
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: next.id } })).foUserId).toBe(b.users.karson.id);
  });

  it('B092: the call form\'s next step on an unclaimed contact claims it for the caller, in its pod, with its work', async () => {
    const c = await prisma.sandboxContact.create({ data: { source: 'BELLWETHER', firstName: 'Cal', lastName: 'Unclaimed', podId: b.pods.Alisa.id, phone: '+13125550777', phoneType: 'direct' } });
    const r = await setColdNextStep(c.id, { label: 'Call again', action: 'CALL', dueDate: '2026-11-12', foUserId: b.users.karson.id }, userActor(b.users.karson), { act: 'form_next_step', guard: g(b.users.karson, [b.pods.Alisa.id]) });
    expect(r.ok).toBe(true);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ ownerId: b.users.karson.id, podId: b.pods.Alisa.id }));
    expect(await prisma.nextAction.findFirstOrThrow({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toEqual(expect.objectContaining({ foUserId: b.users.karson.id }));
  });

  it('N076: an assign made on a stale page leaves a claim that landed since alone, and says who has it', async () => {
    const c = await prisma.sandboxContact.create({ data: { source: 'BELLWETHER', firstName: 'Race', lastName: 'Contact', podId: b.pods.Alisa.id } });
    // The leader's page showed it unclaimed; Karson claims it first.
    expect((await claimContact(c.id, { id: b.users.karson.id, podIds: [b.pods.Alisa.id], role: 'JUNIOR_FO' }, userActor(b.users.karson))).ok).toBe(true);
    const late = await assignContact(c.id, b.users.alisa.id, userActor(b.users.alisa), null, g(b.users.alisa, [b.pods.Alisa.id]), null);
    expect(late).toEqual({ ok: false, error: `Just claimed by ${b.users.karson.name}. Nothing was changed; reload to see it.` });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).ownerId).toBe(b.users.karson.id);
    // On a fresh page the same assign goes, and the audit names the real previous owner.
    expect((await assignContact(c.id, b.users.alisa.id, userActor(b.users.alisa), null, g(b.users.alisa, [b.pods.Alisa.id]), b.users.karson.id)).ok).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: c.id, action: 'assigned' } });
    expect(audit.details).toEqual(expect.objectContaining({ from: b.users.karson.id, to: b.users.alisa.id }));
  });

  it('N033 N035: removing a rep\'s access hands their cold contacts over with their work, so the replacement can work them', async () => {
    const { c, enrollment, task, next } = await workingContact(b.users.karson.id, b.pods.Alisa.id);
    const r = await setUserAccessAction(form({ userId: b.users.karson.id, active: 'false', replacementId: b.users.alisa.id }));
    expect(r).toEqual({ ok: true, message: expect.stringContaining(`${b.users.alisa.name} now has 1 cold contact and 1 next step.`) });
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ ownerId: b.users.alisa.id, podId: b.pods.Alisa.id }));
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).foUserId).toBe(b.users.alisa.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).foUserId).toBe(b.users.alisa.id);
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: next.id } })).foUserId).toBe(b.users.alisa.id);
    // N035: the contact and its steps are one: the replacement may log a call and add notes.
    expect(canAct(g(b.users.alisa, [b.pods.Alisa.id]), (await loadColdSubject(c.id))!, 'note').ok).toBe(true);
  });

  it('N033: a contact in a pod the replacement is not in waits under "Needs a new owner" for that pod\'s leaders', async () => {
    const pam = await user('Pam', 'POD_MANAGER', [b.pods.Alisa.id, b.pods.Leigh.id]);
    const inLeigh = await readyContact(pam.id, b.pods.Leigh.id);
    const inAlisa = await readyContact(pam.id, b.pods.Alisa.id);
    const crm = await prisma.nextAction.create({ data: { personId: 'person-01', foUserId: pam.id, label: 'Send the deck', action: 'EMAIL', dueDate: '2026-11-10', crmPending: false, audience: 'CRM' } });
    const r = await setUserAccessAction(form({ userId: pam.id, active: 'false', replacementId: b.users.karson.id }));
    expect(r).toEqual({ ok: true, message: expect.stringContaining('1 cold contact in a pod') });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: inAlisa.id } })).ownerId).toBe(b.users.karson.id);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: inLeigh.id } })).ownerId).toBe(pam.id);
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: crm.id } })).foUserId).toBe(b.users.karson.id);
    // Pod Leigh's leaders see it; the contact counts as unclaimed for them (N017), and Assign takes it.
    expect(await needsNewOwner([b.pods.Leigh.id])).toEqual([expect.objectContaining({ userId: pam.id, name: 'Pam', contacts: 1 })]);
    expect(await needsNewOwner([b.pods.Andrew.id])).toEqual([]);
    expect((await assignContact(inLeigh.id, b.users.daniel.id, userActor(b.users.leigh), null, g(b.users.leigh, [b.pods.Leigh.id]), pam.id)).ok).toBe(true);
    expect(await needsNewOwner([b.pods.Leigh.id])).toEqual([]);
  });

  it('N034: a removed rep\'s open next actions, a booked meeting and CRM ones included, go to the replacement and the CRM ones reach the CRM again', async () => {
    const meeting = await prisma.nextAction.create({ data: { personId: 'person-02', foUserId: b.users.karson.id, label: 'Meeting', action: 'CALL', kind: 'MEETING', dueDate: '2026-11-12', crmPending: false, audience: 'CRM' } });
    await setUserAccessAction(form({ userId: b.users.karson.id, active: 'false', replacementId: b.users.alisa.id }));
    expect(await prisma.nextAction.findUniqueOrThrow({ where: { id: meeting.id } })).toEqual(expect.objectContaining({ foUserId: b.users.alisa.id, kind: 'MEETING' }));
    expect(getMockTwentyClient().writes).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'setPersonNextAction', id: 'person-02', patch: expect.objectContaining({ nextAction: 'Meeting' }) })]));
    // Next steps stranded before this release: a leader hands them on in one step.
    const old = await user('Olga', 'JUNIOR_FO', [b.pods.Alisa.id]);
    const stranded = await prisma.nextAction.create({ data: { personId: 'person-03', foUserId: old.id, label: 'Follow up', action: 'EMAIL', dueDate: '2026-11-12', crmPending: false, audience: 'CRM' } });
    await prisma.user.update({ where: { id: old.id }, data: { active: false } });
    expect(await needsNewOwner([b.pods.Alisa.id])).toEqual([expect.objectContaining({ name: 'Olga', nextSteps: 1 })]);
    const r = await reassignStrandedNextActions(old.id, b.users.alisa.id, g(b.users.alisa, [b.pods.Alisa.id]), userActor(b.users.alisa));
    expect(r).toEqual({ ok: true, moved: 1, crmIds: [stranded.id] });
    expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: stranded.id } })).foUserId).toBe(b.users.alisa.id);
  });

  it('N010: a removed rep\'s waiting call forms go to the replacement; a leader can hand one on or close it with a reason', async () => {
    const c = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    const call = await prisma.callLog.create({ data: { source: 'TWILIO_IMPORT', direction: 'OUTBOUND', status: 'COMPLETED', userId: b.users.karson.id, sandboxContactId: c.id, podId: b.pods.Alisa.id, startedAt: new Date(), formDueAt: new Date() } });
    await setUserAccessAction(form({ userId: b.users.karson.id, active: 'false', replacementId: b.users.alisa.id }));
    const after = await prisma.callLog.findUniqueOrThrow({ where: { id: call.id } });
    expect(after).toEqual(expect.objectContaining({ userId: b.users.karson.id, formUserId: b.users.alisa.id }));
    expect((await pendingForms(b.users.alisa.id)).map((f) => f.id)).toEqual([call.id]);
    expect(await pendingFormBlock(b.users.alisa.id, 'Europe/London')).toMatch(/^Fill in the form for your call with/);
    // A Senior FO cannot hand it on; an admin can, and can close it with a reason.
    expect(await handFormTo(call.id, b.users.karson.id, g(b.users.alisa, [b.pods.Alisa.id]), userActor(b.users.alisa))).toEqual({ ok: false, error: expect.stringContaining('Sales Leaders and Pod Managers') });
    const pam = await user('Pam', 'SALES_LEADER', [b.pods.Alisa.id]);
    expect(await handFormTo(call.id, pam.id, g(b.users.ria, []), userActor(b.users.ria))).toEqual({ ok: true, message: 'The form is now Pam\'s to fill in.' });
    expect(await closeFormWithoutForm(call.id, '', g(pam, [b.pods.Alisa.id]), userActor(pam))).toEqual({ ok: false, error: 'Say why this call will have no form.' });
    expect((await closeFormWithoutForm(call.id, 'Nobody spoke: wrong number', g(pam, [b.pods.Alisa.id]), userActor(pam))).ok).toBe(true);
    expect((await prisma.callLog.findUniqueOrThrow({ where: { id: call.id } })).formDoneAt).not.toBeNull();
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: call.id, action: 'form_closed' } })).details).toEqual(expect.objectContaining({ reason: 'Nobody spoke: wrong number' }));
  });

  it('N089: removing a rep who holds work needs someone to take it over, and says what it is', async () => {
    await workingContact(b.users.karson.id, b.pods.Alisa.id);
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { callerNumber: '+13125550111' } });
    const work = (await leaverWork([b.users.karson.id])).get(b.users.karson.id)!;
    expect(leaverWorkWords(work)).toBe('1 cold contact, 1 next step, 1 live enrollment and the calling number +13125550111');
    const r = await setUserAccessAction(form({ userId: b.users.karson.id, active: 'false' }));
    expect(r).toEqual({ ok: false, error: 'Choose who takes over: 1 cold contact, 1 next step, 1 live enrollment and the calling number +13125550111.' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.karson.id } })).active).toBe(true);
    // Only a sales rep can take it over.
    expect(await setUserAccessAction(form({ userId: b.users.karson.id, active: 'false', replacementId: b.users.ria.id }))).toEqual({ ok: false, error: expect.stringContaining('is not a sales rep') });
  });

  it('N107: the leaver\'s calling number is let go, or moved to whoever takes over', async () => {
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { callerNumber: '+13125550111' } });
    expect((await setUserAccessAction(form({ userId: b.users.karson.id, active: 'false' }))).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.karson.id } })).callerNumber).toBeNull();
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: b.users.karson.id, action: 'caller_number_released' } })).details).toEqual(expect.objectContaining({ number: '+13125550111' }));
    await prisma.user.update({ where: { id: b.users.daniel.id }, data: { callerNumber: '+13125550222' } });
    expect((await setUserAccessAction(form({ userId: b.users.daniel.id, active: 'false', replacementId: b.users.leigh.id, number: 'move' }))).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.users.leigh.id } })).callerNumber).toBe('+13125550222');
    // A replacement who has a line already: let it go instead.
    await prisma.user.update({ where: { id: b.users.andrew.id }, data: { callerNumber: '+13125550333' } });
    const pam = await user('Pam', 'SENIOR_FO', [b.pods.Leigh.id]);
    await prisma.user.update({ where: { id: pam.id }, data: { callerNumber: '+13125550444' } });
    expect(await setUserAccessAction(form({ userId: b.users.andrew.id, active: 'false', replacementId: pam.id, number: 'move' }))).toEqual({ ok: false, error: expect.stringContaining('already has the calling number') });
  });

  it('N090: a rep leaving a pod takes their cold contacts along, or the admin chooses where', async () => {
    const c = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    const base = { userId: b.users.karson.id, email: 'karson@cadence.local', name: b.users.karson.name, role: 'JUNIOR_FO' };
    expect((await updateUserAction(form({ ...base, podIds: [b.pods.Leigh.id] }))).ok).toBe(true);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).podId).toBe(b.pods.Leigh.id);
    // Into two new pods, neither the contact's: the admin says which.
    const refused = await updateUserAction(form({ ...base, podIds: [b.pods.Alisa.id, b.pods.Andrew.id] }));
    expect(refused).toEqual({ ok: false, error: expect.stringContaining('Choose which of their new pods it moves to') });
    expect((await updateUserAction(form({ ...base, podIds: [b.pods.Alisa.id, b.pods.Andrew.id], contactsPodId: b.pods.Andrew.id }))).ok).toBe(true);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).podId).toBe(b.pods.Andrew.id);
  });

  it('N069: a removed rep\'s contacts are left out of a campaign with the real reason', async () => {
    const c = await readyContact(b.users.karson.id, b.pods.Alisa.id);
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { active: false } });
    const { issues } = await sandboxAudienceIssues([c.id], b.pods.Alisa.id);
    expect(issues).toEqual([expect.objectContaining({ reason: `${b.users.karson.name} no longer has access: assign these contacts first` })]);
  });
});
