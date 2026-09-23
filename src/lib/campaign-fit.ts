import { diffDays } from './dates';
import { buildCampaignCalendar, calendarDays, campaignQueues, outreachDates, type CampaignCalendar, type CampaignDraft, type PlannerFo, type PlannerPerson } from './campaign-planner';
import { outreachRecipe } from './campaign-starter';

/**
 * The studio's own planning. Dates, FOs and the reachable audience are the owner's; the studio
 * finds everything else and the unchanged scheduler (buildCampaignCalendar) verifies it.
 *
 * - Everyone reachable is planned. Each FO keeps the new people/day they asked for when it works
 *   (balanced: the lowest pace giving the same number of batches); otherwise they get the lowest
 *   pace that works, with no ceiling but the draft's own 500.
 * - An outreach nobody has edited is built here: the most touchpoints (eight is the reference) that
 *   those paces allow. When one shared outreach would push an FO's pace up because another FO has
 *   only a few contacts, that FO's contacts get an outreach of their own instead.
 * - An edited outreach is never changed; when it cannot take everyone the plan says why, per FO.
 * - Only beyond 500 new people a day are the lowest-priority people left out, and only an FO whose
 *   contacts cannot fill the window under any outreach is left off.
 *
 * For one outreach, whether a plan works depends only on how many batches it has, not on who is in
 * them; that is what `Window.canSchedule` caches, on stand-in contacts, for every FO at once.
 */

export type FitPace = { foId: string; name: string; from: number; to: number };
export type FitDroppedFo = { id: string; name: string; personIds: string[]; reason: 'none' | 'few' };
/** Why an edited outreach cannot take an FO's contacts. */
export type FitProblem = { foId: string; name: string; reason: 'window' | 'few' | 'search' };
export type CampaignFit = { draft: CampaignDraft; calendar: CampaignCalendar; paces: FitPace[]; droppedFos: FitDroppedFo[]; overflow: string[] };
export type FitFailure = { problems: FitProblem[] };
/** The start-day count, exposed for its test. */
export const startDaysFor = (startDate: string, endDate: string, steps: Flow['steps']) => new Window(startDate, endDate).startsFor({ id: 'default', name: 'Default', steps });
export const isFit = (r: CampaignFit | FitFailure | null): r is CampaignFit => !!r && 'calendar' in r;

/** The draft schema's own limit on new people a day; the only ceiling. */
export const MAX_PACE = 500;
const GAPS = [4, 3, 2, 5, 7, 1];
/** Breathing room between touchpoints: three or four days reads well, daily only when nothing else fits. */
const GAP_PENALTY: Record<number, number> = { 4: 0, 3: 0.1, 5: 0.2, 2: 0.3, 7: 0.4, 1: 1 };
/** Fewer than eight touchpoints loses reach quickly; more add little and crowd a small audience. */
const stepPenalty = (s: number) => s <= 8 ? 8 / s : 1 + (s - 8) / 4;
const SEARCH_LIMIT = 20000;
/** Batch counts tried per outreach: a shape the studio is weighing, or the owner's own outreach. */
const SHAPE_TRIES = 8, EDITED_TRIES = 40;
/** A safety net only: the search stops on its own bounds long before this many planner searches. */
const SEARCH_BUDGET = 3000;

type Flow = CampaignDraft['flows'][number];
type Run = { flowId: string; length: number };
type FoCase = { id: string; target: number; meta: PlannerFo; queue: PlannerPerson[] };
type PaceResult = { pace: number } | { fail: 'window' | 'few' | 'many' | 'search' };

const flowShape = (f: Flow) => f.steps.map(s => s.day).join(',');

