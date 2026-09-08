import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, diffDays, endOfWeekSaturday, isLocalDate, localDateToInstant, startOfWeekSunday, toLocalDate, todayIn, weekRange } from '@/lib/dates';

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

  it('runs weeks from Sunday to Saturday', () => {
    // 2026-09-06 is a Sunday, 2026-09-12 the Saturday after it.
    expect(dayOfWeek('2026-09-06')).toBe(0);
    expect(startOfWeekSunday('2026-09-06')).toBe('2026-09-06');
    expect(startOfWeekSunday('2026-09-08')).toBe('2026-09-06');
    expect(startOfWeekSunday('2026-09-12')).toBe('2026-09-06');
    expect(startOfWeekSunday('2026-09-13')).toBe('2026-09-13');
    expect(endOfWeekSaturday('2026-09-08')).toBe('2026-09-12');
  });

  it('gives this week as a half-open instant range in the user timezone', () => {
    const w = weekRange('2026-09-08', 'Europe/London');
    expect([w.from, w.to]).toEqual(['2026-09-06', '2026-09-12']);
    // Midnight London on the Sunday, to midnight London on the following Sunday (BST = UTC+1).
    expect(w.fromInstant.toISOString()).toBe('2026-09-05T23:00:00.000Z');
    expect(w.toInstant.toISOString()).toBe('2026-09-12T23:00:00.000Z');
    // A Saturday 23:59 local instant is inside the week; the next minute is not.
    expect(new Date('2026-09-12T22:59:00Z') < w.toInstant).toBe(true);
    expect(new Date('2026-09-12T23:00:00Z') < w.toInstant).toBe(false);
  });

  it('shifts the week boundary with the timezone', () => {
    expect(weekRange('2026-09-08', 'America/Los_Angeles').fromInstant.toISOString()).toBe('2026-09-06T07:00:00.000Z');
    expect(weekRange('2026-09-08', 'UTC').fromInstant.toISOString()).toBe('2026-09-06T00:00:00.000Z');
  });

  it('converts a local date to a 09:00 local instant and back', () => {
    const instant = localDateToInstant('2026-09-07', 'Europe/London', 9);
    expect(instant.toISOString()).toBe('2026-09-07T08:00:00.000Z');
    expect(toLocalDate(instant, 'Europe/London')).toBe('2026-09-07');
  });
});
