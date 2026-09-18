import { describe, expect, it } from 'vitest';
import { endDateThatFits, lastStartDate, planCapacity, type CapacityInput } from '@/lib/engine/capacity';
import type { SequenceStep } from '@/lib/sequences/steps';

const MON_FRI = [1, 2, 3, 4, 5];
const action = (id: string, type: 'EMAIL' | 'CALL' | 'LINKEDIN_MESSAGE' = 'EMAIL') => ({ id, type, label: id, template: '' });
/** Four touches over fourteen days: the owner's worked example. */
const FOUR_TOUCHES: SequenceStep[] = [
  { id: 's1', day: 1, actions: [action('a1')] },
  { id: 's2', day: 4, actions: [action('a2', 'CALL')] },
  { id: 's3', day: 8, actions: [action('a3', 'LINKEDIN_MESSAGE')] },
  { id: 's4', day: 14, actions: [action('a4')] },
];
const fo = (id: string, cap = 40, committed: Array<[string, number]> = []) => ({ id, name: id, cap, committed: new Map(committed) });
const base: CapacityInput = { steps: FOUR_TOUCHES, durationDays: 14, startDate: '2026-09-21', endDate: '2026-10-30', fos: [fo('a'), fo('b'), fo('c')], workingDays: MON_FRI };

describe('the campaign planner', () => {
  it('finds the last start from which the whole plan still finishes by the end date', () => {
    // Fourteen days from Fri 16 Oct is Thu 29 Oct; from Mon 19 Oct it is Sun 1 Nov -> Mon 2 Nov, past the end.
    expect(lastStartDate(base)).toBe('2026-10-16');
    // Day 14 from Tue 22 Sep is Mon 5 Oct exactly; from Wed 23 Sep it is Tue 6 Oct, past the end.
    expect(lastStartDate({ ...base, endDate: '2026-10-05' })).toBe('2026-09-22');
    expect(lastStartDate({ ...base, endDate: '2026-09-30' })).toBeNull(); // shorter than the plan
  });

  it('the worked example: the weekend stack decides the rate, not cap divided by touches', () => {
    const plan = planCapacity(base);
    expect(plan.touchesPerPerson).toBe(4);
    expect(plan.lastStart).toBe('2026-10-16');
    expect(plan.startingDays).toHaveLength(20);
    // Cap 40 over 4 touches reads as 10 a day - but from Monday starts day 14 is a Sunday, from
    // Wednesday to Friday day 4 is the weekend, and all of it rolls onto Monday: seven starts' worth
    // of touches land there (1 first step, 3 day-4s, 1 day-8, 2 day-14s). 7 x 5 = 35 fits; 7 x 6 does not.
    for (const f of plan.perFo) {
      expect(f.rate).toBe(5);
      expect(f.capacity).toBe(100);
      expect(f.worstLoad).toBeLessThanOrEqual(40);
      expect(f.worstLoad).toBe(35);
    }
    expect(plan.total).toBe(300);
    expect(plan.tooShort).toBe(false);
  });

  it('weekend rolls stack Monday, and moving steps off the weekend frees room', () => {
    const stacked: SequenceStep[] = [{ id: 's1', day: 1, actions: [action('a1')] }, { id: 's2', day: 6, actions: [action('a2')] }, { id: 's3', day: 7, actions: [action('a3')] }];
    const flat = stacked.map((s, i) => ({ ...s, day: [1, 2, 3][i] }));
    const heavy = planCapacity({ ...base, steps: stacked, durationDays: 7, fos: [fo('a', 30)], endDate: '2026-10-16' });
    const light = planCapacity({ ...base, steps: flat, durationDays: 7, fos: [fo('a', 30)], endDate: '2026-10-16' });
    expect(heavy.perFo[0].worstLoad).toBeLessThanOrEqual(30);
    expect(light.perFo[0].worstLoad).toBeLessThanOrEqual(30);
    expect(heavy.perFo[0].rate).toBeLessThan(10); // the naive cap / touches
    expect(light.perFo[0].rate).toBeGreaterThan(heavy.perFo[0].rate);
  });

  it('work an FO already holds lowers what a new campaign may start', () => {
    const free = planCapacity({ ...base, fos: [fo('a')] });
    const busy = planCapacity({ ...base, fos: [fo('a', 40, [['2026-09-21', 30], ['2026-09-28', 30], ['2026-10-05', 30], ['2026-10-12', 30]])] });
    expect(busy.perFo[0].rate).toBeLessThan(free.perFo[0].rate);
    expect(busy.perFo[0].worstLoad).toBeLessThanOrEqual(40);
  });

  it('a hand-chosen ceiling on the rate is honoured', () => {
    const plan = planCapacity({ ...base, maxRate: 3 });
    expect(plan.perFo.every((f) => f.rate === 3)).toBe(true);
    expect(plan.total).toBe(3 * 20 * 3);
  });

  it('a window shorter than the plan takes nobody, and the remedy is the first end date that fits', () => {
    const short = { ...base, endDate: '2026-09-25' };
    expect(planCapacity(short).tooShort).toBe(true);
    expect(planCapacity(short).total).toBe(0);
    for (const audience of [100, 300, 900]) {
      const end = endDateThatFits(short, audience)!;
      expect(end).not.toBeNull();
      expect(end > short.endDate).toBe(true);
      expect(planCapacity({ ...short, endDate: end }).total).toBeGreaterThanOrEqual(audience);
      expect(planCapacity({ ...short, endDate: addDay(end, -1) }).total).toBeLessThan(audience);
    }
  });
});

function addDay(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
