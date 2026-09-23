import { describe, it, expect } from 'vitest';
import { fitCampaign, paceCeiling } from '@/lib/campaign-fit';
import { outreachRecipe } from '@/lib/campaign-starter';
import { buildCampaignCalendar, contactPriority, outreachDates, priorityGroups, workingDay, type CampaignCalendar, type CampaignDraft, type PlannerPerson } from '@/lib/campaign-planner';

const fos = [{ id: 'fo', name: 'Alisa', twentyMemberId: 'wm' }];
const people = (n: number, owner: string | null = 'wm', prefix = 'p'): PlannerPerson[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix} ${String(i).padStart(4, '0')}`, ownerMemberId: owner, tags: [], contactType: [], tier: null }));
const draft = (ids: string[], over: Partial<CampaignDraft> = {}): CampaignDraft => ({ name: 'Test', podId: 'pod', startDate: '2027-01-04', endDate: '2027-01-08', productInterest: ['PHH'], defaultBatchSize: 1, fos: [{ id: 'fo', batchSize: 1 }], personIds: ids, assignments: {}, flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(1) }], ...over });

/** The planning rules, checked on a fitted result exactly as the planner tests check a calendar. */
function covered(d: CampaignDraft, c: CampaignCalendar) {
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
  it('fits the owner’s 23-30 September campaign for Alyssa and Avani at 20 a day without asking', () => {
    const team = [{ id: 'alyssa', name: 'Alyssa', twentyMemberId: 'wm-alyssa' }, { id: 'avani', name: 'Avani', twentyMemberId: 'wm-avani' }];
    const audience = [...people(88, 'wm-alyssa', 'al'), ...people(16, 'wm-avani', 'av'), ...people(1, null, 'free')].map((p, i) => ({ ...p, tags: i % 3 === 0 ? ['MIP'] : [], contactType: i % 3 === 1 ? ['CLIENTS'] : [], tier: i % 3 === 2 ? 'LEVEL_1' : null }));
    const d = draft(audience.map(p => p.id), { startDate: '2026-09-23', endDate: '2026-09-30', defaultBatchSize: 20, fos: team.map(f => ({ id: f.id, batchSize: 20 })) });
    const fit = fitCampaign(d, audience, team, { reshapeOutreach: true })!;
    expect(fit).not.toBeNull();
    covered(fit.draft, fit.calendar);
    expect(fit.overflow).toEqual([]); expect(fit.droppedFos).toEqual([]);
    for (const p of fit.paces) expect(p.to).toBeLessThanOrEqual(paceCeiling(20));
    expect(fit.draft.flows[0].steps.length).toBeGreaterThanOrEqual(2);
  });
  it('keeps the request when it already fits, and shortens the starter for a short four-batch window', () => {
    const fit = fitCampaign(draft(people(4).map(p => p.id)), people(4), fos, { reshapeOutreach: true })!;
    covered(fit.draft, fit.calendar);
    expect(fit.draft.flows[0].steps).toHaveLength(2); expect(fit.paces).toEqual([{ foId: 'fo', name: 'Alisa', from: 1, to: 1 }]);
  });
  it('extends the channel recipe for a longer single-batch campaign', () => {
    const fit = fitCampaign(draft(['p0'], { endDate: '2027-01-15' }), people(1), fos, { reshapeOutreach: true })!;
    expect(fit.draft.flows[0].steps).toHaveLength(10); expect(fit.draft.flows[0].steps.at(-1)!.title).toBe('Close the loop');
    covered(fit.draft, fit.calendar);
  });
  it('raises a pace within its ceiling instead of refusing more first batches than days', () => {
    const fit = fitCampaign(draft(people(6).map(p => p.id)), people(6), fos, { reshapeOutreach: true })!;
    covered(fit.draft, fit.calendar); expect(fit.draft.fos[0].batchSize).toBe(2); expect(fit.overflow).toEqual([]);
  });
  it('lowers a pace so a small audience still covers every working day', () => {
    const d = draft(people(12).map(p => p.id), { defaultBatchSize: 20, fos: [{ id: 'fo', batchSize: 20 }], endDate: '2027-01-15' });
    // Daily steps: with two-day waits no batch size tiles these ten days around the weekend.
    d.flows = [{ id: 'default', name: 'Default', steps: outreachRecipe(3, 1) }];
    const fit = fitCampaign(d, people(12), fos, { reshapeOutreach: false })!;
    covered(fit.draft, fit.calendar); expect(fit.draft.fos[0].batchSize).toBeLessThan(20);
    expect(fit.draft.flows).toBe(d.flows);
  });
  it('never changes the dates or an edited outreach', () => {
    const d = draft(people(9).map(p => p.id), { defaultBatchSize: 3, fos: [{ id: 'fo', batchSize: 3 }], flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(2, 1) }], outreachEdited: true });
    const fit = fitCampaign(d, people(9), fos, { reshapeOutreach: false })!;
    covered(fit.draft, fit.calendar);
    expect([fit.draft.startDate, fit.draft.endDate]).toEqual([d.startDate, d.endDate]);
    expect(fit.draft.flows).toEqual(d.flows);
  });
  it('as a last resort leaves out the lowest priority people, never a higher one', () => {
    const audience = people(300).map((p, i) => ({ ...p, tier: i < 40 ? 'LEVEL_1' : i < 100 ? 'LEVEL_2' : null }));
    const d = draft(audience.map(p => p.id), { defaultBatchSize: 20, fos: [{ id: 'fo', batchSize: 20 }] });
    const fit = fitCampaign(d, audience, fos, { reshapeOutreach: true })!;
    covered(fit.draft, fit.calendar);
    expect(fit.overflow.length).toBeGreaterThan(0);
    const kept = new Set(fit.draft.personIds), rank = new Map(audience.map(p => [p.id, contactPriority(p)]));
    const worstKept = Math.max(...[...kept].map(id => rank.get(id)!)), bestLeft = Math.min(...fit.overflow.map(id => rank.get(id)!));
    expect(worstKept).toBeLessThanOrEqual(bestLeft);
    expect(fit.draft.fos[0].batchSize).toBeLessThanOrEqual(paceCeiling(20));
  });
  it('leaves an FO off when their own contacts cannot fill every working day, instead of blocking the others', () => {
    const team = [...fos, { id: 'b', name: 'Bea', twentyMemberId: 'wm-b' }];
    const audience = [...people(120), ...people(1, 'wm-b', 'b')];
    const d = draft(audience.map(p => p.id), { endDate: '2027-02-12', defaultBatchSize: 20, fos: [{ id: 'fo', batchSize: 20 }, { id: 'b', batchSize: 20 }] });
    const fit = fitCampaign(d, audience, team, { reshapeOutreach: true })!;
    covered(fit.draft, fit.calendar);
    expect(fit.droppedFos.map(f => f.id)).toEqual(['b']); expect(fit.draft.fos.map(f => f.id)).toEqual(['fo']);
  });
  it('pins unowned contacts to one FO so the published plan cannot drift', () => {
    const team = [...fos, { id: 'b', name: 'Bea', twentyMemberId: 'wm-b' }];
    const audience = [...people(6), ...people(4, null, 'u')];
    const d = draft(audience.map(p => p.id), { endDate: '2027-01-15', defaultBatchSize: 2, fos: [{ id: 'fo', batchSize: 2 }, { id: 'b', batchSize: 2 }] });
    const fit = fitCampaign(d, audience, team, { reshapeOutreach: true })!;
    covered(fit.draft, fit.calendar);
    expect(Object.keys(fit.draft.foAssignments ?? {}).sort()).toEqual(['u0', 'u1', 'u2', 'u3']);
    expect(fitCampaign(d, audience, team, { reshapeOutreach: true })).toEqual(fit);
  });
  it('moves unowned contacts off an FO who is left off, instead of leaving them out', () => {
    const team = [...fos, { id: 'b', name: 'Bea', twentyMemberId: 'wm-b' }];
    const audience = [...people(100), ...people(2, null, 'u')];
    const d = draft(audience.map(p => p.id), { endDate: '2027-02-12', defaultBatchSize: 20, fos: [{ id: 'fo', batchSize: 20 }, { id: 'b', batchSize: 20 }] });
    const fit = fitCampaign(d, audience, team, { reshapeOutreach: true })!;
    covered(fit.draft, fit.calendar);
    expect(fit.droppedFos).toEqual([{ id: 'b', name: 'Bea', personIds: [], reason: 'few' }]);
    expect(fit.draft.personIds).toEqual(expect.arrayContaining(['u0', 'u1'])); expect(fit.overflow).toEqual([]);
  });
  it('can be allowed a higher pace than it takes on its own', () => {
    const audience = people(300);
    const d = draft(audience.map(p => p.id), { defaultBatchSize: 20, fos: [{ id: 'fo', batchSize: 20 }] });
    expect(fitCampaign(d, audience, fos, { reshapeOutreach: true, allowTrim: false })).toBeNull();
    const faster = fitCampaign(d, audience, fos, { reshapeOutreach: true, allowTrim: false, ceiling: () => 500 })!;
    covered(faster.draft, faster.calendar); expect(faster.draft.fos[0].batchSize).toBeGreaterThan(paceCeiling(20));
  });
  it('refuses only what cannot be planned at all', () => {
    expect(fitCampaign(draft([]), [], fos, { reshapeOutreach: true })).toBeNull();
    expect(fitCampaign(draft(['p0'], { startDate: '2027-01-09', endDate: '2027-01-10' }), people(1), fos, { reshapeOutreach: true })).toBeNull();
    expect(fitCampaign(draft(['p0']), people(1).map(p => ({ ...p, ownerMemberId: 'other' })), fos, { reshapeOutreach: true })).toBeNull();
  });
  it('returns only fully covered plans across 60 size and window combinations', () => {
    let fitted = 0;
    for (let n = 1; n <= 6; n++) for (let days = 5; days <= 14; days++) {
      const fit = fitCampaign(draft(people(n).map(p => p.id), { endDate: `2027-01-${String(4 + days).padStart(2, '0')}` }), people(n), fos, { reshapeOutreach: true });
      if (fit) { fitted++; covered(fit.draft, fit.calendar); }
    }
    expect(fitted).toBeGreaterThan(50);
  });
  it('plans 2,000 contacts over six weeks in reasonable time', () => {
    const audience = people(2000).map((p, i) => ({ ...p, tier: i % 4 === 0 ? 'LEVEL_1' : null }));
    const started = Date.now();
    const fit = fitCampaign(draft(audience.map(p => p.id), { endDate: '2027-02-12', defaultBatchSize: 40, fos: [{ id: 'fo', batchSize: 40 }] }), audience, fos, { reshapeOutreach: true })!;
    covered(fit.draft, fit.calendar);
    expect(Date.now() - started).toBeLessThan(15000);
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
