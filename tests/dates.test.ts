import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, diffDays, isLocalDate, localDateToInstant, toLocalDate, todayIn } from '@/lib/dates';

describe('dates', () => {
  it('adds and diffs calendar days across month ends', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-09-01', '2026-09-06')).toBe(5);
    expect(diffDays('2026-09-06', '2026-09-01')).toBe(-5);
  });

  it('knows weekdays', () => {
    expect(dayOfWeek('2026-09-06')).toBe(0); // Sunday
    expect(dayOfWeek('2026-09-07')).toBe(1); // Monday
  });

  it('validates local dates', () => {
    expect(isLocalDate('2026-09-06')).toBe(true);
    expect(isLocalDate('2026-13-01')).toBe(false);
    expect(isLocalDate('2026-02-30')).toBe(false);
    expect(isLocalDate('yesterday')).toBe(false);
  });

  it('respects the timezone when deriving today', () => {
    const lateEveningUtc = new Date('2026-09-06T23:30:00Z');
    expect(todayIn('UTC', lateEveningUtc)).toBe('2026-09-06');
    expect(todayIn('Europe/London', lateEveningUtc)).toBe('2026-09-07'); // BST = UTC+1
    expect(todayIn('America/Los_Angeles', lateEveningUtc)).toBe('2026-09-06');
    expect(todayIn('Not/AZone', lateEveningUtc)).toBe('2026-09-06'); // falls back to UTC
  });

  it('converts a local date to a 09:00 local instant and back', () => {
    const instant = localDateToInstant('2026-09-07', 'Europe/London', 9);
    expect(instant.toISOString()).toBe('2026-09-07T08:00:00.000Z');
    expect(toLocalDate(instant, 'Europe/London')).toBe('2026-09-07');
  });
});
