import { diffDays } from './dates';
import { buildCampaignCalendar, calendarDays, campaignQueues, outreachDates, type CampaignCalendar, type CampaignDraft, type PlannerFo, type PlannerPerson } from './campaign-planner';
import { outreachRecipe } from './campaign-starter';

/**
 * The studio's own planning: given the dates, the FOs and the people who can be reached, find a
 * calendar the unchanged scheduler accepts, changing only what the campaign owner allowed it to
 * change. Dates never move. In order of preference it adjusts each FO's new people/day, reshapes
 * an outreach nobody has edited yet, and only when nothing fits leaves out the lowest-priority
 * people (or an FO whose own contacts cannot fill every working day). Every result is verified by
 * buildCampaignCalendar; nothing here relaxes a planning rule.
 */

export type FitPace = { foId: string; name: string; from: number; to: number };
export type FitDroppedFo = { id: string; name: string; personIds: string[]; reason: 'none' | 'few' };
export type CampaignFit = { draft: CampaignDraft; calendar: CampaignCalendar; paces: FitPace[]; droppedFos: FitDroppedFo[]; overflow: string[] };

/** How far a requested pace may rise on its own; beyond this the studio asks. */
export const paceCeiling = (target: number) => Math.min(500, Math.max(target, Math.ceil(target * 1.5)));
const GAPS = [4, 3, 2, 5, 7, 1];
/** Shorter than eight steps loses touches quickly; longer ones add little and crowd a small audience. */
const stepPenalty = (s: number) => s <= 8 ? 8 / s : 1 + (s - 8) / 4;
const SEARCH_LIMIT = 20000;
const VERIFY_PER_FO = 12;

type FoCase = { id: string; target: number; ceiling: number; meta: PlannerFo; queue: PlannerPerson[] };
type FoResult = { kind: 'fit'; batchSize: number; kept: PlannerPerson[] } | { kind: 'drop' };
type Run = { flowId: string; length: number };

function runsOf(queue: PlannerPerson[], draft: CampaignDraft, take = queue.length) {
  const runs: Run[] = [];
  for (const p of queue.slice(0, take)) {
    const flowId = draft.assignments[p.id] ?? 'default';
    const last = runs.at(-1);
    if (last && last.flowId === flowId) last.length++; else runs.push({ flowId, length: 1 });
  }
  return runs;
}

class Shape {
  readonly days: number;
  readonly steps = new Map<string, number>();
  readonly starts = new Map<string, number>();
  constructor(readonly draft: CampaignDraft, dayList: string[]) {
    this.days = dayList.length;
    for (const f of draft.flows) {
      this.steps.set(f.id, f.steps.length);
      this.starts.set(f.id, dayList.filter(start => { const dates = outreachDates(start, f.steps); return !!dates && dates.at(-1)! <= draft.endDate; }).length);
    }
  }
  /** Batch count and touchpoints for a queue at one batch size; batches break where outreach changes. */
  measure(runs: Run[], batchSize: number) {
    let count = 0, touches = 0, fits = true;
    const perFlow = new Map<string, number>();
    for (const r of runs) {
      const n = Math.ceil(r.length / batchSize);
      count += n; touches += n * this.steps.get(r.flowId)!;
      perFlow.set(r.flowId, (perFlow.get(r.flowId) ?? 0) + n);
    }
    for (const [flow, n] of perFlow) if (n > this.starts.get(flow)!) fits = false;
    // Only the first batch touches the first working day, so a full calendar holds at most 2D - 1.
    return { count, touches, crowded: !fits || count > this.days || touches > 2 * this.days - 1, sparse: touches < this.days };
  }
}

function subDraft(draft: CampaignDraft, c: FoCase, kept: PlannerPerson[], batchSize: number): CampaignDraft {
  const ids = new Set(kept.map(p => p.id));
  return { ...draft, fos: [{ id: c.id, batchSize }], personIds: kept.map(p => p.id), assignments: Object.fromEntries(Object.entries(draft.assignments).filter(([id]) => ids.has(id))), foAssignments: Object.fromEntries(kept.filter(p => !p.ownerMemberId).map(p => [p.id, c.id])) };
}