class Window {
  readonly days: string[];
  readonly D: number;
  private starts = new Map<string, number>();
  private feasible = new Map<string, boolean>();
  private gaveUp = new Map<string, number>();
  /** Planner searches run so far: the fitter's budget is counted, never timed, so it is deterministic. */
  searches = 0;
  constructor(readonly startDate: string, readonly endDate: string) { this.days = calendarDays(startDate, endDate); this.D = this.days.length; }
  /**
   * Working days from which this outreach still finishes by the end date. Every step's date moves
   * forward with its start (the weekend rules never move one back past its predecessor), so those
   * days are the first n of the window and a binary search finds n.
   */
  startsFor(f: Flow) {
    const key = flowShape(f);
    let n = this.starts.get(key);
    if (n === undefined) {
      const fits = (i: number) => { const dates = outreachDates(this.days[i], f.steps); return !!dates && dates.at(-1)! <= this.endDate; };
      let lo = 0, hi = this.D;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid + 1; else hi = mid; }
      n = lo;
      this.starts.set(key, n);
    }
    return n;
  }
  /** Whether `count` batches on one outreach cover every working day: the planner's own search, on stand-in contacts. */
  canSchedule(f: Flow, count: number) {
    const shape = flowShape(f), key = `${shape}|${count}`;
    let ok = this.feasible.get(key);
    if (ok === undefined) {
      // A long window can outrun the planner's search; after two such searches on one outreach,
      // the fitter moves on to an outreach the planner settles quickly.
      if ((this.gaveUp.get(shape) ?? 0) >= 2) return false;
      const people = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, name: `s${String(i).padStart(5, '0')}`, ownerMemberId: 'fit', tags: [], contactType: [], tier: null }));
      const draft: CampaignDraft = { name: 'fit', podId: 'fit', startDate: this.startDate, endDate: this.endDate, productInterest: ['fit'], defaultBatchSize: 1, fos: [{ id: 'fit', batchSize: 1 }], personIds: people.map(p => p.id), assignments: {}, flows: [{ ...f, id: 'default', name: 'Default' }] };
      this.searches++;
      const calendar = buildCampaignCalendar(draft, people, [{ id: 'fit', name: 'fit', twentyMemberId: 'fit' }], SEARCH_LIMIT);
      ok = calendar.valid;
      if (calendar.exhausted) this.gaveUp.set(shape, (this.gaveUp.get(shape) ?? 0) + 1);
      this.feasible.set(key, ok);
    }
    return ok;
  }
}

function runsOf(queue: PlannerPerson[], assignments: Record<string, string>, take = queue.length) {
  const runs: Run[] = [];
  for (const p of queue.slice(0, take)) {
    const flowId = assignments[p.id] ?? 'default';
    const last = runs.at(-1);
    if (last && last.flowId === flowId) last.length++; else runs.push({ flowId, length: 1 });
  }
  return runs;
}

/** Batches and touchpoints of a queue at one pace; batches break where the outreach changes. */
function measure(w: Window, flows: Map<string, Flow>, runs: Run[], pace: number) {
  let count = 0, touches = 0, startsOk = true;
  const perFlow = new Map<string, number>();
  for (const r of runs) {
    const n = Math.ceil(r.length / pace);
    count += n; touches += n * flows.get(r.flowId)!.steps.length;
    perFlow.set(r.flowId, (perFlow.get(r.flowId) ?? 0) + n);
  }
  for (const [id, n] of perFlow) if (n > w.startsFor(flows.get(id)!)) startsOk = false;
  // Only the first batch touches the first working day, so a covered window holds at most 2D - 1.
  return { count, touches, crowded: !startsOk || count > w.D || touches > 2 * w.D - 1, sparse: touches < w.D };
}

/**
 * The pace for one FO's queue: at or under the request, the highest balanced pace that works
 * (fewest batches, so the calmest days); above it, the lowest that works. Same batch count, same
 * schedule, so each count is tried once, at the lowest pace that produces it.
 */
function choosePace(w: Window, flows: Map<string, Flow>, runs: Run[], target: number, schedule: (pace: number, count: number) => boolean, maxTries: number): PaceResult {
  if ([...new Set(runs.map(r => r.flowId))].some(id => w.startsFor(flows.get(id)!) === 0)) return { fail: 'window' };
  const top = Math.min(MAX_PACE, Math.max(...runs.map(r => r.length)));
  const lowest = new Map<number, number>();
  for (let b = 1; b <= top; b++) { const c = measure(w, flows, runs, b).count; if (!lowest.has(c)) lowest.set(c, b); }
  const at = measure(w, flows, runs, Math.min(target, top)).count;
  const counts = [...lowest.keys()];
  const order = [...counts.filter(c => c >= at).sort((a, b) => a - b), ...counts.filter(c => c < at).sort((a, b) => b - a)];
  let tries = 0;
  for (const c of order) {
    const pace = lowest.get(c)!;
    const m = measure(w, flows, runs, pace);
    if (m.crowded || m.sparse) continue;
    if (++tries > maxTries) break;
    if (schedule(pace, c)) return { pace };
  }
  if (measure(w, flows, runs, 1).sparse) return { fail: 'few' };
  if (measure(w, flows, runs, top).crowded) return { fail: 'many' };
  return { fail: 'search' };
}

