import { describe, expect, it } from 'vitest';
import { followingWorkingDay, lateDelayDays, nextWorkingDay, plannedDateForStep, shiftAfterStep, shouldGenerateNow } from '@/lib/engine/clock';

const MON_FRI = [1, 2, 3, 4, 5];

describe('clock', () => {
  it('rolls weekends forward to Monday', () => {
    expect(nextWorkingDay('2026-09-12', MON_FRI)).toBe('2026-09-14'); // Sat -> Mon
    expect(nextWorkingDay('2026-09-13', MON_FRI)).toBe('2026-09-14'); // Sun -> Mon
    expect(nextWorkingDay('2026-09-14', MON_FRI)).toBe('2026-09-14');
    expect(followingWorkingDay('2026-09-11', MON_FRI)).toBe('2026-09-14'); // Fri -> Mon
    expect(followingWorkingDay('2026-09-09', MON_FRI)).toBe('2026-09-10');
  });

  it('honours custom working days', () => {
    expect(nextWorkingDay('2026-09-12', [0, 1, 2, 3, 4, 5, 6])).toBe('2026-09-12');
    expect(nextWorkingDay('2026-09-12', [1, 3, 5])).toBe('2026-09-14');
  });

  it('plans steps from the start date: day 1 is the start itself', () => {
    expect(plannedDateForStep('2026-09-07', 1, 0, MON_FRI)).toBe('2026-09-07');
    expect(plannedDateForStep('2026-09-07', 3, 0, MON_FRI)).toBe('2026-09-09');
    expect(plannedDateForStep('2026-09-07', 6, 0, MON_FRI)).toBe('2026-09-14'); // Sat 12th -> Mon 14th
    expect(plannedDateForStep('2026-09-07', 6, 5, MON_FRI)).toBe('2026-09-17'); // shifted by 5
  });

  it('shift mode accumulates late days, hold mode ignores them', () => {
    expect(lateDelayDays('2026-09-09', '2026-09-14')).toBe(5);
    expect(lateDelayDays('2026-09-09', '2026-09-08')).toBe(0);
    expect(shiftAfterStep(2, '2026-09-09', '2026-09-14', 'shift')).toBe(7);
    expect(shiftAfterStep(2, '2026-09-09', '2026-09-14', 'hold')).toBe(2);
  });

  it('decides when to generate the next step', () => {
    const base = { plannedDate: '2026-09-09', today: '2026-09-07', isFirstStep: false };
    expect(shouldGenerateNow({ ...base, previousStepDone: true, mode: 'shift' })).toBe(true);
    expect(shouldGenerateNow({ ...base, previousStepDone: false, mode: 'shift' })).toBe(false);
    expect(shouldGenerateNow({ ...base, previousStepDone: false, mode: 'hold' })).toBe(false);
    expect(shouldGenerateNow({ ...base, previousStepDone: false, mode: 'hold', today: '2026-09-09' })).toBe(true);
    expect(shouldGenerateNow({ ...base, previousStepDone: false, mode: 'shift', isFirstStep: true })).toBe(true);
  });
});
