import { describe, expect, it } from 'vitest';
import { comparisonRange } from '@/lib/reports-query';

describe('the period a report is read against', () => {
  it('sets a month to date against the same days of the month before', () => {
    expect(comparisonRange('2026-09-01', '2026-09-24')).toEqual({ from: '2026-08-01', to: '2026-08-24' });
    expect(comparisonRange('2026-08-01', '2026-08-31')).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    // A whole month against the whole month before, however long either is.
    expect(comparisonRange('2027-03-01', '2027-03-31')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(comparisonRange('2026-09-01', '2026-09-30')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(comparisonRange('2027-02-01', '2027-02-28')).toEqual({ from: '2027-01-01', to: '2027-01-31' });
    expect(comparisonRange('2028-02-01', '2028-02-29')).toEqual({ from: '2028-01-01', to: '2028-01-31' });
    expect(comparisonRange('2026-01-01', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-15' });
  });
  it('sets a week to date against the same days a week before, never a weekend', () => {
    // Sunday 20 to Monday 21 September against Sunday 13 to Monday 14.
    expect(comparisonRange('2026-09-20', '2026-09-21')).toEqual({ from: '2026-09-13', to: '2026-09-14' });
    // A week that starts on the 1st is still a week: Sun 1 to Tue 3 November against Sun 25 to Tue 27 October.
    expect(comparisonRange('2026-11-01', '2026-11-03')).toEqual({ from: '2026-10-25', to: '2026-10-27' });
  });
  it('sets any other range against the same number of days just before it', () => {
    expect(comparisonRange('2026-08-28', '2026-09-24')).toEqual({ from: '2026-07-31', to: '2026-08-27' });
  });
});