function subDraft(input: CampaignDraft, c: FoCase, kept: PlannerPerson[], pace: number): CampaignDraft {
  const ids = new Set(kept.map(p => p.id));
  return { ...input, fos: [{ id: c.id, batchSize: pace }], personIds: kept.map(p => p.id), assignments: Object.fromEntries(Object.entries(input.assignments).filter(([id]) => ids.has(id))), foAssignments: Object.fromEntries(kept.filter(p => !p.ownerMemberId).map(p => [p.id, c.id])) };
}

/** An edited outreach: the pace per FO, checked by the planner on the real queue when it mixes outreach groups. */
function fitEdited(w: Window, input: CampaignDraft, c: FoCase, kept: PlannerPerson[]): PaceResult {
  const flows = new Map(input.flows.map(f => [f.id, f]));
  const runs = runsOf(kept, input.assignments);
  const tried = new Map<number, boolean>();
  const schedule = (pace: number, count: number) => {
    if (runs.length === 1) return w.canSchedule(flows.get(runs[0].flowId)!, count);
    let ok = tried.get(count);
    if (ok === undefined) { ok = buildCampaignCalendar(subDraft(input, c, kept, pace), kept, [c.meta], SEARCH_LIMIT).valid; tried.set(count, ok); }
    return ok;
  };
  return choosePace(w, flows, runs, c.target, schedule, EDITED_TRIES);
}

type Choice = { flow: Flow; q: number; s: number };
type Evaluation = { pace: number; excess: number } | null;

