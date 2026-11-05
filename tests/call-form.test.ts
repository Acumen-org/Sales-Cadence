import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { defaultNextStepDate, logManualCall, pendingForms, submitCallForm, validateCallForm } from '@/lib/calls/form';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { DEFAULT_SEQUENCE_STEPS } from '@/lib/sequences/default-sequence';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

const rules = DEFAULT_SETTINGS.rules;

describe('the post-call form (plan section 10)', () => {
  describe('rules', () => {
    const today = '2026-11-03';
    const base = { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: '2026-11-05' };
    it('needs an outcome, and a rating and notes when the person answered', () => {
      expect(validateCallForm({ ...base, outcome: '' }, { rules, today })).toEqual(expect.objectContaining({ ok: false, field: 'outcome' }));
      expect(validateCallForm({ ...base, outcome: 'connected' }, { rules, today })).toEqual(expect.objectContaining({ ok: false, field: 'rating' }));
      expect(validateCallForm({ ...base, outcome: 'connected', rating: 4 }, { rules, today })).toEqual(expect.objectContaining({ ok: false, field: 'notes' }));
      expect(validateCallForm({ ...base, outcome: 'connected', rating: 4, notes: 'Wants a demo' }, { rules, today }).ok).toBe(true);
      expect(validateCallForm(base, { rules, today }).ok).toBe(true);
    });

    it('takes the next step and its date as one field: the date is required for every step except No further action', () => {
      for (const step of ['call_again', 'email', 'linkedin', 'meeting']) {
        expect(validateCallForm({ ...base, nextStep: step, nextStepDate: null }, { rules, today })).toEqual(expect.objectContaining({ ok: false, field: 'nextStepDate' }));
        expect(validateCallForm({ ...base, nextStep: step }, { rules, today })).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ nextStep: step, nextStepDate: '2026-11-05' }) }));
      }
      expect(validateCallForm({ ...base, nextStep: 'none', nextStepDate: '2026-11-05' }, { rules, today })).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ nextStep: 'none', nextStepDate: null }) }));
      expect(validateCallForm({ ...base, nextStep: 'later' }, { rules, today })).toEqual(expect.objectContaining({ ok: false, field: 'nextStep' }));
      expect(validateCallForm({ ...base, nextStepDate: '2026-11-02' }, { rules, today })).toEqual(expect.objectContaining({ ok: false, error: 'The next step cannot be in the past.' }));
    });

    it('defaults the date to two working days on', () => {
      expect(defaultNextStepDate('2026-11-02', rules.workingDays)).toBe('2026-11-04'); // Monday -> Wednesday
      expect(defaultNextStepDate('2026-11-06', rules.workingDays)).toBe('2026-11-10'); // Friday -> Tuesday
      expect(defaultNextStepDate('2026-11-07', rules.workingDays)).toBe('2026-11-10'); // Saturday -> Tuesday
    });

    it('offers the extra outcomes beside Settings > Rules', () => {
      for (const outcome of ['not_interested', 'do_not_contact']) expect(validateCallForm({ ...base, outcome, rating: 3, notes: 'x', nextStep: 'none' }, { rules, today }).ok).toBe(true);
      // B028: a booked meeting is a Meeting on its day.
      expect(validateCallForm({ ...base, outcome: 'meeting_booked', rating: 3, notes: 'x', nextStep: 'meeting' }, { rules, today }).ok).toBe(true);
    });
  });

  describe('what submitting does', () => {
    let b: Basics;
    beforeEach(async () => {
      await resetDb();
      b = await seedBasics();
    });
    const alisa = () => ({ id: b.users.alisa.id, name: b.users.alisa.name, timezone: 'Europe/London' });

    it('gives a sandbox contact its next action on the chosen day and completes the call', async () => {
      const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: contact.id });
      expect((await pendingForms(b.users.alisa.id)).map((c) => c.id)).toEqual([call.id]);
      const date = defaultNextStepDate(new Date().toISOString().slice(0, 10), rules.workingDays);
      const r = await submitCallForm(call.id, { outcome: 'connected', rating: 4, notes: 'Interested in PHH', nextStep: 'email', nextStepDate: date, interest: 'warm', productsDiscussed: ['PHH'] }, alisa());
      expect(r.ok).toBe(true);
      expect(await pendingForms(b.users.alisa.id)).toHaveLength(0);
      const next = await prisma.nextAction.findFirstOrThrow({ where: { sandboxContactId: contact.id, state: 'OPEN' } });
      expect(next).toEqual(expect.objectContaining({ label: 'Email', action: 'EMAIL', dueDate: date, personId: null, crmPending: false, foUserId: b.users.alisa.id }));
      expect(await prisma.callForm.findUniqueOrThrow({ where: { callId: call.id } })).toEqual(expect.objectContaining({ nextStep: 'email', nextStepDate: date, nextActionId: next.id }));
      // Nothing about a sandbox contact goes to Twenty until it moves.
      expect(getMockTwentyClient().writes.filter((w) => w.op === 'createNote' || w.op === 'setPersonNextAction')).toHaveLength(0);
    });

    it('lets only the rep who made the call fill in its form', async () => {
      const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: contact.id });
      const r = await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'none' }, { id: b.users.karson.id, name: 'Karson', timezone: 'Europe/London' });
      expect(r).toEqual({ ok: false, error: 'Only the rep who made this call can fill in its form.' });
    });

    it('closes a CRM person\'s call step and writes one note to Twenty, in place of the completion note', async () => {
      const personId = 'person-02';
      const today = new Date().toISOString().slice(0, 10);
      const enrollment = await prisma.enrollment.create({ data: { personId, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: today, status: 'ACTIVE', currentStep: 0, currentStepId: DEFAULT_SEQUENCE_STEPS[0].id } });
      const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId: b.users.alisa.id, stepIndex: 0, stepId: DEFAULT_SEQUENCE_STEPS[0].id, stepDay: DEFAULT_SEQUENCE_STEPS[0].day, actionIndex: 0, actionId: DEFAULT_SEQUENCE_STEPS[0].actions[0].id, action: 'CALL', label: 'Call 1', dueDate: today, dueAt: new Date(), plannedDate: today } });
      const call = await logManualCall({ userId: b.users.alisa.id, personId, taskId: task.id });
      const before = getMockTwentyClient().writes.filter((w) => w.op === 'createNote').length;
      const r = await submitCallForm(call.id, { outcome: 'voicemail', nextStep: 'call_again', nextStepDate: defaultNextStepDate(new Date().toISOString().slice(0, 10), rules.workingDays) }, alisa());
      expect(r.ok).toBe(true);
      const after = getMockTwentyClient().writes.filter((w) => w.op === 'createNote');
      expect(after.length - before).toBe(1);
      expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(expect.objectContaining({ state: 'DONE', disposition: 'voicemail' }));
      const next = await prisma.nextAction.findFirstOrThrow({ where: { personId, state: 'OPEN' } });
      expect(next.label).toBe('Call again');
    });
  });
});
