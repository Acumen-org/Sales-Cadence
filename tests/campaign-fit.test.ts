import { describe, it, expect } from 'vitest';
import { fitCampaign, isFit, MAX_PACE, startDaysFor, type CampaignFit } from '@/lib/campaign-fit';
import { outreachRecipe } from '@/lib/campaign-starter';
import { addDays } from '@/lib/dates';
import { buildCampaignCalendar, calendarDays, contactPriority, outreachDates, priorityGroups, workingDay, type CampaignDraft, type PlannerPerson } from '@/lib/campaign-planner';

const fos = [{ id: 'fo', name: 'Alisa', twentyMemberId: 'wm' }];
const people = (n: number, owner: string | null = 'wm', prefix = 'p'): PlannerPerson[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix} ${String(i).padStart(4, '0')}`, ownerMemberId: owner, tags: [], contactType: [], tier: null }));
const draft = (ids: string[], over: Partial<CampaignDraft> = {}): CampaignDraft => ({ name: 'Test', podId: 'pod', startDate: '2027-01-04', endDate: '2027-01-08', productInterest: ['PHH'], defaultBatchSize: 1, fos: [{ id: 'fo', batchSize: 1 }], personIds: ids, assignments: {}, flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(1) }], ...over });
const fitted = (r: ReturnType<typeof fitCampaign>): CampaignFit => { expect(isFit(r)).toBe(true); return r as CampaignFit; };

/** The planning rules, checked on a fitted result exactly as the planner tests check a calendar. */
function covered(fit: CampaignFit) {
  const { draft: d, calendar: c } = fit;
  expect(c.valid).toBe(true);
  expect(c.batches.flatMap(b => b.personIds).sort()).toEqual([...d.personIds].sort());
  for (const f of d.fos) for (const day of c.days) {
    const onDay = c.batches.filter(b => b.foId === f.id && b.dates.includes(day));
    expect(onDay.length).toBeGreaterThanOrEqual(1); expect(onDay.length).toBeLessThanOrEqual(2);
    expect(new Set(onDay.map(b => b.dates.indexOf(day))).size).toBe(onDay.length);
  }
  for (const b of c.batches) {
    expect(b.personIds.length).toBeLessThanOrEqual(d.fos.find(f => f.id === b.foId)!.batchSize);
    expect(b.dates).toEqual(outreachDates(b.dates[0], d.flows.find(f => f.id === b.flowId)!.steps));
    expect(b.dates.every(workingDay)).toBe(true); expect(b.dates.at(-1)! <= d.endDate).toBe(true);
  }
  // The fitted draft reproduces its calendar on its own: publishing and launch can rely on it.
  expect(buildCampaignCalendar(d, c.people, c.fos)).toEqual(c);
}

describe('fitting a campaign to its dates', () => {
  it('fits the owner’s 23-30 September campaign for Alyssa and Avani within 20 a day', () => {
    const team = [{ id: 'alyssa', name: 'Alyssa', twentyMemberId: 'wm-alyssa' }, { id: 'avani', name: 'Avani', twentyMemberId: 'wm-avani' }];
    const audience = [...people(88, 'wm-alyssa', 'al'), ...people(16, 'wm-avani', 'av'), ...people(1, null, 'free')].map((p, i) => ({ ...p, tags: i % 3 === 0 ? ['MIP'] : [], contactType: i % 3 === 1 ? ['CLIENTS'] : [], tier: i % 3 === 2 ? 'LEVEL_1' : null }));
    const d = draft(audience.map(p => p.id), { startDate: '2026-09-23', endDate: '2026-09-30', defaultBatchSize: 20, fos: team.map(f => ({ id: f.id, batchSize: 20 })) });
    const fit = fitted(fitCampaign(d, audience, team, { reshapeOutreach: true }));
    covered(fit);
    expect(fit.overflow).toEqual([]); expect(fit.droppedFos).toEqual([]);
    expect(fit.paces.map(p => [p.name, p.to])).toEqual([['Alyssa', 18], ['Avani', 6]]);
    expect(fit.draft.flows.map(f => f.steps.length)).toEqual([2]);
  });
  it('keeps the request when it already fits, and shortens the outreach for a short four-batch window', () => {
    const fit = fitted(fitCampaign(draft(people(4).map(p => p.id)), people(4), fos, { reshapeOutreach: true }));
    covered(fit);
    expect(fit.draft.flows[0].steps).toHaveLength(2); expect(fit.paces).toEqual([{ foId: 'fo', name: 'Alisa', from: 1, to: 1 }]);
  });
  it('extends the channel recipe for a longer single-batch campaign', () => {
    const fit = fitted(fitCampaign(draft(['p0'], { endDate: '2027-01-15' }), people(1), fos, { reshapeOutreach: true }));
    expect(fit.draft.flows[0].steps).toHaveLength(10); expect(fit.draft.flows[0].steps.at(-1)!.title).toBe('Close the loop');
    covered(fit);
  });
  it('raises a pace only to the lowest that takes everyone, with no fixed ceiling', () => {
    const six = fitted(fitCampaign(draft(people(6).map(p => p.id)), people(6), fos, { reshapeOutreach: true }));
    covered(six); expect(six.draft.fos[0].batchSize).toBe(2);
    // 300 people in five working days: one touchpoint a day is the least any outreach needs, so 60.
    const fit = fitted(fitCampaign(draft(people(300).map(p => p.id), { defaultBatchSize: 20, fos: [{ id: 'fo', batchSize: 20 }] }), people(300), fos, { reshapeOutreach: true }));
    covered(fit);
    expect(fit.draft.fos[0].batchSize).toBe(60); expect(fit.overflow).toEqual([]);
  });
  it('lowers a pace so a small audience still covers every working day', () => {
    const d = draft(people(12).map(p => p.id), { defaultBatchSize: 20, fos: [{ id: 'fo', batchSize: 20 }], endDate: '2027-01-15' });
    // Daily steps: with two-day waits no batch size tiles these ten days around the weekend.
    d.flows = [{ id: 'default', name: 'Default', steps: outreachRecipe(3, 1) }];
    const fit = fitted(fitCampaign(d, people(12), fos, { reshapeOutreach: false }));
    covered(fit); expect(fit.draft.fos[0].batchSize).toBeLessThan(20);
    expect(fit.draft.flows).toBe(d.flows);
  });
  it('never changes the dates or an edited outreach', () => {
    const d = draft(people(9).map(p => p.id), { defaultBatchSize: 3, fos: [{ id: 'fo', batchSize: 3 }], flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(2, 1) }], outreachEdited: true });
    const fit = fitted(fitCampaign(d, people(9), fos, { reshapeOutreach: false }));
    covered(fit);
    expect([fit.draft.startDate, fit.draft.endDate]).toEqual([d.startDate, d.endDate]);
    expect(fit.draft.flows).toEqual(d.flows);
  });
  it('says why an edited outreach cannot take everyone, instead of changing it', () => {
    const gap2 = draft(people(4).map(p => p.id), { flows: [{ id: 'default', name: 'Default', steps: [outreachRecipe(2)[0], { ...outreachRecipe(2)[1], day: 3 }] }], outreachEdited: true });
    expect(fitCampaign(gap2, people(4), fos, { reshapeOutreach: false })).toEqual({ problems: [{ foId: 'fo', name: 'Alisa', reason: 'search' }] });
    const long = draft(people(4).map(p => p.id), { flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(8, 2) }], outreachEdited: true });
    expect(fitCampaign(long, people(4), fos, { reshapeOutreach: false })).toEqual({ problems: [{ foId: 'fo', name: 'Alisa', reason: 'window' }] });
  });
  it('leaves out only beyond 500 a day, and only the lowest priority', () => {
    const audience = people(3000).map((p, i) => ({ ...p, tier: i < 400 ? 'LEVEL_1' : i < 1500 ? 'LEVEL_2' : null }));
    const fit = fitted(fitCampaign(draft(audience.map(p => p.id), { defaultBatchSize: 20, fos: [{ id: 'fo', batchSize: 20 }] }), audience, fos, { reshapeOutreach: true }));
    covered(fit);
    expect(fit.draft.fos[0].batchSize).toBe(MAX_PACE); expect(fit.overflow).toHaveLength(500);
    const rank = new Map(audience.map(p => [p.id, contactPriority(p)]));
    expect(Math.max(...fit.draft.personIds.map(id => rank.get(id)!))).toBeLessThanOrEqual(Math.min(...fit.overflow.map(id => rank.get(id)!)));
  });
  it('gives an FO with few contacts an outreach of their own rather than slowing the others', () => {
    const team = [{ id: 'alyssa', name: 'Alyssa', twentyMemberId: 'wm-alyssa' }, { id: 'avani', name: 'Avani', twentyMemberId: 'wm-avani' }];
    const audience = [...people(88, 'wm-alyssa', 'al'), ...people(2, 'wm-avani', 'av')];
    const d = draft(audience.map(p => p.id), { startDate: '2026-09-23', endDate: '2026-09-30', defaultBatchSize: 20, fos: team.map(f => ({ id: f.id, batchSize: 20 })) });
    const fit = fitted(fitCampaign(d, audience, team, { reshapeOutreach: true }));
    covered(fit);
    expect(fit.draft.flows.map(f => f.name)).toEqual(['Default', 'For Avani']);
    expect(fit.draft.assignments).toEqual({ av0: 'fo-avani', av1: 'fo-avani' });
    expect(fit.paces.every(p => p.to <= 20)).toBe(true); expect(fit.droppedFos).toEqual([]);
  });
  it('leaves an FO off only when no outreach can fill the window with their contacts, and moves their unowned contacts', () => {
    const team = [...fos, { id: 'b', name: 'Bea', twentyMemberId: 'wm-b' }];
    // Fourteen weeks: more working days than the sixty touchpoints one contact could take.
    const long = { endDate: '2027-04-09', defaultBatchSize: 20, fos: [{ id: 'fo', batchSize: 20 }, { id: 'b', batchSize: 20 }] };
    const owned = [...people(200), ...people(1, 'wm-b', 'b')];
    const fit = fitted(fitCampaign(draft(owned.map(p => p.id), long), owned, team, { reshapeOutreach: true }));
    covered(fit);
    expect(fit.droppedFos).toEqual([{ id: 'b', name: 'Bea', personIds: ['b0'], reason: 'few' }]);
    const unowned = [...people(200), ...people(1, null, 'u')];
    const moved = fitted(fitCampaign(draft(unowned.map(p => p.id), long), unowned, team, { reshapeOutreach: true }));
    covered(moved);
    expect(moved.droppedFos).toEqual([{ id: 'b', name: 'Bea', personIds: [], reason: 'few' }]); expect(moved.draft.personIds).toContain('u0');
  });
  it('leaves off an FO with no contacts here, and pins unowned contacts so the published plan cannot drift', () => {
    const team = [...fos, { id: 'b', name: 'Bea', twentyMemberId: 'wm-b' }, { id: 'c', name: 'Cy', twentyMemberId: 'wm-c' }];
    const audience = [...people(6), ...people(4, null, 'u')];
    const d = draft(audience.map(p => p.id), { endDate: '2027-01-15', defaultBatchSize: 2, fos: [{ id: 'fo', batchSize: 2 }, { id: 'b', batchSize: 2 }] });
    const fit = fitted(fitCampaign(d, audience, team, { reshapeOutreach: true }));
    covered(fit);
    expect(Object.keys(fit.draft.foAssignments ?? {}).sort()).toEqual(['u0', 'u1', 'u2', 'u3']);
    expect(fitCampaign(d, audience, team, { reshapeOutreach: true })).toEqual(fit);
    // Every selected FO who can be served stays on the plan, however few contacts they are given.
    const withCy = fitted(fitCampaign({ ...d, fos: [...d.fos, { id: 'c', batchSize: 2 }] }, audience, team, { reshapeOutreach: true }));
    covered(withCy);
    expect(withCy.draft.fos.map(f => f.id)).toEqual(['fo', 'b', 'c']); expect(withCy.droppedFos).toEqual([]); expect(withCy.draft.personIds).toHaveLength(10);
  });
  it('never raises a pace that the request already covers, whatever the other FOs need', () => {
    const team = [...fos, { id: 'b', name: 'Bea', twentyMemberId: 'wm-b' }, { id: 'c', name: 'Cy', twentyMemberId: 'wm-c' }];
    const audience = [...people(900), ...people(150, 'wm-b', 'b'), ...people(40, 'wm-c', 'c')];
    const fit = fitted(fitCampaign(draft(audience.map(p => p.id), { endDate: '2027-03-31', defaultBatchSize: 20, fos: team.map(f => ({ id: f.id, batchSize: 20 })) }), audience, team, { reshapeOutreach: true }));
    covered(fit); expect(fit.paces.every(p => p.to <= 20)).toBe(true);
  });
  it('takes a pace within 10% of the lowest when it buys more touchpoints', () => {
    const fit = fitted(fitCampaign(draft(people(300).map(p => p.id), { endDate: '2027-02-12', defaultBatchSize: 5, fos: [{ id: 'fo', batchSize: 5 }] }), people(300), fos, { reshapeOutreach: true }));
    covered(fit);
    // One touchpoint needs 10 a day; two need 11.
    expect(fit.draft.fos[0].batchSize).toBe(11); expect(fit.draft.flows[0].steps).toHaveLength(2);
  });
  it('keeps the highest-priority contacts an edited outreach can take at 500 a day', () => {
    const d = draft(people(9000).map(p => p.id), { endDate: '2027-02-12', defaultBatchSize: 20, fos: [{ id: 'fo', batchSize: 20 }], flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(4, 1) }], outreachEdited: true });
    const fit = fitted(fitCampaign(d, people(9000), fos, { reshapeOutreach: false }));
    covered(fit); expect(fit.draft.fos[0].batchSize).toBe(MAX_PACE); expect(fit.overflow.length).toBeGreaterThan(0); expect(fit.draft.personIds.length).toBeGreaterThan(6000);
  });
  it('refuses only what cannot be planned at all', () => {
    expect(fitCampaign(draft([]), [], fos, { reshapeOutreach: true })).toBeNull();
    expect(fitCampaign(draft(['p0'], { startDate: '2027-01-09', endDate: '2027-01-10' }), people(1), fos, { reshapeOutreach: true })).toBeNull();
    expect(fitCampaign(draft(['p0']), people(1).map(p => ({ ...p, ownerMemberId: 'other' })), fos, { reshapeOutreach: true })).toBeNull();
  });
  it('plans everyone in every one of 60 size and window combinations', () => {
    for (let n = 1; n <= 6; n++) for (let days = 5; days <= 14; days++) {
      const fit = fitted(fitCampaign(draft(people(n).map(p => p.id), { endDate: `2027-01-${String(4 + days).padStart(2, '0')}` }), people(n), fos, { reshapeOutreach: true }));
      covered(fit); expect(fit.overflow).toEqual([]);
    }
  });
  it('plans 2,000 contacts over six weeks and 500 over a year in reasonable time', () => {
    const audience = people(2000).map((p, i) => ({ ...p, tier: i % 4 === 0 ? 'LEVEL_1' : null }));
    let started = Date.now();
    const six = fitted(fitCampaign(draft(audience.map(p => p.id), { endDate: '2027-02-12', defaultBatchSize: 40, fos: [{ id: 'fo', batchSize: 40 }] }), audience, fos, { reshapeOutreach: true }));
    covered(six); expect(Date.now() - started).toBeLessThan(10000);
    started = Date.now();
    const year = fitted(fitCampaign(draft(audience.slice(0, 500).map(p => p.id), { endDate: '2027-12-31', defaultBatchSize: 10, fos: [{ id: 'fo', batchSize: 10 }] }), audience.slice(0, 500), fos, { reshapeOutreach: true }));
    covered(year); expect(Date.now() - started).toBeLessThan(10000);
  });
  it('counts start days exactly as walking every day would, across spacings and windows', () => {
    for (let offset = 0; offset < 7; offset++) for (const length of [4, 11, 30, 64]) for (const [s, gap] of [[1, 1], [2, 1], [3, 2], [5, 3], [8, 4], [4, 7], [6, 5]]) {
      const start = addDays('2027-01-04', offset), end = addDays(start, length), steps = outreachRecipe(s, gap);
      const walked = calendarDays(start, end).filter(d => { const dates = outreachDates(d, steps); return !!dates && dates.at(-1)! <= end; }).length;
      expect(startDaysFor(start, end, steps)).toBe(walked);
    }
  });
});

describe('priority groups', () => {
  it('agree with contactPriority for every label combination', () => {
    const labels = ['Client', 'CLIENTS', 'mip', 'Tier 1', 'LEVEL_2', '3', 'Prospect'];
    for (let mask = 0; mask < 1 << labels.length; mask++) for (const tier of [null, 'LEVEL_1', 'LEVEL_3', 'LEVEL_4']) {
      const tags = labels.filter((_, i) => mask & (1 << i));
      const p = { tags, contactType: [], tier };
      expect(Math.min(...priorityGroups(p))).toBe(contactPriority(p));
    }
  });
});
