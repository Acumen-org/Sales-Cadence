import { describe, expect, it } from 'vitest';
import { findDateWithCapacity, loadFromRows, reserve, type DayLoad } from '@/lib/engine/caps';

const MON_FRI = [1, 2, 3, 4, 5];

describe('daily caps', () => {
  it('uses the planned day while there is room', () => {
    const load: DayLoad = new Map([['2026-09-07', 38]]);
    expect(findDateWithCapacity('2026-09-07', 2, 40, load, MON_FRI)).toBe('2026-09-07');
  });

  it('rolls a full day forward to the next working day, never splitting a step', () => {
    const load: DayLoad = new Map([
      ['2026-09-07', 39],
      ['2026-09-08', 40],
    ]);
    expect(findDateWithCapacity('2026-09-07', 2, 40, load, MON_FRI)).toBe('2026-09-09');
  });

  it('skips weekends when rolling', () => {
    const load: DayLoad = new Map([['2026-09-11', 40]]); // Friday full
    expect(findDateWithCapacity('2026-09-11', 1, 40, load, MON_FRI)).toBe('2026-09-14');
  });

  it('a step bigger than the cap lands on the first empty day', () => {
    const load: DayLoad = new Map([['2026-09-07', 1]]);
    expect(findDateWithCapacity('2026-09-07', 5, 3, load, MON_FRI)).toBe('2026-09-08');
  });

  it('counts snoozed tasks on their snoozed day', () => {
    const load = loadFromRows([
      { dueDate: '2026-09-07', snoozedTo: null },
      { dueDate: '2026-09-07', snoozedTo: '2026-09-08' },
    ]);
    expect(load.get('2026-09-07')).toBe(1);
    expect(load.get('2026-09-08')).toBe(1);
    reserve(load, '2026-09-08', 2);
    expect(load.get('2026-09-08')).toBe(3);
  });
});
