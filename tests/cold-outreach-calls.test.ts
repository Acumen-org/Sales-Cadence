import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { FakeTwilio } from '@/lib/calls/fake-twilio';
import { importTwilioCalls, IMPORT_RUNNING, LEASE_KEY } from '@/lib/calls/import';
import { logManualCall, pendingForms, submitCallForm, validateCallForm } from '@/lib/calls/form';
import { callFormContext, discardCall } from '@/lib/calls/form-context';
import { matchContact, matchRep } from '@/lib/calls/match';
import { stepByRule } from '@/lib/calls/link';
import { callingHours, zoneFor } from '@/lib/calls/hours';
import { pendingFormBlock } from '@/lib/calls/gate';
import { callTimeWords } from '@/lib/calls/words';
import { completeCall } from '@/lib/engine/outcomes';
import { acceptSuggestion, openSuggestions } from '@/lib/outreach/suggestions';
import { optOutContact } from '@/lib/outreach/transitions';
import { setColdNextStep } from '@/lib/sandbox/work';
import { DEFAULT_SETTINGS, saveSettingsSection } from '@/lib/settings';
import { resetEnvCache } from '@/lib/env';
import { MOCK_PEOPLE } from '@/lib/twenty/fixtures';
import { toE164 } from '@/lib/sandbox/normalize';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { addCallContactAction, assignCallRepAction, chooseCallContactAction, importCallsNowAction, logManualCallAction, setCallerNumberAction } from '@/lib/actions/call-forms';
import { completeNextActionAction } from '@/lib/actions/next-actions';
import { formsWaiting } from '@/lib/calls/analytics';
import { mayHearCall } from '@/lib/calls/access';
import { callOutcomes, logCallOutcomes, outcomeLabel } from '@/lib/call-outcomes';
import { dispositionFor } from '@/lib/engine/outcomes';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * W4 (cold outreach PLAN 4.6 and 8.7): calls and the post-call form, for CRM people and cold contacts
 * alike. Each test is named after its bug.
 */

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const rules = DEFAULT_SETTINGS.rules;
const ALISA_LINE = '+13125550100';
const T0 = new Date('2026-11-03T15:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const iso = (min: number) => at(min).toISOString();
const form = (fields: Record<string, string | string[]>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x); return fd; };

let b: Basics;
let fake: FakeTwilio;
const session = (u: Basics['users']['alisa'], podIds: string[] = []): SessionUser => ({ ...u, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const alisa = () => ({ id: b.users.alisa.id, name: b.users.alisa.name, timezone: 'Europe/London', role: 'SENIOR_FO' as Role, podIds: [b.pods.Alisa.id] });
const karson = () => ({ id: b.users.karson.id, name: b.users.karson.name, timezone: 'Europe/London', role: 'JUNIOR_FO' as Role, podIds: [b.pods.Alisa.id] });

/** A cold contact (or CRM person) in a running campaign with one pending Call step due on `due`. */
async function inCampaign(subject: { sandboxContactId?: string; personId?: string }, foUserId: string, due: string, action: 'CALL' | 'EMAIL' = 'CALL') {
  const audience = subject.personId ? 'CRM' : 'SANDBOX';
  const campaign = await prisma.campaign.create({ data: { name: `Q4 Harbor ${Math.random().toString(36).slice(2, 6)}`, audience, sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [subject.personId ?? subject.sandboxContactId!], startDate: '2026-11-02', status: 'ACTIVE' } });
  const enrollment = await prisma.enrollment.create({ data: { ...subject, foUserId, podId: b.pods.Alisa.id, campaignId: campaign.id, sequenceId: b.sequence.id, startDate: '2026-11-02', status: 'ACTIVE', currentStep: 0, currentStepId: 's1', audience } });
  const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action, label: action === 'CALL' ? 'Call 1' : 'Email 1', dueDate: due, dueAt: new Date(`${due}T09:00:00Z`), plannedDate: due } });
  return { campaign, enrollment, task };
}

async function bizOps() {
  return prisma.user.create({ data: { email: 'bea@cadence.local', name: 'Bea Ops', role: 'BIZ_OPS', passwordHash: 'x' } });
}

