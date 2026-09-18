import { describe, expect, it } from 'vitest';
import { DEFAULT_SEQUENCE_STEPS } from '@/lib/sequences/default-sequence';
import { StepsSchema, describeStep, parseSteps, safeParseSteps } from '@/lib/sequences/steps';

describe('default sequence', () => {
  it('matches the specified plan exactly', () => {
    const steps = parseSteps(DEFAULT_SEQUENCE_STEPS);
    const plan = steps.map((s) => [s.day, s.actions.map((a) => a.type)]);
    // Calendar days from a Monday start (weekends count, work rolls to Monday), and the call steps
    // carry their follow-up as a second module of the same step.
    expect(plan).toEqual([
      [1, ['EMAIL', 'LINKEDIN_CONNECT']],
      [3, ['CALL', 'EMAIL']],
      [8, ['EMAIL']],
      [11, ['LINKEDIN_MESSAGE']],
      [16, ['CALL', 'LINKEDIN_MESSAGE']],
      [22, ['LINKEDIN_MESSAGE']],
      [26, ['CALL', 'EMAIL']],
      [31, ['EMAIL']],
    ]);
  });

  it('labels the numbered actions', () => {
    const steps = parseSteps(DEFAULT_SEQUENCE_STEPS);
    expect(steps[0].actions[0].label).toBe('Email 1');
    expect(steps[2].actions[0].label).toBe('Email 2');
    expect(steps[7].actions[0].label).toBe('Email 3');
    expect(steps[1].actions[0].label).toBe('Call 1');
    expect(describeStep(steps[1])).toBe('Call 1, then Follow-up email');
  });

  it('every action has a template', () => {
    for (const step of DEFAULT_SEQUENCE_STEPS) {
      for (const a of step.actions) {
        expect(a.template, `${a.label} template`).toBeTruthy();
        // Literal copy only: a variable placeholder would reach a prospect unsubstituted.
        expect(a.template, `${a.label} has no variable syntax`).not.toMatch(/\{\{|\}\}/);
        if (a.subject) expect(a.subject, `${a.label} subject`).not.toMatch(/\{\{|\}\}/);
      }
    }
  });
});

describe('StepsSchema validation', () => {
  it('rejects non-increasing days', () => {
    const r = safeParseSteps([
      { id: 'a', day: 3, actions: [{ id: 'x', type: 'EMAIL', label: 'E' }] },
      { id: 'b', day: 3, actions: [{ id: 'y', type: 'CALL', label: 'C' }] },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must be later/);
  });

  it('rejects duplicate step ids and duplicate module ids within a step', () => {
    expect(
      StepsSchema.safeParse([
        { id: 'a', day: 1, actions: [{ id: 'x', type: 'EMAIL', label: 'E' }] },
        { id: 'a', day: 2, actions: [{ id: 'y', type: 'CALL', label: 'C' }] },
      ]).success,
    ).toBe(false);
    expect(
      StepsSchema.safeParse([{ id: 'a', day: 1, actions: [{ id: 'x', type: 'EMAIL', label: 'E' }, { id: 'x', type: 'CALL', label: 'C' }] }]).success,
    ).toBe(false);
    // Two modules of different types on one step is the normal case: a call and its follow-up.
    expect(
      StepsSchema.safeParse([{ id: 'a', day: 1, actions: [{ id: 'x', type: 'CALL', label: 'C' }, { id: 'y', type: 'EMAIL', label: 'E' }] }]).success,
    ).toBe(true);
  });

  it('requires at least one step and one action', () => {
    expect(StepsSchema.safeParse([]).success).toBe(false);
    expect(StepsSchema.safeParse([{ id: 'a', day: 1, actions: [] }]).success).toBe(false);
  });
});