/** The pace closest to the request at which this FO's own calendar verifies: at the request, then lower, then higher up to the ceiling. */
function fitPace(shape: Shape, c: FoCase, kept: PlannerPerson[]) {
  const runs = runsOf(kept, shape.draft);
  const ceiling = c.ceiling;
  const candidates: number[] = [];
  const at = shape.measure(runs, c.target);
  if (!at.crowded && !at.sparse) candidates.push(c.target);
  // Lower paces: more, smaller batches. Keep the smallest pace for each batch count, for even batches.
  // The same batch count schedules identically whatever the batch size, so each count is tried once.
  let lastCount = at.count, pick = 0;
  for (let b = c.target - 1; b >= 1; b--) {
    const m = shape.measure(runs, b);
    if (m.count !== lastCount) { if (pick) candidates.push(pick); pick = 0; lastCount = m.count; }
    if (m.touches > 2 * shape.days - 1 || m.count > shape.days) break;
    if (m.count !== at.count && !m.crowded && !m.sparse) pick = b;
  }
  if (pick) candidates.push(pick);
  // Higher paces: fewer, larger batches, never beyond the ceiling.
  lastCount = at.count;
  for (let b = c.target + 1; b <= ceiling; b++) {
    const m = shape.measure(runs, b);
    if (m.touches < shape.days) break;
    if (m.count === lastCount) continue;
    lastCount = m.count;
    if (!m.crowded && !m.sparse) candidates.push(b);
  }
  for (const batchSize of candidates.slice(0, VERIFY_PER_FO)) {
    const calendar = buildCampaignCalendar(subDraft(shape.draft, c, kept, batchSize), kept, [c.meta], SEARCH_LIMIT);
    if (calendar.valid) return batchSize;
  }
  return null;
}

function fitFo(shape: Shape, c: FoCase, allowTrim: boolean): FoResult | null {
  if (!c.queue.length) return { kind: 'drop' };
  const whole = fitPace(shape, c, c.queue);
  if (whole) return { kind: 'fit', batchSize: whole, kept: c.queue };
  if (!allowTrim) return null;
  // One contact per batch gives the most touchpoints this audience can make; if even that leaves
  // days empty, this FO's own contacts cannot fill the window under this outreach.
  if (shape.measure(runsOf(c.queue, shape.draft), 1).sparse) return { kind: 'drop' };
  const ceiling = c.ceiling;
  let lo = 1, hi = c.queue.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (!shape.measure(runsOf(c.queue, shape.draft, mid), ceiling).crowded) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  for (let k = best, tries = 0; k >= 1 && tries < 8; k -= ceiling, tries++) {
    const kept = c.queue.slice(0, k);
    if (shape.measure(runsOf(kept, shape.draft), 1).sparse) break;
    const batchSize = fitPace(shape, c, kept);
    if (batchSize) return { kind: 'fit', batchSize, kept };
  }
  return null;
}

type Candidate = { score: number; flows: CampaignDraft['flows']; results: FoResult[] };