export function fitCampaign(input: CampaignDraft, people: PlannerPerson[], fos: PlannerFo[], options: { reshapeOutreach: boolean; allowTrim?: boolean }): CampaignFit | FitFailure | null {
  const w = new Window(input.startDate, input.endDate);
  if (!w.D || !people.length || !input.fos.length) return null;
  const base: CampaignDraft = { ...input, foAssignments: undefined };
  const { roster, issues } = campaignQueues(base, people, fos);
  if (issues.length) return null;
  // Unowned contacts are balanced once, at the requested paces, and stay with that FO.
  const pins: Record<string, string> = {};
  for (const r of roster.values()) for (const p of r.people) if (!p.ownerMemberId) pins[p.id] = r.id;
  const meta = (id: string) => fos.find(f => f.id === id) ?? { id, name: 'FO', twentyMemberId: null };
  const cases: FoCase[] = [...roster.values()].map(r => ({ id: r.id, target: r.batchSize, meta: meta(r.id), queue: r.people }));
  const allowTrim = options.allowTrim !== false;
  const overflow: string[] = [];
  const droppedFos: FitDroppedFo[] = cases.filter(c => !c.queue.length).map(c => ({ id: c.id, name: c.meta.name, personIds: [], reason: 'none' as const }));
  const live = cases.filter(c => c.queue.length);
  if (!live.length) return null;
  const paces = new Map<string, number>();
  const kept = new Map<string, PlannerPerson[]>();
  let flows: Flow[] = input.flows;
  let assignments: Record<string, string> = input.assignments;

  if (!options.reshapeOutreach) {
    const problems: FitProblem[] = [];
    for (const c of live) {
      let queue = c.queue;
      let r = fitEdited(w, input, c, queue);
      if ('fail' in r && r.fail === 'many' && allowTrim) {
        // More than 500 a day would have to start: keep the highest-priority contacts that fit.
        const flowMap = new Map(input.flows.map(f => [f.id, f]));
        let lo = 1, hi = queue.length - 1, most = 0;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (!measure(w, flowMap, runsOf(queue, input.assignments, mid), MAX_PACE).crowded) { most = mid; lo = mid + 1; } else hi = mid - 1; }
        for (let k = most, n = 0; k >= 1 && n < 8; k -= MAX_PACE, n++) {
          const trimmed = fitEdited(w, input, c, queue.slice(0, k));
          if (!('fail' in trimmed)) { overflow.push(...queue.slice(k).map(p => p.id)); queue = queue.slice(0, k); r = trimmed; break; }
        }
      }
      if ('fail' in r) { problems.push({ foId: c.id, name: c.meta.name, reason: r.fail === 'many' ? 'search' : r.fail }); continue; }
      paces.set(c.id, r.pace); kept.set(c.id, queue);
    }
    if (problems.length) return { problems };
  } else {
    // 500 new people every working day is the most any outreach can start.
    for (const c of live) if (c.queue.length > MAX_PACE * w.D) {
      if (!allowTrim) return null;
      overflow.push(...c.queue.slice(MAX_PACE * w.D).map(p => p.id));
      c.queue = c.queue.slice(0, MAX_PACE * w.D);
    }
    const span = diffDays(input.startDate, input.endDate);
    const seen = new Set<string>();
    const choices: Choice[] = [];
    for (let s = 1; s <= Math.min(60, w.D); s++) for (const gap of GAPS) {
      if ((s - 1) * gap > span) continue;
      const flow: Flow = { id: 'default', name: 'Default', steps: outreachRecipe(s, gap) };
      if (seen.has(flowShape(flow)) || !w.startsFor(flow)) continue;
      seen.add(flowShape(flow));
      choices.push({ flow, s, q: stepPenalty(s) + (s > 1 ? GAP_PENALTY[gap] : 0) });
    }
    choices.sort((a, b) => a.q - b.q || a.s - b.s);
    const cache = new Map<string, Evaluation>();
    const one = (c: FoCase, i: number): Evaluation => {
      const key = `${c.id}|${i}`;
      if (!cache.has(key)) {
        const ch = choices[i];
        const r = choosePace(w, new Map([['default', ch.flow]]), [{ flowId: 'default', length: c.queue.length }], c.target, (_pace, count) => w.canSchedule(ch.flow, count), SHAPE_TRIES);
        cache.set(key, 'fail' in r ? null : { pace: r.pace, excess: Math.max(0, r.pace - c.target) / c.target });
      }
      return cache.get(key)!;
    };
    // The lowest pace an outreach could need: no FO starts more batches than there are start days
    // or room for touchpoints. It orders the search, so the search can stop exactly when nothing
    // untried could do better.
    const floorPace = (c: FoCase, ch: Choice) => {
      if (c.queue.length * ch.s < w.D) return Infinity;
      const most = Math.min(w.D, w.startsFor(ch.flow), Math.floor((2 * w.D - 1) / ch.s), c.queue.length);
      return most < 1 ? Infinity : Math.ceil(c.queue.length / most);
    };
    const floorExcess = (c: FoCase, ch: Choice) => Math.max(0, floorPace(c, ch) - c.target) / c.target;
    const spent = () => w.searches > SEARCH_BUDGET;
    const indexes = choices.map((_, i) => i);
    // An FO whose contacts could not fill every working day even at sixty touchpoints each is not searched.
    const servable = (c: FoCase) => c.queue.length * Math.min(60, w.D) >= w.D;
    // Each FO on their own: the lowest excess any outreach gives them, then the best outreach at it.
    const alone = new Map<string, { i: number; excess: number; pace: number }>();
    for (const c of live.filter(servable)) {
      let best: { i: number; excess: number; pace: number } | null = null;
      for (const i of [...indexes].sort((a, b) => floorExcess(c, choices[a]) - floorExcess(c, choices[b]) || choices[a].q - choices[b].q)) {
        if (floorExcess(c, choices[i]) === Infinity) break;
        if (best && (floorExcess(c, choices[i]) > best.excess || (best.excess === 0 && choices[i].q >= choices[best.i].q) || spent())) break;
        const e = one(c, i);
        if (e && (!best || e.excess < best.excess || (e.excess === best.excess && choices[i].q < choices[best.i].q))) best = { i, ...e };
      }
      if (best) alone.set(c.id, best);
    }
    // Within 10% of an FO's lowest pace (or at the request), the outreach with more touchpoints.
    const allowance = (c: FoCase) => { const b = alone.get(c.id)!; return b.excess === 0 ? c.target : Math.max(c.target, Math.floor(b.pace * 1.1)); };
    const roomy = (c: FoCase) => {
      const b = alone.get(c.id)!, allow = allowance(c);
      for (const i of [...indexes].sort((x, y) => choices[x].q - choices[y].q)) {
        if (choices[i].q >= choices[b.i].q || spent()) break;
        if (floorPace(c, choices[i]) > allow) continue;
        const e = one(c, i);
        if (e && e.pace <= allow) return { i, ...e };
      }
      return b;
    };
    // An FO no outreach can serve (too few contacts for the window) is left off; their unowned
    // contacts are balanced again across the FOs who stay.
    const unserved = live.filter(c => !alone.has(c.id));
    if (unserved.length) {
      if (unserved.length === live.length) return null;
      const owned = new Set(unserved.flatMap(c => c.queue.filter(p => p.ownerMemberId).map(p => p.id)));
      const again = fitCampaign({ ...input, fos: input.fos.filter(f => !unserved.some(c => c.id === f.id)), personIds: input.personIds.filter(id => !owned.has(id)) }, people.filter(p => !owned.has(p.id)), fos, options);
      if (!isFit(again)) return again;
      return { ...again, overflow: [...overflow, ...again.overflow], droppedFos: [...droppedFos, ...unserved.map(c => ({ id: c.id, name: c.meta.name, personIds: c.queue.filter(p => p.ownerMemberId).map(p => p.id), reason: 'few' as const })), ...again.droppedFos.filter(d => !droppedFos.some(x => x.id === d.id))] };
    }
    // Everyone on one outreach: the lowest worst excess, then the least excess overall, then the best outreach.
    type Shared = { i: number; worst: number; total: number; paces: number[] };
    const together = (i: number): Shared | null => {
      const es = live.map(c => one(c, i));
      if (!es.every(Boolean)) return null;
      return { i, worst: Math.max(...es.map(e => e!.excess)), total: es.reduce((n: number, e) => n + e!.excess, 0), paces: es.map(e => e!.pace) };
    };
    const worstFloor = (i: number) => Math.max(...live.map(c => floorExcess(c, choices[i])));
    let star: Shared | null = null;
    for (const i of [...indexes].sort((a, b) => worstFloor(a) - worstFloor(b) || choices[a].q - choices[b].q)) {
      if (worstFloor(i) === Infinity || spent() || (star && (worstFloor(i) > star.worst || (star.worst === 0 && choices[i].q >= choices[star.i].q)))) break;
      const t = together(i);
      if (t && (!star || t.worst < star.worst || (t.worst === star.worst && (t.total < star.total || (t.total === star.total && choices[i].q < choices[star.i].q))))) star = t;
    }
    // When paces must rise, a pace within 10% of the lowest is as good as the lowest and the outreach
    // with more touchpoints wins: 11 a day with two touchpoints over 10 a day with one.
    let shared = star;
    if (star && star.worst > 0) {
      const allow = live.map((c, k) => Math.max(c.target, Math.floor(star!.paces[k] * 1.1)));
      for (const i of [...indexes].sort((a, b) => choices[a].q - choices[b].q)) {
        if (choices[i].q >= choices[star.i].q || spent()) break;
        if (live.some((c, k) => floorPace(c, choices[i]) > allow[k])) continue;
        const t = together(i);
        if (t && t.paces.every((pace, k) => pace <= allow[k])) { shared = t; break; }
      }
    }
    const splitWorst = Math.max(...live.map(c => alone.get(c.id)!.excess));
    if (shared && star!.worst <= splitWorst + 1e-9) {
      flows = [choices[shared.i].flow]; assignments = {};
      live.forEach((c, k) => { paces.set(c.id, shared!.paces[k]); kept.set(c.id, c.queue); });
    } else {
      // One outreach cannot serve everyone at their lowest pace: the FO with most contacts sets
      // Default, and an FO it would slow down gets an outreach of their own.
      const lead = [...live].sort((a, b) => b.queue.length - a.queue.length || a.id.localeCompare(b.id))[0];
      const main = roomy(lead).i;
      flows = [choices[main].flow]; assignments = {};
      for (const c of live) {
        const onMain = one(c, main);
        kept.set(c.id, c.queue);
        if (onMain && onMain.pace <= allowance(c)) { paces.set(c.id, onMain.pace); continue; }
        const own = roomy(c);
        const id = `fo-${c.id}`;
        flows.push({ ...choices[own.i].flow, id, name: `For ${c.meta.name}`.slice(0, 80) });
        for (const p of c.queue) assignments[p.id] = id;
        paces.set(c.id, own.pace);
      }
    }
  }

  const planned = live.filter(c => kept.has(c.id));
  const keptIds = new Set(planned.flatMap(c => kept.get(c.id)!.map(p => p.id)));
  const fitFos = planned.map(c => ({ id: c.id, batchSize: paces.get(c.id)! }));
  const draft: CampaignDraft = {
    ...input, flows, fos: fitFos,
    personIds: input.personIds.filter(id => keptIds.has(id)),
    assignments: Object.fromEntries(Object.entries(assignments).filter(([id]) => keptIds.has(id))),
    foAssignments: Object.fromEntries(Object.entries(pins).filter(([id, fo]) => keptIds.has(id) && fitFos.some(f => f.id === fo))),
  };
  const calendar = buildCampaignCalendar(draft, people.filter(p => keptIds.has(p.id)), fos.filter(f => fitFos.some(k => k.id === f.id)), SEARCH_LIMIT * (fitFos.length + 5));
  if (!calendar.valid) return null;
  return { draft, calendar, paces: planned.map(c => ({ foId: c.id, name: c.meta.name, from: c.target, to: paces.get(c.id)! })), droppedFos, overflow };
}
