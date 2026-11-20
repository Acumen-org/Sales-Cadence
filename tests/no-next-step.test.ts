import { beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { logManualCall, submitCallForm, validateCallForm } from '@/lib/calls/form';
import { coldCues } from '@/lib/sandbox/cues';
import { setColdNextStep } from '@/lib/sandbox/work';
import { userActor } from '@/lib/audit';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { nextStepWords } from '@/lib/sandbox/history-notes';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * Owner, 20 November 2026: Alyssa called Sue Herzog, a one-off call with nothing to follow, and the
 * form would not let her save it without a dated next step ("They answered, so the campaign ends").
 * Now any call can end with No further action, and choosing it asks why.
 */
const rules = DEFAULT_SETTINGS.rules;
const today = '2026-11-03';
let b: Basics;
const alisa = () => ({ id: b.users.alisa.id, name: b.users.alisa.name, timezone: 'Europe/London', role: 'SENIOR_FO' as Role, podIds: [b.pods.Alisa.id] });

describe('No next step, with its reason', () => {
  describe('rules', () => {
    const reached = { outcome: 'connected', rating: 5, notes: 'Spoke to Sue about comp tickets', nextStep: 'none' };

    it('a reached call can end with No further action, but only with a reason', () => {
      expect(validateCallForm(reached, { rules, today })).toEqual(expect.objectContaining({ ok: false, field: 'noNextStepReason', error: 'Say why there is no next step.' }));
      expect(validateCallForm({ ...reached, noNextStepReason: '   ' }, { rules, today })).toEqual(expect.objectContaining({ ok: false, field: 'noNextStepReason' }));
      expect(validateCallForm({ ...reached, noNextStepReason: '  One-off:   she only needed tickets ' }, { rules, today })).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ nextStep: 'none', noNextStepReason: 'One-off: she only needed tickets' }) }));
      expect(validateCallForm({ ...reached, noNextStepReason: 'x'.repeat(501) }, { rules, today })).toEqual(expect.objectContaining({ ok: false, field: 'noNextStepReason' }));
    });

    it('a call that did not reach them needs the reason too', () => {
      expect(validateCallForm({ outcome: 'voicemail', nextStep: 'none' }, { rules, today })).toEqual(expect.objectContaining({ ok: false, field: 'noNextStepReason' }));
      expect(validateCallForm({ outcome: 'voicemail', nextStep: 'none', noNextStepReason: 'Third voicemail, retiring' }, { rules, today }).ok).toBe(true);
    });

    it('needs no reason where the form leaves no other choice, and keeps none', () => {
      for (const outcome of ['not_interested', 'do_not_contact', 'wrong_number']) {
        const r = validateCallForm({ outcome, rating: 2, notes: 'x', nextStep: 'none', noNextStepReason: 'ignored' }, { rules, today });
        expect(r).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ noNextStepReason: null }) }));
      }
      expect(validateCallForm(reached, { rules, today, subjectGone: true }).ok).toBe(true);
      expect(validateCallForm(reached, { rules, today, noSubject: true }).ok).toBe(true);
    });

    it('a booked meeting still needs its day, and a dated step needs no reason', () => {
      expect(validateCallForm({ outcome: 'meeting_booked', rating: 5, notes: 'Booked', nextStep: 'none', noNextStepReason: 'x' }, { rules, today })).toEqual(expect.objectContaining({ ok: false, field: 'nextStep' }));
      expect(validateCallForm({ ...reached, nextStep: 'email', nextStepDate: '2026-11-05' }, { rules, today })).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ noNextStepReason: null }) }));
    });

    it('reads as "No next step: why" wherever the form is shown', () => {
      expect(nextStepWords({ nextStep: 'none', nextStepLabel: null, nextStepDate: null, noNextStepReason: 'One-off call' })).toBe('No next step: One-off call');
      expect(nextStepWords({ nextStep: 'none', nextStepLabel: null, nextStepDate: null })).toBe('No further action');
    });
  });

  describe('saving it', () => {
    beforeEach(async () => {
      await resetDb();
      b = await seedBasics();
    });

    it('a CRM person: the call is saved with the reason, the open next step is cancelled, and the CRM note says why', async () => {
      const personId = 'person-03';
      await prisma.nextAction.create({ data: { personId, foUserId: b.users.alisa.id, label: 'No Follow Up', action: 'CALL', dueDate: '2099-01-05' } });
      const call = await logManualCall({ userId: b.users.alisa.id, personId });
      const before = getMockTwentyClient().writes.filter((w) => w.op === 'createNote').length;
      const r = await submitCallForm(call.id, { outcome: 'connected', rating: 5, notes: 'Comp tickets for Alisa', nextStep: 'none', noNextStepReason: 'One-off call about event tickets' }, alisa());
      expect(r).toEqual(expect.objectContaining({ ok: true, message: 'Saved. No next step is set.' }));
      expect(await prisma.callForm.findUniqueOrThrow({ where: { callId: call.id } })).toEqual(expect.objectContaining({ nextStep: 'none', noNextStepReason: 'One-off call about event tickets', nextStepDate: null }));
      expect(await prisma.nextAction.count({ where: { personId, state: 'OPEN' } })).toBe(0);
      const notes = getMockTwentyClient().writes.filter((w) => w.op === 'createNote');
      expect(notes.length - before).toBe(1);
      expect(JSON.stringify(notes[notes.length - 1])).toContain('Next step: No next step: One-off call about event tickets');
    });

    it('a cold contact is Closed with "No next step", not left under Needs a next step; a new next step reopens it', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
      expect(await submitCallForm(call.id, { outcome: 'connected', rating: 4, notes: 'Wanted a brochure only', nextStep: 'none', noNextStepReason: 'Not a prospect: wanted a brochure' }, alisa())).toEqual(expect.objectContaining({ ok: true }));
      const cue = (await coldCues([c.id])).get(c.id)!;
      expect(cue.state).toBe('closed');
      expect(cue.badge.label).toMatch(/^Closed · No next step/);
      await new Promise((r) => setTimeout(r, 5));
      expect(await setColdNextStep(c.id, { label: 'Call again', action: 'CALL', dueDate: '2099-01-05', foUserId: b.users.alisa.id }, userActor(b.users.alisa))).toEqual(expect.objectContaining({ ok: true }));
      expect((await coldCues([c.id])).get(c.id)!.state).not.toBe('closed');
    });
  });
});
