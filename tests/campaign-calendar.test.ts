import { describe, it, expect } from 'vitest';
import { addDays } from '@/lib/dates';
import { buildCampaignCalendar, outreachDates, contactPriority, CampaignDraftSchema, suggestCampaignCalendar, type CampaignDraft, type PlannerPerson, type CampaignCalendar, workingDay, calendarMonths, monthGrid, weekday, dateRangeLabel, numberInWords } from '@/lib/campaign-planner';
import type { SequenceStep } from '@/lib/sequences/steps';
import { CAMPAIGN_DEFAULT_STEPS } from '@/lib/sequences/campaign-default';

const steps = (days: number[]): SequenceStep[] => days.map((day, i) => ({ id: `s${i}`, day, actions: [{ id: `a${i}`, type: 'EMAIL', label: 'Email' }] }));
const fos = [{ id: 'fo', name: 'Alisa', twentyMemberId: 'wm' }];
const people = (n: number): PlannerPerson[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Person ${String(i).padStart(4, '0')}`, ownerMemberId: 'wm', tags: [], contactType: [], tier: null }));
const draft = (count = 5, days = [1], batchSize = 1): CampaignDraft => ({ name: 'Autumn', podId: 'pod', startDate: '2026-10-05', endDate: '2026-10-09', productInterest: ['PRODUCT'], defaultBatchSize: batchSize, fos: [{ id: 'fo', batchSize }], flows: [{ id: 'default', name: 'Default', steps: steps(days) }], personIds: people(count).map(p => p.id), assignments: {} });
function invariants(d: CampaignDraft, p: CampaignCalendar) {
  expect(p.valid).toBe(true);
  expect(p.batches.flatMap(b => b.personIds).sort()).toEqual([...d.personIds].sort());
  for (const f of d.fos) for (const day of p.days) {
    const onDay = p.batches.filter(b => b.foId === f.id && b.dates.includes(day));
    expect(onDay.length).toBeGreaterThanOrEqual(1); expect(onDay.length).toBeLessThanOrEqual(2);
    expect(new Set(onDay.map(b => b.dates.indexOf(day))).size).toBe(onDay.length);
    expect(onDay.reduce((n, b) => n + b.personIds.length, 0)).toBeLessThanOrEqual(2 * f.batchSize);
  }
  for (const b of p.batches) {
    expect(b.personIds.length).toBeLessThanOrEqual(d.fos.find(f => f.id === b.foId)!.batchSize);
    expect(b.dates).toEqual(outreachDates(b.dates[0], d.flows.find(f => f.id === b.flowId)!.steps));
    expect(b.dates.every(workingDay)).toBe(true); expect(b.dates.at(-1)! <= d.endDate).toBe(true);
  }
}
describe('campaign calendar constraints', () => {
  it('moves Saturday to Friday, except a one-day gap, and Sunday to Monday', () => {
    expect(outreachDates('2026-10-06', steps([1, 5]))).toEqual(['2026-10-06', '2026-10-09']);
    expect(outreachDates('2026-10-09', steps([1, 2, 3]))).toEqual(['2026-10-09', '2026-10-12', '2026-10-13']);
    expect(outreachDates('2026-10-09', steps([1, 3]))).toEqual(['2026-10-09', '2026-10-12']);
  });
  it('uses calendar dates across DST, month and year boundaries', () => {
    expect(outreachDates('2026-10-30', steps([1, 2, 3]))).toEqual(['2026-10-30', '2026-11-02', '2026-11-03']);
    expect(outreachDates('2027-12-31', steps([1, 2, 3]))).toEqual(['2027-12-31', '2028-01-03', '2028-01-04']);
  });
  it('reserves two different stages, never two first-touch batches in one day', () => {
    const d = draft(4, [1, 2]); const p = buildCampaignCalendar(d, people(4), fos); invariants(d, p);
    expect(p.batches.map(b => b.dates[0])).toEqual(['2026-10-05','2026-10-06','2026-10-07','2026-10-08']);
  });
  it('blocks empty days and steps beyond the deadline', () => {
    expect(buildCampaignCalendar(draft(1), people(1), fos).valid).toBe(false);
    expect(buildCampaignCalendar(draft(5, [1, 8]), people(5), fos).valid).toBe(false);
    expect(buildCampaignCalendar(draft(6), people(6), fos).valid).toBe(false);
  });
  it('prioritizes Clients, MIP, Tier 1, Tier 2, Tier 3 with overlap taking the highest', () => {
    const p = people(5); p[0].tier = 'TIER_3'; p[1].tier = 'TIER_2'; p[2].tier = 'LEVEL_1'; p[3].tags = ['mIp']; p[4].contactType = ['CLIENT']; p[4].tags = ['MIP'];
    const c = buildCampaignCalendar(draft(), p, fos); invariants(draft(), c);
    expect(c.batches.map(b => b.personIds[0])).toEqual(['p4','p3','p2','p1','p0']);
    expect(p.map(contactPriority)).toEqual([4,3,2,1,0]);
  });
  it('keeps selected contacts on their own flow and refuses unselected owners', () => {
    const d = draft(4, [1,2]); d.flows.push({ id: 'custom', name: 'Clients', steps: steps([1,2]) }); d.assignments.p1 = 'custom';
    const p = buildCampaignCalendar(d, people(4), fos); invariants(d, p); expect(p.batches.find(b => b.personIds.includes('p1'))?.flowId).toBe('custom');
    const records = people(4); records[0].ownerMemberId = 'someone-else'; expect(buildCampaignCalendar(d, records, fos).issues[0].title).toContain('owner outside');
  });
  it('honors different FO batch sizes and rejects an FO with no audience', () => {
    const d = draft(15); d.fos.push({ id: 'b', batchSize: 2 });
    const p = people(15).map((p, i) => ({ ...p, ownerMemberId: i < 5 ? 'wm' : 'wm-b' }));
    const f = [...fos, { id: 'b', name: 'B', twentyMemberId: 'wm-b' }]; invariants(d, buildCampaignCalendar(d, p, f));
    expect(buildCampaignCalendar(d, people(15), f).issues.some(i => i.title.includes('no people'))).toBe(true);
  });
  it('returns only verified suggestions and distinguishes search limits from infeasibility', () => {
    const d = draft(4, [1,3]); const suggestions = suggestCampaignCalendar(d, people(4), fos);
    expect(suggestions.length).toBeGreaterThan(0); for (const s of suggestions) invariants(s.draft, s.calendar);
    // Said the way the outreach editor shows it: the wait between two steps, old and new.
    expect(suggestions.map(s => s.label)).toContain('Send step 2 one day after step 1, not two');
    const limit = buildCampaignCalendar(draft(4,[1,2]), people(4), fos, 0); expect(limit.exhausted).toBe(true); expect(limit.valid).toBe(false);
  });
  it('rejects tampered dates, duplicate FO IDs, invalid assignments and nonpositive gaps', () => {
    const d = draft(); expect(CampaignDraftSchema.safeParse(d).success).toBe(true);
    for (const bad of [{ ...d, endDate:'invalid' }, { ...d, fos:[...d.fos,...d.fos] }, { ...d, assignments:{p1:'missing'} }, { ...d, flows:[{...d.flows[0],steps:steps([1,1])}] }]) expect(CampaignDraftSchema.safeParse(bad).success).toBe(false);
  });
  it('checks deterministic schedules across 420 audience, spacing and start-date combinations', () => {
    let valid = 0;
    for (let offset = 0; offset < 7; offset++) for (let count = 1; count <= 10; count++) for (let gap = 1; gap <= 6; gap++) {
      const d = draft(count,[1,1+gap]); d.startDate = addDays(d.startDate,offset); d.endDate = addDays(d.startDate,11);
      const p = buildCampaignCalendar(d, people(count), fos, 5000);
      expect(p).toEqual(buildCampaignCalendar(d, people(count), fos, 5000));
      if (p.valid) { valid++; invariants(d,p); }
    }
    expect(valid).toBeGreaterThan(10);
  });
  it('plans a large audience without multiplying tasks by action count', () => {
    const d = draft(2000,[1],400); const p = people(2000);
    d.flows[0].steps[0].actions.push({id:'call',type:'CALL',label:'Call'});
    invariants(d,buildCampaignCalendar(d,p,fos));
  });
  it('agrees with an independent exhaustive search for 192 small mixed-flow plans', () => {
    for (let offset = 0; offset < 4; offset++) for (let count = 1; count <= 4; count++) for (let gap = 1; gap <= 3; gap++) for (let window = 3; window <= 6; window++) {
      const d = draft(count, [1, 1 + gap]); d.startDate = addDays(d.startDate, offset); d.endDate = addDays(d.startDate, window);
      d.flows.push({ id: 'custom', name: 'Custom', steps: steps([1, 2]) });
      for (let i = 1; i < count; i += 2) d.assignments[`p${i}`] = 'custom';
      const orderedFlows = people(count).map(p => d.assignments[p.id] ?? 'default').sort((a, b) => (a === 'default' ? 0 : 1) - (b === 'default' ? 0 : 1));
      const days: string[] = [];
      for (let date = d.startDate; date <= d.endDate; date = addDays(date, 1)) if (workingDay(date)) days.push(date);
      const independentDates = (start: string, gap: number) => {
        let end = addDays(start, gap); const dow = new Date(end + 'T12:00:00Z').getUTCDay();
        end = addDays(end, dow === 0 ? 1 : dow === 6 ? gap === 1 ? 2 : -1 : 0);
        return [start, end];
      };
      const enumerate = (chosen: string[][], after: number): boolean => {
        if (chosen.length === count) return days.every(date => {
          const stages = chosen.flatMap(dates => dates.includes(date) ? [dates.indexOf(date)] : []);
          return stages.length >= 1 && stages.length <= 2 && new Set(stages).size === stages.length;
        });
        for (let start = after + 1; start < days.length; start++) {
          const dates = independentDates(days[start], orderedFlows[chosen.length] === 'custom' ? 1 : gap);
          if (dates[1] <= d.endDate && enumerate([...chosen, dates], start)) return true;
        }
        return false;
      };
      expect(buildCampaignCalendar(d, people(count), fos).valid).toBe(enumerate([], -1));
    }
  });
  it('offers an explicitly described pacing adjustment for the hosted default', () => {
    const d = draft(100, [1], 20); d.flows[0].steps = CAMPAIGN_DEFAULT_STEPS; d.endDate = addDays(d.startDate, 42);
    const suggestions = suggestCampaignCalendar(d, people(100), fos);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) {
      invariants(s.draft, s.calendar);
      expect(s.draft.flows[0].steps.map(s => s.actions)).toEqual(CAMPAIGN_DEFAULT_STEPS.map(s => s.actions));
    }
  });
});

describe('month calendar', () => {
  it('shows whole Monday-to-Sunday weeks for every month length, across years', () => {
    const months = calendarMonths('2026-01-15', '2028-12-02');
    expect(months).toHaveLength(36);
    for (const month of months) {
      const grid = monthGrid(month);
      const [y, m] = month.split('-').map(Number);
      const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
      expect([28, 35, 42]).toContain(grid.length);
      expect(weekday(grid[0])).toBe(1); expect(weekday(grid.at(-1)!)).toBe(0);
      grid.forEach((d, i) => { if (i) expect(d).toBe(addDays(grid[i - 1], 1)); });
      const own = grid.filter(d => d.startsWith(month));
      expect(own).toHaveLength(length); expect(own[0]).toBe(`${month}-01`);
    }
    // 31 days from a Saturday takes six rows; 28 from a Monday, four.
    expect(monthGrid('2026-08')).toHaveLength(42); expect(monthGrid('2027-02')).toHaveLength(28);
    expect(monthGrid('2028-02').filter(d => d.startsWith('2028-02'))).toHaveLength(29);
    expect(calendarMonths('2026-12-28', '2027-01-04')).toEqual(['2026-12', '2027-01']);
    expect(calendarMonths('2026-09-24', '2026-09-30')).toEqual(['2026-09']);
  });

  it('says dates the way people do: years only across a year, small counts in words', () => {
    expect(dateRangeLabel('2026-09-24', '2026-09-30')).toBe('Thu, Sep 24 to Wed, Sep 30');
    expect(dateRangeLabel('2026-09-24', '2027-09-24')).toBe('Thu, Sep 24, 2026 to Fri, Sep 24, 2027');
    expect(dateRangeLabel('2026-09-26', '2026-09-26')).toBe('Sat, Sep 26');
    expect([1, 2, 10, 11].map(numberInWords)).toEqual(['one', 'two', 'ten', '11']);
  });
});
