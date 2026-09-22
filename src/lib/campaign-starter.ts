import { buildCampaignCalendar, calendarDays, campaignBatches, type CampaignDraft, type PlannerPerson, type PlannerFo } from './campaign-planner';
import { CAMPAIGN_DEFAULT_STEPS } from './sequences/campaign-default';

/** The channel pattern is a recipe, not a saved or fixed-length sequence. */
export function outreachRecipe(count: number, gap = 1) {
  return Array.from({ length: count }, (_, i) => {
    const source = i === 0 ? 0 : count >= 4 && i === count - 1 ? 7 : 1 + (i - 1) % 6;
    const step = structuredClone(CAMPAIGN_DEFAULT_STEPS[source]);
    return { ...step, id: `starter-${i}`, day: 1 + i * gap, actions: step.actions.map((a, j) => ({ ...a, id: `starter-${i}-${j}` })) };
  });
}

export function outreachLimits(d: CampaignDraft, people: PlannerPerson[], fos: PlannerFo[]) {
  const days = calendarDays(d.startDate, d.endDate).length;
  const { batches } = campaignBatches(d, people, fos);
  return Object.fromEntries(d.flows.map(flow => {
    let cap = Math.min(60, days);
    for (const fo of d.fos) {
      const own = batches.filter(b => b.foId === fo.id);
      const matching = own.filter(b => b.flowId === flow.id).length;
      if (!matching) continue;
      const other = own.filter(b => b.flowId !== flow.id).reduce((n, b) => n + d.flows.find(f => f.id === b.flowId)!.steps.length, 0);
      cap = Math.min(cap, Math.floor((2 * days - other) / matching));
    }
    return [flow.id, Math.max(0, cap)];
  }));
}

/** Generate only a starter which the actual scheduler can execute for this audience. */
export function fitCampaignStarter(d: CampaignDraft, people: PlannerPerson[], fos: PlannerFo[]) {
  const base = { ...d, assignments: {}, flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(1) }] };
  const { batches, issues } = campaignBatches(base, people, fos);
  if (issues.length) return null;
  const days = calendarDays(d.startDate, d.endDate).length;
  const counts = d.fos.map(fo => batches.filter(b => b.foId === fo.id).length);
  if (!days || counts.some(n => !n || n > days)) return null;
  const min = Math.max(...counts.map(n => Math.ceil(days / n)));
  const max = Math.min(60, days, ...counts.map(n => Math.floor(2 * days / n)));
  const lengths = Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i).sort((a, b) => Math.abs(a - 8) - Math.abs(b - 8) || a - b);
  for (const count of lengths) {
    // Prefer breathing room where feasible; one-day spacing is used only when
    // the campaign's window and coverage requirements need it.
    for (const gap of [4, 3, 2, 5, 7, 1]) {
      if ((count - 1) * gap > days * 1.5) continue;
      const draft = { ...base, flows: [{ id: 'default', name: 'Default', steps: outreachRecipe(count, gap) }] };
      const calendar = buildCampaignCalendar(draft, people, fos, 10000);
      if (calendar.valid) return { draft, calendar };
    }
  }
  return null;
}