describe('W4: calls and the post-call form', () => {
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    fake = new FakeTwilio();
    await prisma.user.update({ where: { id: b.users.alisa.id }, data: { callerNumber: ALISA_LINE } });
    auth.requireUser.mockResolvedValue(session(b.users.alisa, [b.pods.Alisa.id]));
    await importTwilioCalls({ reader: fake, now: T0 });
  });

  describe('which step a call closes (PLAN 8.7)', () => {
    it('B023: a call made from the dialpad, with no Call button, closes the one call step due, and its form ends the campaign', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550171', phoneType: 'direct' });
      const { task, enrollment } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id, '2026-11-03');
      fake.addCall({ from: ALISA_LINE, to: '+13125550171', startTime: iso(1), endTime: iso(4), durationSec: 170 });
      await importTwilioCalls({ reader: fake, now: at(5) });
      const call = await prisma.callLog.findFirstOrThrow();
      expect(call).toEqual(expect.objectContaining({ taskId: task.id, matchedBy: 'number', enrollmentId: enrollment.id }));
      const r = await submitCallForm(call.id, { outcome: 'connected', rating: 4, notes: 'Wants a deck', nextStep: 'email', nextStepDate: '2026-11-06' }, alisa(), at(6));
      expect(r.ok).toBe(true);
      expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(expect.objectContaining({ state: 'DONE', disposition: 'connected' }));
      expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('REPLIED');
      // The rep's own next step, with no parallel one beside the campaign's.
      expect(await prisma.nextAction.findMany({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toEqual([expect.objectContaining({ action: 'EMAIL', dueDate: '2026-11-06' })]);
    });

    it('B023: Monday\'s call never closes next week\'s step, and two steps due make the form ask', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550172', phoneType: 'direct' });
      const { enrollment } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id, '2026-11-10');
      fake.addCall({ from: ALISA_LINE, to: '+13125550172', startTime: iso(1), endTime: iso(3), durationSec: 90 });
      await importTwilioCalls({ reader: fake, now: at(4) });
      expect((await prisma.callLog.findFirstOrThrow()).taskId).toBeNull();
      await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2026-11-02', crmPending: false, audience: 'SANDBOX' } });
      await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId: b.users.alisa.id, stepIndex: 1, stepId: 's2', stepDay: 2, actionIndex: 0, actionId: 'a2', action: 'CALL', label: 'Call 1', dueDate: '2026-11-03', dueAt: new Date('2026-11-03T09:00:00Z'), plannedDate: '2026-11-03' } });
      const call = await prisma.callLog.findFirstOrThrow();
      expect(await stepByRule(call)).toBeNull();
      const ctx = await callFormContext(call.id, { id: b.users.alisa.id, timezone: 'Europe/London' }, at(5));
      expect(ctx.ok && ctx.context.closes.choices.map((x) => x.words)).toEqual([expect.stringMatching(/^Call/), expect.stringMatching(/^Call 1 of Q4 Harbor/)]);
    });

    it('B023: a call by someone who is neither the step\'s rep nor the owner, or an unanswered one, closes nothing by itself', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550173', phoneType: 'direct' });
      await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id, '2026-11-03');
      await prisma.user.update({ where: { id: b.users.leigh.id }, data: { callerNumber: '+13125550101' } });
      fake.addCall({ from: '+13125550101', to: '+13125550173', startTime: iso(1), endTime: iso(3), durationSec: 90 });
      fake.addCall({ from: ALISA_LINE, to: '+13125550173', status: 'no-answer', startTime: iso(5), endTime: iso(6), durationSec: 0 });
      await importTwilioCalls({ reader: fake, now: at(7) });
      expect((await prisma.callLog.findMany()).map((x) => x.taskId)).toEqual([null, null]);
    });

    it('N013: a Call pressed on an Email step never ties the call to it; a Call step pressed wins over the rule', async () => {
      const person = MOCK_PEOPLE[5];
      const email = await inCampaign({ personId: person.id }, b.users.alisa.id, '2026-11-03', 'EMAIL');
      await prisma.callIntent.create({ data: { userId: b.users.alisa.id, toNumber: toE164(person.phone)!, personId: person.id, taskId: email.task.id, createdAt: at(0) } });
      fake.addCall({ from: ALISA_LINE, to: person.phone!, startTime: iso(1), endTime: iso(3), durationSec: 80 });
      await importTwilioCalls({ reader: fake, now: at(4) });
      const call = await prisma.callLog.findFirstOrThrow();
      expect(call).toEqual(expect.objectContaining({ matchedBy: 'dialed', personId: person.id, taskId: null }));
      await submitCallForm(call.id, { outcome: 'connected', rating: 3, notes: 'Sent the deck', nextStep: 'email', nextStepDate: '2026-11-06' }, alisa(), at(5));
      expect(await prisma.task.findUniqueOrThrow({ where: { id: email.task.id } })).toEqual(expect.objectContaining({ disposition: null, twentyNoteId: null }));
    });

    it('N013: the intent\'s call step wins over "exactly one due"', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550174', phoneType: 'direct' });
      const later = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id, '2026-11-12');
      await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2026-11-02', crmPending: false, audience: 'SANDBOX' } });
      await prisma.callIntent.create({ data: { userId: b.users.alisa.id, toNumber: '+13125550174', sandboxContactId: c.id, taskId: later.task.id, createdAt: at(0) } });
      fake.addCall({ from: ALISA_LINE, to: '+13125550174', startTime: iso(1), endTime: iso(3), durationSec: 80 });
      await importTwilioCalls({ reader: fake, now: at(4) });
      expect(await prisma.callLog.findFirstOrThrow()).toEqual(expect.objectContaining({ taskId: later.task.id, nextActionId: null }));
    });

    it('B093: an incoming call opens a form only when answered, and never closes a step', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550175', phoneType: 'direct' });
      await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id, '2026-11-03');
      fake.addCall({ from: '+13125550175', to: ALISA_LINE, direction: 'inbound', status: 'no-answer', startTime: iso(1), endTime: iso(2), durationSec: 0 });
      fake.addCall({ from: '+13125550175', to: ALISA_LINE, direction: 'inbound', status: 'completed', startTime: iso(10), endTime: iso(12), durationSec: 95 });
      await importTwilioCalls({ reader: fake, now: at(13) });
      const calls = await prisma.callLog.findMany({ orderBy: { startedAt: 'asc' } });
      expect(calls.map((x) => [x.direction, Boolean(x.formDueAt), x.taskId])).toEqual([['INBOUND', false, null], ['INBOUND', true, null]]);
      expect(await pendingFormBlock(b.users.alisa.id, 'Europe/London', at(14))).toMatch(/^Fill in the form for your call from /);
      // The answered one keeps the current step when the rep says so.
      await setColdNextStep(c.id, { label: 'Email the deck', action: 'EMAIL', dueDate: '2026-11-09', foUserId: b.users.alisa.id }, userActor(b.users.alisa));
      const r = await submitCallForm(calls[1].id, { outcome: 'connected', rating: 4, notes: 'Rang back', nextStep: 'keep' }, alisa(), at(15));
      expect(r.ok).toBe(true);
      expect((await prisma.nextAction.findFirstOrThrow({ where: { sandboxContactId: c.id, state: 'OPEN' } })).label).toBe('Email the deck');
    });
  });

  describe('recording a call once', () => {
    it('B043: one answered call from a call step is one touch and one reply', async () => {
      const person = MOCK_PEOPLE[6];
      const { task } = await inCampaign({ personId: person.id }, b.users.alisa.id, '2026-11-03');
      await prisma.callIntent.create({ data: { userId: b.users.alisa.id, toNumber: toE164(person.phone)!, personId: person.id, taskId: task.id, createdAt: at(0) } });
      fake.addCall({ from: ALISA_LINE, to: person.phone!, startTime: iso(1), endTime: iso(4), durationSec: 150 });
      await importTwilioCalls({ reader: fake, now: at(5) });
      const call = await prisma.callLog.findFirstOrThrow();
      await submitCallForm(call.id, { outcome: 'connected', rating: 4, notes: 'Good chat', nextStep: 'call_again', nextStepDate: '2026-11-09' }, alisa(), at(6));
      const touches = await prisma.touch.findMany({ where: { personId: person.id, channel: 'CALL' } });
      expect(touches).toHaveLength(1);
      expect(touches[0].summary).toBe('Answered call: Connected');
      expect(await prisma.touch.count({ where: { externalId: `task:${task.id}` } })).toBe(0);
    });

    it('N014: Twilio import joins the Log call record: one call, one CRM note, one reply, no second form', async () => {
      const person = MOCK_PEOPLE[7];
      const { task } = await inCampaign({ personId: person.id }, b.users.alisa.id, '2026-11-03');
      // Alisa presses Call on the step, then records it with the CRM's quick Log call.
      await prisma.callIntent.create({ data: { userId: b.users.alisa.id, toNumber: toE164(person.phone)!, personId: person.id, taskId: task.id, createdAt: at(0) } });
      await completeCall({ taskId: task.id, disposition: 'connected', note: 'Logged in Tasks' }, { actor: userActor(b.users.alisa), now: at(4) });
      const notesBefore = getMockTwentyClient().writes.filter((w) => w.op === 'createNote').length;
      fake.addCall({ from: ALISA_LINE, to: person.phone!, startTime: iso(1), endTime: iso(3), durationSec: 120 });
      await importTwilioCalls({ reader: fake, now: at(6) });
      const calls = await prisma.callLog.findMany();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(expect.objectContaining({ taskId: task.id, formDueAt: null }));
      expect(calls[0].formDoneAt).not.toBeNull();
      expect(await pendingForms(b.users.alisa.id)).toHaveLength(0);
      const touches = await prisma.touch.findMany({ where: { personId: person.id, channel: 'CALL' } });
      expect(touches).toHaveLength(1);
      expect(touches[0].summary).toMatch(/^Answered call:/);
      expect(getMockTwentyClient().writes.filter((w) => w.op === 'createNote').length).toBe(notesBefore);
    });

    it('N014: a call logged by hand with Log a call is the call Twilio reads back: one record, one form', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550176', phoneType: 'direct' });
      const logged = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: at(1), talkSec: 60 }, at(4));
      fake.addCall({ from: ALISA_LINE, to: '+13125550176', startTime: iso(1), endTime: iso(3), durationSec: 110 });
      await importTwilioCalls({ reader: fake, now: at(5) });
      const calls = await prisma.callLog.findMany();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(expect.objectContaining({ id: logged.id, source: 'MANUAL', talkSec: 110, twilioCallSid: expect.stringMatching(/^CA/) }));
      expect(await pendingForms(b.users.alisa.id)).toHaveLength(1);
    });

    it('N014: CRM Log call stays as it is: a quick result, with no form', async () => {
      const person = MOCK_PEOPLE[8];
      const { task } = await inCampaign({ personId: person.id }, b.users.alisa.id, '2026-11-03');
      const r = await completeCall({ taskId: task.id, disposition: 'voicemail' }, { actor: userActor(b.users.alisa) });
      expect(r.ok).toBe(true);
      expect(await prisma.callLog.count()).toBe(0);
      expect(await pendingForms(b.users.alisa.id)).toHaveLength(0);
    });

    it('N054: a call for a CRM call next action marks it done first; a repeating one rolls on; the form\'s step is set after', async () => {
      const person = MOCK_PEOPLE[9];
      const weekly = await prisma.nextAction.create({ data: { personId: person.id, foUserId: b.users.alisa.id, label: 'Weekly check-in', action: 'CALL', dueDate: '2026-11-03', repeat: 'WEEKLY', crmPending: false, audience: 'CRM' } });
      fake.addCall({ from: ALISA_LINE, to: person.phone!, startTime: iso(1), endTime: iso(3), durationSec: 95 });
      await importTwilioCalls({ reader: fake, now: at(4) });
      const call = await prisma.callLog.findFirstOrThrow();
      expect(call.nextActionId).toBe(weekly.id);
      const r = await submitCallForm(call.id, { outcome: 'voicemail', nextStep: 'keep' }, alisa(), at(5));
      expect(r.ok).toBe(true);
      expect(await prisma.nextAction.findUniqueOrThrow({ where: { id: weekly.id } })).toEqual(expect.objectContaining({ state: 'OPEN', doneCount: 1, dueDate: '2026-11-10' }));

      const once = await prisma.nextAction.update({ where: { id: weekly.id }, data: { repeat: 'NONE', dueDate: '2026-11-03' } });
      fake.addCall({ from: ALISA_LINE, to: person.phone!, startTime: iso(20), endTime: iso(23), durationSec: 95 });
      await importTwilioCalls({ reader: fake, now: at(24) });
      const second = await prisma.callLog.findFirstOrThrow({ where: { formDoneAt: null } });
      await submitCallForm(second.id, { outcome: 'connected', rating: 4, notes: 'Wants an email', nextStep: 'email', nextStepDate: '2026-11-06' }, alisa(), at(25));
      expect(await prisma.nextAction.findUniqueOrThrow({ where: { id: once.id } })).toEqual(expect.objectContaining({ state: 'DONE', doneCount: 2 }));
      expect(await prisma.nextAction.findFirstOrThrow({ where: { personId: person.id, state: 'OPEN' } })).toEqual(expect.objectContaining({ action: 'EMAIL', dueDate: '2026-11-06' }));
    });
  });

  describe('matching a call to a person', () => {
    it('B029: a call to an opted-out contact is matched to them and flagged on the form', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550177', phoneType: 'direct' });
      await optOutContact(c.id, { source: 'contact_page', actor: userActor(b.users.alisa) });
      expect(await matchContact('+13125550177', b.users.alisa.id)).toEqual({ matchedBy: 'number', personId: null, sandboxContactId: c.id });
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
      const ctx = await callFormContext(call.id, { id: b.users.alisa.id, timezone: 'Europe/London' });
      expect(ctx.ok && ctx.context.who).toEqual(expect.objectContaining({ active: false, standing: expect.stringContaining('asked not to be contacted') }));
      await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'none' }, alisa());
      expect((await prisma.callForm.findUniqueOrThrow({ where: { callId: call.id } })).flags).toEqual(['called_opted_out']);
    });

    it('B030: a number of any type held by one live contact matches; a live contact wins over an opted-out one', async () => {
      const office = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550178', phoneType: 'unknown' });
      expect(await matchContact('+13125550178', null)).toEqual({ matchedBy: 'number', personId: null, sandboxContactId: office.id });
      const gone = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550179', phoneType: 'office', status: 'OPTED_OUT' });
      const live = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550179', phoneType: 'mobile' });
      expect(await matchContact('+13125550179', null)).toEqual({ matchedBy: 'number', personId: null, sandboxContactId: live.id });
      expect(gone.id).not.toBe(live.id);
    });

    it('B018: a firm\'s main line always asks who it was with, even with one person known on it', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550180', phoneType: 'main' });
      expect(await matchContact('+13125550180', b.users.alisa.id)).toEqual({ matchedBy: 'ambiguous', candidates: [{ kind: 'sandbox', id: c.id, name: `${c.firstName} ${c.lastName}` }] });
      const other = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550181', companyPhone: '+13125550182' });
      expect((await matchContact('+13125550182', null)).matchedBy).toBe('ambiguous');
      expect(other.id).toBeTruthy();
    });

    it('B026: an unmatched call saves no next step until the rep says who it was with, or adds them', async () => {
      fake.addCall({ from: ALISA_LINE, to: '+16175550123', startTime: iso(1), endTime: iso(3), durationSec: 70 });
      await importTwilioCalls({ reader: fake, now: at(4) });
      const call = await prisma.callLog.findFirstOrThrow();
      expect(call).toEqual(expect.objectContaining({ matchedBy: 'none', userId: b.users.alisa.id }));
      expect(await submitCallForm(call.id, { outcome: 'connected', rating: 3, notes: 'Who knows', nextStep: 'email', nextStepDate: '2026-11-06' }, alisa(), at(5))).toEqual(expect.objectContaining({ ok: false, field: 'nextStep', error: expect.stringContaining('Say who it was with') }));
      const r = await addCallContactAction(form({ callId: call.id, firstName: 'Nora', lastName: 'Quinn', companyName: 'Quinn Capital' }));
      expect(r).toEqual(expect.objectContaining({ ok: true }));
      const matched = await prisma.callLog.findUniqueOrThrow({ where: { id: call.id }, include: { sandboxContact: true } });
      expect(matched.sandboxContact).toEqual(expect.objectContaining({ firstName: 'Nora', source: 'CALL', phone: '+16175550123', ownerId: b.users.alisa.id }));
      expect((await submitCallForm(call.id, { outcome: 'connected', rating: 3, notes: 'Keen', nextStep: 'call_again', nextStepDate: '2099-01-06' }, alisa())).ok).toBe(true);
    });

    it('B026: the rep can name a CRM person or a cold contact for their own call', async () => {
      fake.addCall({ from: ALISA_LINE, to: '+16175550124', startTime: iso(1), endTime: iso(3), durationSec: 70 });
      await importTwilioCalls({ reader: fake, now: at(4) });
      const call = await prisma.callLog.findFirstOrThrow();
      expect(await chooseCallContactAction(form({ callId: call.id, contact: `person:${MOCK_PEOPLE[3].id}` }))).toEqual({ ok: true, message: 'Matched.' });
      expect(await prisma.callLog.findUniqueOrThrow({ where: { id: call.id } })).toEqual(expect.objectContaining({ personId: MOCK_PEOPLE[3].id, matchedBy: 'chosen', audience: 'CRM' }));
    });
  });

  describe('the form', () => {
    it('B025: from 30 seconds of talk, No answer and Busy are refused; Voicemail and Gatekeeper are fine; a long voicemail is flagged to leaders', () => {
      const ctx = { rules, today: '2026-11-03', talkSec: 192, connectSeconds: 30 };
      expect(validateCallForm({ outcome: 'no_answer', nextStep: 'none' }, ctx)).toEqual(expect.objectContaining({ ok: false, field: 'outcome', error: expect.stringContaining('This call lasted 3m 12s') }));
      expect(validateCallForm({ outcome: 'busy', nextStep: 'none' }, ctx).ok).toBe(false);
      expect(validateCallForm({ outcome: 'voicemail', nextStep: 'none' }, ctx).ok).toBe(true);
      expect(validateCallForm({ outcome: 'gatekeeper', nextStep: 'none' }, ctx).ok).toBe(true);
      expect(validateCallForm({ outcome: 'no_conversation', nextStep: 'none' }, ctx)).toEqual(expect.objectContaining({ ok: false, field: 'notes' }));
      expect(validateCallForm({ outcome: 'no_conversation', notes: 'A fax machine', nextStep: 'none' }, ctx).ok).toBe(true);
      expect(validateCallForm({ outcome: 'no_answer', nextStep: 'none' }, { ...ctx, talkSec: 12 }).ok).toBe(true);
    });

    it('B025: talk time is the answered leg\'s, not the dialpad\'s ringing; a long voicemail goes to the pod\'s leaders', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550183', phoneType: 'direct' });
      const parent = fake.addCall({ from: 'client:tw_alisa', to: '+13125550183', direction: 'inbound', startTime: iso(1), endTime: iso(5), durationSec: 240 });
      fake.addCall({ from: ALISA_LINE, to: '+13125550183', parentCallSid: parent.sid, startTime: iso(1), endTime: iso(5), durationSec: 150 });
      await importTwilioCalls({ reader: fake, now: at(6) });
      const call = await prisma.callLog.findFirstOrThrow();
      expect(call.talkSec).toBe(150);
      const leader = await prisma.user.create({ data: { email: 'pam@cadence.local', name: 'Pam Lead', role: 'POD_MANAGER', passwordHash: 'x', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
      await submitCallForm(call.id, { outcome: 'voicemail', nextStep: 'call_again', nextStepDate: '2026-11-05' }, alisa(), at(7));
      expect((await prisma.callForm.findUniqueOrThrow({ where: { callId: call.id } })).flags).toEqual(['long_voicemail']);
      expect(await prisma.notification.findFirst({ where: { userId: leader.id, kind: 'call_flag' } })).toEqual(expect.objectContaining({ payload: expect.objectContaining({ text: expect.stringContaining('voicemail') }) }));
      expect(c.id).toBeTruthy();
    });

    it('B028: a booked meeting is never "No further action"; B183: it is saved as a meeting, with its time', async () => {
      expect(validateCallForm({ outcome: 'meeting_booked', rating: 5, notes: 'Booked', nextStep: 'none' }, { rules, today: '2026-11-03' })).toEqual(expect.objectContaining({ ok: false, field: 'nextStep' }));
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
      const r = await submitCallForm(call.id, { outcome: 'meeting_booked', rating: 5, notes: 'Demo booked', nextStep: 'meeting', nextStepDate: '2099-01-07', meetingTime: '14:30' }, alisa());
      expect(r).toEqual(expect.objectContaining({ ok: true, followUp: { addMeeting: null, moveToCrm: `/sandbox/${c.id}?move=1` } }));
      const next = await prisma.nextAction.findFirstOrThrow({ where: { sandboxContactId: c.id, state: 'OPEN' } });
      expect(next).toEqual(expect.objectContaining({ kind: 'MEETING', dueDate: '2099-01-07', label: 'Meeting' }));
      expect(next.meetingAt?.toISOString()).toBe('2099-01-07T14:30:00.000Z');
    });

    it('N061: after Meeting booked for a CRM person, the form offers Add meeting for them', async () => {
      const call = await logManualCall({ userId: b.users.alisa.id, personId: MOCK_PEOPLE[2].id });
      const r = await submitCallForm(call.id, { outcome: 'meeting_booked', rating: 5, notes: 'Booked', nextStep: 'meeting', nextStepDate: '2099-01-07' }, alisa());
      expect(r).toEqual(expect.objectContaining({ ok: true, followUp: { addMeeting: `/meetings/new?personId=${MOCK_PEOPLE[2].id}`, moveToCrm: null } }));
    });

    it('N043: the form\'s "What" becomes the next step\'s label, and the result names the next step', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
      const r = await submitCallForm(call.id, { outcome: 'connected', rating: 4, notes: 'Wants a deck by email\nand a call', nextStep: 'email', nextStepDate: '2099-01-05', what: 'Follow up: Wants a deck by email' }, alisa());
      expect(r).toEqual(expect.objectContaining({ ok: true, message: expect.stringMatching(/^Saved\. Next: Follow up: Wants a deck by email on /) }));
      expect((await prisma.nextAction.findFirstOrThrow({ where: { sandboxContactId: c.id, state: 'OPEN' } })).label).toBe('Follow up: Wants a deck by email');
      expect((await prisma.callForm.findUniqueOrThrow({ where: { callId: call.id } })).nextStepLabel).toBe('Follow up: Wants a deck by email');
    });

    it('B091: "Asked not to be contacted" on a campaign call ends it as Opted out, never Replied, and is no reply', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550184', phoneType: 'direct' });
      const { task, enrollment } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id, '2026-11-03');
      fake.addCall({ from: ALISA_LINE, to: '+13125550184', startTime: iso(1), endTime: iso(3), durationSec: 60 });
      await importTwilioCalls({ reader: fake, now: at(4) });
      const call = await prisma.callLog.findFirstOrThrow();
      const r = await submitCallForm(call.id, { outcome: 'do_not_contact', rating: 1, notes: 'Stop calling', nextStep: 'none' }, alisa(), at(5));
      expect(r).toEqual(expect.objectContaining({ ok: true, message: expect.stringContaining('is opted out') }));
      expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).toEqual(expect.objectContaining({ status: 'EXITED', exitReason: 'opted_out' }));
      expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(expect.objectContaining({ state: 'DONE', disposition: 'do_not_contact' }));
      expect(await prisma.touch.count({ where: { sandboxContactId: c.id, summary: { startsWith: 'Answered call' } } })).toBe(0);
      expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ status: 'OPTED_OUT', optOutSource: 'call_form' }));
    });

    it('B004: a form for a contact removed since the call saves the call and form, sets no next step and says why', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
      await optOutContact(c.id, { source: 'contact_page', actor: userActor(b.users.alisa) });
      const r = await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: '2099-01-05' }, alisa());
      expect(r).toEqual(expect.objectContaining({ ok: true, reminder: expect.stringContaining('No next step was set') }));
      expect(await prisma.callForm.count({ where: { callId: call.id } })).toBe(1);
      expect(await prisma.nextAction.count({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toBe(0);
    });

    it('B092: saving a form for an unclaimed contact claims it, unless the rep unticks it', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null, claimedAt: null });
      const call = await logManualCall({ userId: b.users.karson.id, sandboxContactId: c.id });
      const ctx = await callFormContext(call.id, { id: b.users.karson.id, timezone: 'Europe/London' });
      expect(ctx.ok && ctx.context.claim).toBe(`Saving claims ${c.firstName} for you.`);
      await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: '2099-01-05', claim: true }, karson());
      expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).ownerId).toBe(b.users.karson.id);
      const other = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null, claimedAt: null });
      const second = await logManualCall({ userId: b.users.karson.id, sandboxContactId: other.id });
      const r = await submitCallForm(second.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: '2099-01-05', claim: false }, karson());
      expect(r).toEqual(expect.objectContaining({ ok: true, reminder: expect.stringContaining('stays unclaimed') }));
      expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: other.id } })).ownerId).toBeNull();
    });

    it('B027: a colleague\'s step goes to the owner as a suggestion; accepting it runs the same checks as setting one', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      await setColdNextStep(c.id, { label: 'Meeting prep', action: 'EMAIL', dueDate: '2099-01-09', foUserId: b.users.alisa.id }, userActor(b.users.alisa));
      const call = await logManualCall({ userId: b.users.karson.id, sandboxContactId: c.id });
      const ctx = await callFormContext(call.id, { id: b.users.karson.id, timezone: 'Europe/London' });
      expect(ctx.ok && ctx.context.colleague).toContain('Their next step stays');
      const r = await submitCallForm(call.id, { outcome: 'connected', rating: 4, notes: 'Asked for a call', nextStep: 'call_again', nextStepDate: '2099-01-06' }, karson());
      expect(r).toEqual(expect.objectContaining({ ok: true, reminder: expect.stringContaining('Your suggestion went to them') }));
      const [s] = await openSuggestions(b.users.alisa.id, { sandboxContactId: c.id });
      expect(s).toEqual(expect.objectContaining({ from: b.users.karson.name, what: 'Call again', when: '2099-01-06' }));
      const me = { id: b.users.alisa.id, role: 'SENIOR_FO' as Role, podIds: [b.pods.Alisa.id], name: b.users.alisa.name, timezone: 'Europe/London' };
      expect(await acceptSuggestion(s.id, me, userActor(b.users.alisa))).toEqual({ ok: true, message: expect.stringContaining('Next step set') });
      expect((await prisma.nextAction.findFirstOrThrow({ where: { sandboxContactId: c.id, state: 'OPEN' } }))).toEqual(expect.objectContaining({ label: 'Call again', action: 'CALL', dueDate: '2099-01-06' }));

      // A suggestion for a contact opted out since is refused, with the reason.
      const second = await logManualCall({ userId: b.users.karson.id, sandboxContactId: c.id });
      await submitCallForm(second.id, { outcome: 'connected', rating: 4, notes: 'Again', nextStep: 'email', nextStepDate: '2099-01-08' }, karson());
      const [again] = await openSuggestions(b.users.alisa.id, { sandboxContactId: c.id });
      await optOutContact(c.id, { source: 'contact_page', actor: userActor(b.users.alisa) });
      expect(await acceptSuggestion(again.id, me, userActor(b.users.alisa))).toEqual({ ok: false, error: expect.stringContaining('opted out') });
    });

    it('B184: a second tab\'s save says the form is in already, and changes nothing', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
      const [one, two] = await Promise.all([
        submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: '2099-01-05' }, alisa()),
        submitCallForm(call.id, { outcome: 'voicemail', nextStep: 'call_again', nextStepDate: '2099-01-06' }, alisa()),
      ]);
      expect([one.ok, two.ok].sort()).toEqual([false, true]);
      expect([one, two].find((r) => !r.ok)).toEqual(expect.objectContaining({ error: expect.stringContaining('already has its form') }));
      expect(await prisma.callForm.count({ where: { callId: call.id } })).toBe(1);
    });

    it('B024: a mistaken call is discarded before its form, within a day, with a reason; it leaves the queue and the counts', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      auth.requireUser.mockResolvedValue(session(b.users.alisa, [b.pods.Alisa.id]));
      const logged = await logManualCallAction(form({ sandboxContactId: c.id, startedAt: '2026-11-05T10:15', minutes: '2' }));
      expect(logged).toEqual(expect.objectContaining({ ok: true, data: { callId: expect.any(String) } }));
      const callId = (logged as { data: { callId: string } }).data.callId;
      expect((await prisma.callLog.findUniqueOrThrow({ where: { id: callId } })).talkSec).toBe(120);
      const me = { id: b.users.alisa.id, timezone: 'Europe/London' };
      expect(await discardCall(callId, '', me, userActor(b.users.alisa))).toEqual({ ok: false, error: 'Say why this call should not count.' });
      expect(await discardCall(callId, 'Logged the wrong person', { id: b.users.karson.id, timezone: 'Europe/London' }, userActor(b.users.karson))).toEqual({ ok: false, error: expect.stringContaining('Only the rep') });
      expect((await discardCall(callId, 'Logged the wrong person', me, userActor(b.users.alisa))).ok).toBe(true);
      expect(await pendingForms(b.users.alisa.id)).toHaveLength(0);
      expect(await prisma.touch.count({ where: { sandboxContactId: c.id, channel: 'CALL' } })).toBe(0);
      expect(await prisma.auditLog.findFirst({ where: { entityId: callId, action: 'call_discarded' } })).toEqual(expect.objectContaining({ details: { reason: 'Logged the wrong person' } }));
      const old = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: new Date(Date.now() - 30 * 3600_000) });
      expect(await discardCall(old.id, 'Too late', me, userActor(b.users.alisa))).toEqual({ ok: false, error: 'A call can be discarded only within 24 hours.' });
    });

    it('B161: Done never closes a cold call step: the call and its form do; Log a call waits for a pending form', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const r = await setColdNextStep(c.id, { label: 'Call back', action: 'CALL', dueDate: '2099-01-05', foUserId: b.users.alisa.id }, userActor(b.users.alisa));
      expect(await completeNextActionAction(form({ id: r.ok ? r.id : '' }))).toEqual({ ok: false, error: expect.stringContaining('closes with its call and its form') });
      await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
      expect(await logManualCallAction(form({ sandboxContactId: c.id }))).toEqual({ ok: false, error: expect.stringMatching(/^Fill in the form for your call with/) });
    });

    it('N096: a waiting call is named with its day and its zone', () => {
      const now = new Date('2026-11-05T15:00:00Z');
      expect(callTimeWords(new Date('2026-11-05T14:05:00Z'), 'America/Chicago', now)).toBe('today 08:05 CT');
      expect(callTimeWords(new Date('2026-11-05T02:20:00Z'), 'America/Chicago', now)).toBe('yesterday 20:20 CT');
      expect(callTimeWords(new Date('2026-11-02T09:12:00Z'), 'Europe/London', now)).toBe('2 Nov 09:12 GMT');
    });
  });

  describe('the import', () => {
    it('N049: forms start from the first import that went through, never a failed one', async () => {
      await prisma.setting.deleteMany({ where: { key: { startsWith: 'twilioImport.' } } });
      const broken = new FakeTwilio();
      broken.listCalls = async () => { throw new Error('Twilio said 401'); };
      expect((await importTwilioCalls({ reader: broken, now: at(0) })).error).toContain('401');
      expect(await prisma.setting.findUnique({ where: { key: 'twilioImport.formsFrom' } })).toBeNull();
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550185', phoneType: 'direct' });
      fake.addCall({ from: ALISA_LINE, to: '+13125550185', startTime: iso(30), endTime: iso(31), durationSec: 40 });
      await importTwilioCalls({ reader: fake, now: at(24 * 60) });
      expect((await prisma.callLog.findFirstOrThrow()).formDueAt).toBeNull();
      expect(c.id).toBeTruthy();
    });

    it('N050: a recording is looked for until 48 hours after the call, then marked not found', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550186', phoneType: 'direct' });
      const leg = fake.addCall({ from: ALISA_LINE, to: '+13125550186', startTime: iso(1), endTime: iso(3), durationSec: 90 });
      await importTwilioCalls({ reader: fake, now: at(4) });
      expect((await prisma.callLog.findFirstOrThrow()).recordingStatus).toBeNull();
      fake.addRecording(leg.sid, 88);
      // Three hours on, long after the call left the import's overlap, the recording is still found.
      await importTwilioCalls({ reader: fake, now: at(180) });
      expect(await prisma.callLog.findFirstOrThrow()).toEqual(expect.objectContaining({ recordingStatus: 'found', recordingSec: 88 }));
      const quiet = fake.addCall({ from: ALISA_LINE, to: '+13125550186', startTime: iso(200), endTime: iso(202), durationSec: 50 });
      await importTwilioCalls({ reader: fake, now: at(203) });
      await importTwilioCalls({ reader: fake, now: at(203 + 49 * 60) });
      expect(await prisma.callLog.findUniqueOrThrow({ where: { twilioCallSid: quiet.sid } })).toEqual(expect.objectContaining({ recordingStatus: 'not_found', recordingSid: null }));
      expect(c.id).toBeTruthy();
    });

    it('B166: a second import while one runs says so, and never shows a database error', async () => {
      await prisma.setting.create({ data: { key: LEASE_KEY, value: { token: 'other', until: new Date(Date.now() + 5 * 60_000).toISOString() } } });
      expect(await importTwilioCalls({ reader: fake })).toEqual(expect.objectContaining({ ran: false, busy: true, reason: IMPORT_RUNNING }));
      auth.requireUser.mockResolvedValue(session(b.users.ria));
      process.env.CADENCE_FAKE_TWILIO = '1';
      resetEnvCache();
      try {
        expect(await importCallsNowAction()).toEqual({ ok: false, error: IMPORT_RUNNING });
      } finally {
        delete process.env.CADENCE_FAKE_TWILIO;
        resetEnvCache();
      }
      // A lease left by a run that died lapses, and the next run goes ahead.
      await prisma.setting.update({ where: { key: LEASE_KEY }, data: { value: { token: 'other', until: new Date(Date.now() - 60_000).toISOString() } } });
      expect((await importTwilioCalls({ reader: fake })).ran).toBe(true);
      expect(await prisma.setting.findUnique({ where: { key: LEASE_KEY } })).toBeNull();
    });

    it('B165: a number counts for its rep only from when it was assigned', async () => {
      const users = [{ id: 'a', callerNumber: ALISA_LINE, callerNumberSince: at(10), aliases: [] }];
      expect(matchRep({ direction: 'OUTBOUND', fromNumber: ALISA_LINE, toNumber: '+1', repIdentity: null, startedAt: at(5) }, users)).toEqual({ userId: null, by: null });
      expect(matchRep({ direction: 'OUTBOUND', fromNumber: ALISA_LINE, toNumber: '+1', repIdentity: null, startedAt: at(15) }, users)).toEqual({ userId: 'a', by: 'caller_number' });
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550187', phoneType: 'direct' });
      await prisma.user.update({ where: { id: b.users.alisa.id }, data: { callerNumber: null } });
      await prisma.user.update({ where: { id: b.users.karson.id }, data: { callerNumber: ALISA_LINE, callerNumberSince: at(10) } });
      fake.addCall({ from: ALISA_LINE, to: '+13125550187', startTime: iso(2), endTime: iso(3), durationSec: 40 });
      await importTwilioCalls({ reader: fake, now: at(12) });
      expect(await prisma.callLog.findFirstOrThrow()).toEqual(expect.objectContaining({ userId: null, formDueAt: null, sandboxContactId: c.id }));
    });

    it('B164: giving a rep a second number says which one they lose, and dates the assignment', async () => {
      auth.requireUser.mockResolvedValue(session(b.users.ria));
      const r = await setCallerNumberAction(form({ number: '+13125550199', userId: b.users.alisa.id }));
      expect(r).toEqual({ ok: true, message: `Assigned to ${b.users.alisa.name} from now on. ${b.users.alisa.name} no longer has ${ALISA_LINE}. Earlier calls on it keep their rep.` });
      expect(await prisma.user.findUniqueOrThrow({ where: { id: b.users.alisa.id } })).toEqual(expect.objectContaining({ callerNumber: '+13125550199', callerNumberSince: expect.any(Date) }));
    });
  });

  describe('calling hours (B090, N047)', () => {
    const calling = DEFAULT_SETTINGS.calling;
    it('B090: a split state takes the area code\'s zone; a non-US number its own country; a multi-zone place the strictest window', () => {
      expect(zoneFor({ state: 'TN', phone: '+18655550100' })).toEqual(expect.objectContaining({ zone: 'America/New_York', guessed: false }));
      expect(zoneFor({ state: 'TX', phone: '+19155550100' })).toEqual(expect.objectContaining({ zone: 'America/Denver' }));
      expect(zoneFor({ phone: '+442071234567', state: 'IL' })).toEqual(expect.objectContaining({ zone: 'Europe/London', from: 'number' }));
      expect(zoneFor({ state: 'TN' })).toEqual(expect.objectContaining({ zones: ['America/Chicago', 'America/New_York'], guessed: true }));
      // 01:30 UTC: 20:30 in Nashville (Central), 21:30 in Knoxville (Eastern): a guessed Tennessee contact is outside hours.
      const now = new Date('2026-11-05T02:30:00Z');
      expect(callingHours({ state: 'TN', phone: '+16155550100' }, calling, now).allowed).toBe(true);
      expect(callingHours({ state: 'TN' }, calling, now)).toEqual(expect.objectContaining({ allowed: false, guessed: true, warning: expect.stringContaining('zone guessed') }));
    });

    it('N047: Puerto Rico, the Virgin Islands, Guam and 686 are known; 364 is Central; "N.Y." reads as New York', () => {
      expect(zoneFor({ phone: '+17875550100' }).zone).toBe('America/Puerto_Rico');
      expect(zoneFor({ phone: '+19395550100' }).zone).toBe('America/Puerto_Rico');
      expect(zoneFor({ phone: '+13405550100' }).zone).toBe('America/St_Thomas');
      expect(zoneFor({ phone: '+16715550100' }).zone).toBe('Pacific/Guam');
      expect(zoneFor({ phone: '+16865550100' }).zone).toBe('America/New_York');
      expect(zoneFor({ phone: '+13645550100' }).zone).toBe('America/Chicago');
      expect(zoneFor({ state: 'N.Y.' })).toEqual(expect.objectContaining({ zone: 'America/New_York', from: 'state' }));
      expect(zoneFor({})).toEqual(expect.objectContaining({ from: 'workspace', guessed: true }));
    });
  });

  it('N046: forms waiting are counted now, whatever the report period, by whoever holds them, with the oldest', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const old = await logManualCall({ userId: b.users.karson.id, sandboxContactId: c.id }, new Date('2026-10-01T10:00:00Z'));
    await logManualCall({ userId: b.users.karson.id, sandboxContactId: c.id }, new Date('2026-11-04T10:00:00Z'));
    const handed = await logManualCall({ userId: b.users.karson.id, sandboxContactId: c.id }, new Date('2026-11-04T11:00:00Z'));
    await prisma.callLog.update({ where: { id: handed.id }, data: { formUserId: b.users.alisa.id } });
    const waiting = await formsWaiting({ podId: b.pods.Alisa.id });
    expect(waiting.get(b.users.karson.id)).toEqual({ count: 2, oldest: old.formDueAt });
    expect(waiting.get(b.users.alisa.id)?.count).toBe(1);
  });

  it('N055: one outcome list: the form\'s own outcomes are answered calls in Reports and read in words everywhere', () => {
    const answered = callOutcomes(rules).filter((o) => o.answered).map((o) => o.key);
    expect(answered).toEqual(expect.arrayContaining(['connected', 'not_interested', 'meeting_booked', 'do_not_contact']));
    expect(dispositionFor(rules, 'not_interested')?.label).toBe('Not interested');
  });

  it('N055: CRM Log call offers only Settings > Rules outcomes; finished tasks still label form outcomes', () => {
    // The owner's decision: CRM "Log call" stays as it is. Its picker is Settings > Rules', no more.
    expect(logCallOutcomes(rules).map((o) => o.key)).toEqual(rules.callDispositions.map((d) => d.key));
    expect(logCallOutcomes(rules).map((o) => o.key)).not.toEqual(expect.arrayContaining(['do_not_contact']));
    expect(logCallOutcomes(rules).some((o) => ['not_interested', 'meeting_booked', 'do_not_contact', 'no_conversation'].includes(o.key))).toBe(false);
    // A task the post-call form finished still reads in words, never as its key.
    expect(outcomeLabel(rules, 'not_interested')).toBe('Not interested');
    expect(outcomeLabel(rules, 'do_not_contact')).toBe('Asked not to be contacted');
    expect(outcomeLabel(rules, 'connected')).toBe('Connected');
    expect(outcomeLabel(rules, 'made_up')).toBe('made_up');
  });

  it('N051: a call\'s notes, numbers and recording are for the rep, the owner and those who see Reports', () => {
    const call = { userId: b.users.alisa.id, formUserId: null, ownerId: b.users.leigh.id };
    expect(mayHearCall({ id: b.users.alisa.id, role: 'SENIOR_FO', podIds: [] }, call)).toBe(true);
    expect(mayHearCall({ id: b.users.leigh.id, role: 'SENIOR_FO', podIds: [] }, call)).toBe(true);
    expect(mayHearCall({ id: b.users.karson.id, role: 'JUNIOR_FO', podIds: [] }, call)).toBe(false);
    expect(mayHearCall({ id: 'x', role: 'BIZ_OPS', podIds: [] }, call)).toBe(true);
  });

  it('B127: a call can be given only to a sales rep', async () => {
    const bea = await bizOps();
    auth.requireUser.mockResolvedValue(session(b.users.ria));
    const call = await prisma.callLog.create({ data: { source: 'TWILIO_IMPORT', direction: 'OUTBOUND', status: 'COMPLETED', statusRank: 4, toNumber: '+16175550000', matchedBy: 'none', startedAt: new Date() } });
    expect(await assignCallRepAction(form({ callId: call.id, userId: bea.id }))).toEqual({ ok: false, error: 'Choose an active sales rep: only reps make calls.' });
    expect(await assignCallRepAction(form({ callId: call.id, userId: b.users.karson.id }))).toEqual(expect.objectContaining({ ok: true }));
  });

  it('B120: Biz Ops are refused the Call at the click, with the reason', async () => {
    const bea = await bizOps();
    const { recordCallIntentAction } = await import('@/lib/actions/call-forms');
    auth.requireUser.mockResolvedValue({ ...session(b.users.alisa), id: bea.id, role: 'BIZ_OPS', name: bea.name, podIds: [] });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    expect(await recordCallIntentAction({ phone: c.phone!, sandboxContactId: c.id })).toEqual({ ok: false, error: expect.stringContaining('Biz Ops') });
  });

  it('N008: the Call button checks again at the click: a form that came due since the page was drawn blocks it', async () => {
    const { recordCallIntentAction } = await import('@/lib/actions/call-forms');
    // Calling hours are another test's; this one is about the form.
    await saveSettingsSection('calling', { ...DEFAULT_SETTINGS.calling, callingHours: 'off' });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    expect(await recordCallIntentAction({ phone: c.phone!, sandboxContactId: c.id, confirmed: true })).toEqual(expect.objectContaining({ ok: true }));
    await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
    expect(await recordCallIntentAction({ phone: c.phone!, sandboxContactId: c.id, confirmed: true })).toEqual({ ok: false, error: expect.stringMatching(/^Fill in the form for your call with/) });
  });
});