export function fitCampaign(input: CampaignDraft, people: PlannerPerson[], fos: PlannerFo[], options: { reshapeOutreach: boolean; allowTrim?: boolean; ceiling?: (target: number) => number }): CampaignFit | null {
  const trims = options.allowTrim !== false ? [false, true] : [false];
  const dayList = calendarDays(input.startDate, input.endDate);
  if (!dayList.length || !people.length || !input.fos.length) return null;
  const base: CampaignDraft = { ...input, foAssignments: undefined };
  const { roster, issues } = campaignQueues(base, people, fos);
  if (issues.length) return null;
  // Unowned contacts are balanced once, at the requested paces, and stay with that FO.
  const pins: Record<string, string> = {};
  for (const r of roster.values()) for (const p of r.people) if (!p.ownerMemberId) pins[p.id] = r.id;
  const cases: FoCase[] = [...roster.values()].map(r => ({ id: r.id, target: r.batchSize, ceiling: (options.ceiling ?? paceCeiling)(r.batchSize), meta: fos.find(f => f.id === r.id) ?? { id: r.id, name: 'FO', twentyMemberId: null }, queue: r.people }));
  const total = people.length;

  const evaluate = (flows: CampaignDraft['flows'], bound: number, allowTrim: boolean): Candidate | null => {
    const shape = new Shape({ ...base, flows, assignments: flows.length === 1 && flows[0].id === 'default' && options.reshapeOutreach ? {} : base.assignments, foAssignments: pins }, dayList);
    const results: FoResult[] = [];
    for (const c of cases) {
      const r = fitFo(shape, c, allowTrim);
      if (!r) return null;
      results.push(r);
    }
    if (results.every(r => r.kind === 'drop')) return null;
    let excess = 0, left = 0, droppedFos = 0;
    results.forEach((r, i) => {
      if (r.kind === 'drop') { droppedFos++; left += cases[i].queue.length; return; }
      excess = Math.max(excess, (r.batchSize - cases[i].target) / cases[i].target);
      left += cases[i].queue.length - r.kept.length;
    });
    return { score: bound + 10 * Math.max(0, excess) + 10 * left / total + 3 * droppedFos, flows, results };
  };

  let best: Candidate | null = null;
  if (!options.reshapeOutreach) {
    for (const allowTrim of trims) if (!best) best = evaluate(base.flows, 0, allowTrim);
  } else {
    const span = diffDays(input.startDate, input.endDate);
    const combos: { s: number; gap: number; bound: number }[] = [];
    for (let s = 1; s <= Math.min(60, dayList.length); s++) for (const gap of GAPS) {
      if ((s - 1) * gap > span) continue;
      combos.push({ s, gap, bound: stepPenalty(s) + GAPS.indexOf(gap) * 0.05 });
    }
    combos.sort((a, b) => a.bound - b.bound || a.s - b.s);
    for (const allowTrim of trims) {
      let evaluated = 0;
      for (const combo of combos) {
        if (best && combo.bound >= best.score) break;
        if (allowTrim && ++evaluated > 24) break;
        const found = evaluate([{ id: 'default', name: 'Default', steps: outreachRecipe(combo.s, combo.gap) }], combo.bound, allowTrim);
        if (found && (!best || found.score < best.score)) best = found;
      }
      if (best) break;
    }
  }
  if (!best) return null;

  // An FO left off takes only their own contacts with them: unowned contacts balanced onto them
  // are balanced again across the FOs who stay.
  const leftOff = cases.filter((c, i) => best!.results[i].kind === 'drop');
  if (leftOff.some(c => c.queue.some(p => !p.ownerMemberId)) && leftOff.length < cases.length) {
    const owned = new Set(leftOff.flatMap(c => c.queue.filter(p => p.ownerMemberId).map(p => p.id)));
    const again = fitCampaign({ ...input, fos: input.fos.filter(f => !leftOff.some(c => c.id === f.id)), personIds: input.personIds.filter(id => !owned.has(id)) }, people.filter(p => !owned.has(p.id)), fos, options);
    if (again) return { ...again, droppedFos: [...leftOff.map(c => ({ id: c.id, name: c.meta.name, personIds: c.queue.filter(p => p.ownerMemberId).map(p => p.id), reason: c.queue.length ? 'few' as const : 'none' as const })), ...again.droppedFos] };
  }

  const kept: PlannerPerson[] = [], paces: FitPace[] = [], droppedFos: FitDroppedFo[] = [], overflow: string[] = [];
  const fitFos: CampaignDraft['fos'] = [];
  best.results.forEach((r, i) => {
    const c = cases[i];
    if (r.kind === 'drop') { droppedFos.push({ id: c.id, name: c.meta.name, personIds: c.queue.map(p => p.id), reason: c.queue.length ? 'few' : 'none' }); return; }
    kept.push(...r.kept); fitFos.push({ id: c.id, batchSize: r.batchSize });
    paces.push({ foId: c.id, name: c.meta.name, from: c.target, to: r.batchSize });
    overflow.push(...c.queue.slice(r.kept.length).map(p => p.id));
  });
  const keptIds = new Set(kept.map(p => p.id));
  const reshaped = best.flows !== base.flows;
  const draft: CampaignDraft = {
    ...input, flows: best.flows, fos: fitFos,
    personIds: input.personIds.filter(id => keptIds.has(id)),
    assignments: reshaped ? {} : Object.fromEntries(Object.entries(input.assignments).filter(([id]) => keptIds.has(id))),
    foAssignments: Object.fromEntries(Object.entries(pins).filter(([id, fo]) => keptIds.has(id) && fitFos.some(f => f.id === fo))),
  };
  const planned = people.filter(p => keptIds.has(p.id));
  const calendar = buildCampaignCalendar(draft, planned, fos.filter(f => fitFos.some(k => k.id === f.id)), SEARCH_LIMIT * (fitFos.length + 5));
  return calendar.valid ? { draft, calendar, paces, droppedFos, overflow } : null;
}
