import { z } from 'zod';
import { addDays, diffDays, isLocalDate } from './dates';
import { StepsSchema, type SequenceStep } from './sequences/steps';

const date = z.string().refine(isLocalDate, 'Choose a valid date.');
export const CampaignDraftSchema = z.object({
  name: z.string().trim().min(1, 'Name your campaign.').max(120),
  podId: z.string().min(1), startDate: date, endDate: date,
  productInterest: z.array(z.string().min(1)).min(1, 'Choose a product.'),
  defaultBatchSize: z.number().int().min(1).max(500),
  fos: z.array(z.object({ id: z.string().min(1), batchSize: z.number().int().min(1).max(500) })).min(1, 'Select at least one FO.'),
  flows: z.array(z.object({ id: z.string().min(1), name: z.string().trim().min(1, 'Name each outreach group before continuing.').max(80), steps: StepsSchema })).min(1).max(30),
  personIds: z.array(z.string().min(1)).max(10000),
  assignments: z.record(z.string(), z.string()),
  /** Which FO runs an unowned contact, as the fitter balanced it. Owned contacts ignore it. */
  foAssignments: z.record(z.string(), z.string()).optional(),
  /** Set once someone edits the outreach; until then the studio may reshape the starter. */
  outreachEdited: z.boolean().optional(),
}).superRefine((d, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (d.endDate < d.startDate || diffDays(d.startDate, d.endDate) > 366) issue('Choose a campaign window of up to one year.');
  if (new Set(d.personIds).size !== d.personIds.length) issue('A person can only appear once.');
  if (new Set(d.fos.map(f => f.id)).size !== d.fos.length) issue('Choose each FO once.');
  const flowIds = new Set(d.flows.map(f => f.id));
  if (flowIds.size !== d.flows.length || d.flows[0].id !== 'default') issue('The campaign needs one Default outreach flow.');
  for (const f of d.flows) if (f.steps[0].day !== 1 || f.steps.length > 60 || f.steps.at(-1)!.day > 367 || f.steps.some(s => s.actions.length > 4)) issue('Outreach must start on day 1, with at most 60 steps and four activities per step.');
  if (Object.entries(d.assignments).some(([id, flow]) => !d.personIds.includes(id) || !flowIds.has(flow))) issue('Every outreach assignment must belong to a selected person and this campaign.');
});
export type CampaignDraft = z.infer<typeof CampaignDraftSchema>;
/**
 * Until someone edits the outreach the studio builds it. Without the flag (a draft from before it
 * existed), only an unsaved draft still holding the untouched starter counts as automatic, so no
 * one's own steps or outreach groups are ever rebuilt away.
 */
export const outreachIsAutomatic = (d: Pick<CampaignDraft, 'outreachEdited' | 'flows'>, campaignId?: string) =>
  d.outreachEdited === false || (d.outreachEdited === undefined && !campaignId && d.flows.length === 1 && d.flows[0].steps.every(s => s.id.startsWith('starter-')));
/** What a draft needs to be kept: a name, a pod and two dates. Everything else is checked when it is planned. */
export const CampaignDraftSaveSchema = z.object({
  name: z.string().trim().min(1, 'Name your campaign.').max(120),
  podId: z.string().min(1), startDate: date, endDate: date,
  productInterest: z.array(z.string().min(1)).max(20),
  defaultBatchSize: z.number().int().min(0).max(500),
  fos: z.array(z.object({ id: z.string().min(1), batchSize: z.number().int().min(0).max(500) })).max(100),
  flows: z.array(z.object({ id: z.string().min(1), name: z.string().max(80), steps: StepsSchema })).min(1).max(30),
  personIds: z.array(z.string().min(1)).max(10000),
  assignments: z.record(z.string(), z.string()),
  foAssignments: z.record(z.string(), z.string()).optional(),
  outreachEdited: z.boolean().optional(),
});
export type PlannerPerson = { id: string; name: string; ownerMemberId: string | null; tags: string[]; contactType: string[]; tier: string | null };
export type PlannerFo = { id: string; name: string; twentyMemberId: string | null };
export type PlannedBatch = { id: string; foId: string; flowId: string; personIds: string[]; dates: string[]; priority: number };
export type PlanIssue = { title: string; detail: string; foId?: string; date?: string };
export type CampaignCalendar = { version: 1; days: string[]; batches: PlannedBatch[]; people: PlannerPerson[]; fos: PlannerFo[]; issues: PlanIssue[]; valid: boolean; exhausted: boolean };
export const PRIORITY_LABELS = ['Clients', 'MIP', 'Tier 1', 'Tier 2', 'Tier 3', 'Unclassified'];
const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export function contactPriority(p: Pick<PlannerPerson, 'tags' | 'contactType' | 'tier'>) {
  const labels = [...p.tags, ...p.contactType].map(normal);
  if (labels.some(t => ['client', 'clients'].includes(t))) return 0;
  if (labels.includes('mip')) return 1;
  const tiers = [normal(p.tier ?? ''), ...labels];
  return tiers.some(t => ['1', 'tier1', 'level1'].includes(t)) ? 2 : tiers.some(t => ['2', 'tier2', 'level2'].includes(t)) ? 3 : tiers.some(t => ['3', 'tier3', 'level3'].includes(t)) ? 4 : 5;
}
const CLIENT_LABELS = ['client', 'clients'];
const TIER_LABELS = [['1', 'tier1', 'level1'], ['2', 'tier2', 'level2'], ['3', 'tier3', 'level3']];
/** Every priority group a contact belongs to; contactPriority is the highest of them. */
export function priorityGroups(p: Pick<PlannerPerson, 'tags' | 'contactType' | 'tier'>) {
  const labels = [...p.tags, ...p.contactType].map(normal);
  const tiers = [normal(p.tier ?? ''), ...labels];
  const groups: number[] = [];
  if (labels.some(t => CLIENT_LABELS.includes(t))) groups.push(0);
  if (labels.includes('mip')) groups.push(1);
  TIER_LABELS.forEach((names, i) => { if (tiers.some(t => names.includes(t))) groups.push(2 + i); });
  return groups.length ? groups : [5];
}
/** The groups one CRM value places a contact in: tags and contact types are labels, the tier field only counts for tiers. */
export function valuePriorityGroups(value: string, field: 'tag' | 'contactType' | 'tier') {
  const groups = priorityGroups(field === 'tier' ? { tags: [], contactType: [], tier: value } : { tags: [value], contactType: [], tier: null });
  return groups[0] === 5 ? [] : groups;
}
const weekdays = new Map<string, number>();
export const weekday = (day: string) => { let d = weekdays.get(day); if (d === undefined) { d = new Date(`${day}T12:00:00Z`).getUTCDay(); weekdays.set(day, d); } return d; };
export const workingDay = (day: string) => ![0, 6].includes(weekday(day));
export function calendarDays(start: string, end: string) {
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) if (workingDay(d)) days.push(d);
  return days;
}
// Pure and asked for the same start and spacing thousands of times while a plan is fitted; the
// answers are frozen, and nothing may change them.
const journeys = new Map<string, readonly string[] | null>();
export function outreachDates(start: string, steps: SequenceStep[]): string[] | null {
  const key = `${start}|${steps.map(s => s.day).join(',')}`;
  const known = journeys.get(key);
  if (known !== undefined) return known as string[] | null;
  let dates: string[] | null = [start];
  for (let i = 1; i < steps.length; i++) {
    const gap = steps[i].day - steps[i - 1].day;
    let next = addDays(dates[i - 1], gap);
    if (weekday(next) === 6) next = addDays(next, gap === 1 ? 2 : -1);
    else if (weekday(next) === 0) next = addDays(next, 1);
    if (next <= dates[i - 1]) { dates = null; break; }
    dates.push(next);
  }
  if (journeys.size > 200_000) journeys.clear();
  journeys.set(key, dates && Object.freeze(dates));
  return dates;
}
/** "Fri, Sep 25" (or "Sep 25"): the studio's plan wording, within a campaign's own year. */
export function shortDateLabel(day: string, withWeekday = true) {
  return new Intl.DateTimeFormat('en-US', { ...(withWeekday ? { weekday: 'short' as const } : {}), month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
}
export function calendarDateLabel(day: string) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
}

/** Each FO's people in the order they start: owners first, unowned balanced (or as pinned), then priority and outreach. */
export function campaignQueues(draft: CampaignDraft, people: PlannerPerson[], fos: PlannerFo[]) {
  const issues: PlanIssue[] = [];
  const issue = (title: string, detail: string) => issues.push({ title, detail });
  const ordered = [...people].sort((a, b) => contactPriority(a) - contactPriority(b) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id));
  const position = new Map(ordered.map((p, i) => [p.id, i]));
  const roster = new Map(draft.fos.map(f => [f.id, { ...f, people: [] as PlannerPerson[] }]));
  const owner = new Map(fos.filter(f => f.twentyMemberId).map(f => [f.twentyMemberId!, f.id]));
  // Preserve owners first; balance only unowned people using this campaign's audience.
  for (const p of ordered.filter(p => p.ownerMemberId)) {
    const id = owner.get(p.ownerMemberId!);
    if (!id || !roster.has(id)) issue(`${p.name} has an owner outside the selected team.`, 'Select their FO or remove this contact. The planner will not silently reassign an owned relationship.');
    else roster.get(id)!.people.push(p);
  }
  for (const p of ordered.filter(p => !p.ownerMemberId)) {
    const pinned = draft.foAssignments?.[p.id];
    const fo = pinned && roster.has(pinned) ? roster.get(pinned)! : [...roster.values()].sort((a, b) => a.people.length / a.batchSize - b.people.length / b.batchSize || a.id.localeCompare(b.id))[0];
    if (fo) fo.people.push(p);
  }
  // Group equal-priority people by outreach so selecting scattered names does not
  // unnecessarily create many tiny batches. Priority always precedes grouping.
  const flowOrder = new Map(draft.flows.map((f, i) => [f.id, i]));
  for (const fo of roster.values()) fo.people.sort((a, b) => contactPriority(a) - contactPriority(b) || flowOrder.get(draft.assignments[a.id] ?? 'default')! - flowOrder.get(draft.assignments[b.id] ?? 'default')! || position.get(a.id)! - position.get(b.id)!);
  return { roster, issues };
}

export function campaignBatches(draft: CampaignDraft, people: PlannerPerson[], fos: PlannerFo[]) {
  const { roster, issues } = campaignQueues(draft, people, fos);
  if (issues.length) return { batches: [], issues };
  const all: PlannedBatch[] = [];
  for (const fo of roster.values()) {
    const queue = fo.people;
    const batches: PlannedBatch[] = [];
    // Preserve strict priority across different flows; never pull a low-priority person ahead to fill a batch.
    for (const p of queue) {
      const flowId = draft.assignments[p.id] ?? 'default';
      const last = batches.at(-1);
      if (last && last.flowId === flowId && last.personIds.length < fo.batchSize) last.personIds.push(p.id);
      else batches.push({ id: `${fo.id}:${batches.length + 1}`, foId: fo.id, flowId, personIds: [p.id], dates: [], priority: contactPriority(p) });
    }
    all.push(...batches);
  }
  return { batches: all, issues };
}

/** Deterministic bounded constraint search. No access to other campaigns or global workload. */
export function buildCampaignCalendar(draft: CampaignDraft, people: PlannerPerson[], fos: PlannerFo[], nodeLimit = 120000): CampaignCalendar {
  const days = calendarDays(draft.startDate, draft.endDate);
  const result: CampaignCalendar = { version: 1, days, batches: [], people, fos, issues: [], valid: false, exhausted: false };
  const issue = (title: string, detail: string, foId?: string, date?: string) => result.issues.push({ title, detail, foId, date });
  if (!days.length) { issue('There are no working days in this window.', 'Choose a window containing Monday through Friday.'); return result; }
  if (!people.length) { issue('Choose the people you want to reach.', 'The calendar needs an audience before it can reserve batches.'); return result; }
  const grouped = campaignBatches(draft, people, fos);
  if (grouped.issues.length) { result.issues = grouped.issues; return result; }
  let nodes = 0;
  const optionCache = new Map<string, { index: number; dates: string[] }[]>();
  for (const fo of draft.fos) {
    const batches = grouped.batches.filter(b => b.foId === fo.id);
    const name = fos.find(f => f.id === fo.id)?.name ?? 'This FO';
    if (!batches.length) { issue(`${name} has no people assigned.`, 'Assign people to this FO or remove them from the campaign.', fo.id); continue; }
    const slots = new Map(days.map(d => [d, [] as number[]]));
    const totalTouches = batches.reduce((n, b) => n + draft.flows.find(f => f.id === b.flowId)!.steps.length, 0);
    if (totalTouches < days.length || totalTouches > days.length * 2 || batches.length > days.length) {
      issue(`${name} needs a different campaign window or batch size.`, `${totalTouches} batch touchpoints must cover ${days.length} working days with one or two per day. Adjust the audience, batch size or dates.`, fo.id); continue;
    }
    const options = batches.map(b => {
      const cached = optionCache.get(b.flowId);
      if (cached) return cached;
      const options = days.map((start, index) => ({ index, dates: outreachDates(start, draft.flows.find(f => f.id === b.flowId)!.steps) })).filter((o): o is { index: number; dates: string[] } => !!o.dates && o.dates.at(-1)! <= draft.endDate);
      optionCache.set(b.flowId, options);
      return options;
    });
    if (options.some(o => !o.length)) { issue(`${name}’s outreach cannot finish by ${calendarDateLabel(draft.endDate)}.`, 'Shorten the outreach gaps or extend the end date, then review the calendar again.', fo.id, draft.endDate); continue; }
    const suffix = new Array(batches.length + 1).fill(0);
    for (let i = batches.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + draft.flows.find(f => f.id === batches[i].flowId)!.steps.length;
    const failed = new Set<string>();
    const search = (i: number, after: number): boolean => {
      if (++nodes > nodeLimit) { result.exhausted = true; return false; }
      const empty = days.filter(d => slots.get(d)!.length === 0);
      if (i === batches.length) return empty.length === 0;
      if (empty.length > suffix[i]) return false;
      const firstEmpty = empty.length ? days.indexOf(empty[0]) : days.length - 1;
      const key = `${i}/${after}/${days.map(d => slots.get(d)!.join(',')).join(';')}`;
      if (failed.has(key)) return false;
      for (const o of options[i]) {
        if (o.index <= after || o.index > firstEmpty) continue;
        if (o.dates.some((d, step) => { const s = slots.get(d)!; return s.length >= 2 || s.includes(step); })) continue;
        o.dates.forEach((d, step) => slots.get(d)!.push(step)); batches[i].dates = o.dates;
        if (search(i + 1, o.index)) return true;
        o.dates.forEach(d => slots.get(d)!.pop()); batches[i].dates = [];
        if (result.exhausted) return false;
      }
      failed.add(key); return false;
    };
    if (search(0, -1)) result.batches.push(...batches);
    else issue(result.exhausted ? 'This plan needs a smaller search.' : `${name}’s current steps cannot cover every working day.`, result.exhausted ? 'The search limit was reached; this does not mean the plan is impossible. Reduce the window or simplify the outreach groups and try again.' : `No valid arrangement fits ${calendarDateLabel(days[0])} through ${calendarDateLabel(days.at(-1)!)}. Review the suggested adjustments; publishing stays blocked.`, fo.id, days[0]);
  }
  result.valid = !result.issues.length && result.batches.reduce((n, b) => n + b.personIds.length, 0) === people.length;
  return result;
}

export type CalendarSuggestion = { label: string; detail: string; draft: CampaignDraft; calendar: CampaignCalendar };
/** Only show adjustments actually verified by the same scheduler. Never silently change outreach. */
export function suggestCampaignCalendar(d: CampaignDraft, people: PlannerPerson[], fos: PlannerFo[], options: { verify?: (draft: CampaignDraft) => CampaignCalendar | null; paces?: boolean; outreach?: boolean } = {}): CalendarSuggestion[] {
  const out: CalendarSuggestion[] = [];
  const verify = options.verify ?? ((draft: CampaignDraft) => buildCampaignCalendar(draft, people, fos, 6000));
  const tryDraft = (draft: CampaignDraft, label: string, detail: string) => {
    const calendar = verify(draft);
    if (calendar?.valid) out.push({ label, detail, draft, calendar });
  };
  // Small gap edits first, retaining the audience and dates.
  let attempts = 0;
  // An outreach the studio may still reshape has already been tried in every shape; only dates remain.
  for (const flow of options.outreach === false ? [] : d.flows) for (let step = 1; step < flow.steps.length && attempts < 18 && out.length < 3; step++) {
    for (const delta of [-1, 1]) {
      if (flow.steps[step].day - flow.steps[step - 1].day + delta < 1) continue;
      attempts++;
      const draft = structuredClone(d);
      const changed = draft.flows.find(f => f.id === flow.id)!;
      changed.steps = changed.steps.map((s, i) => ({ ...s, day: s.day + (i >= step ? delta : 0) }));
      if (changed.steps.at(-1)!.day > 367) continue;
      { const wait = changed.steps[step].day - changed.steps[step - 1].day; tryDraft(draft, `${d.flows.length > 1 ? `${flow.name}: wait` : 'Wait'} ${wait} day${wait === 1 ? '' : 's'} before step ${step + 1}`, 'Later steps keep their spacing.'); }
    }
  }
  // Dates are the one thing the studio never moves on its own; offer them only when a pacing
  // change alone cannot work.
  for (const delta of options.verify ? [] : [-1, 1, -2, 2, -3, 3, -7, 7]) {
    if (out.length >= 3) break;
    const endDate = addDays(d.endDate, delta);
    if (endDate < d.startDate || diffDays(d.startDate, endDate) > 366) continue;
    tryDraft({ ...d, endDate }, `End on ${calendarDateLabel(endDate)}`, 'Keep your audience, batch sizes and outreach unchanged.');
  }
  for (const factor of options.paces === false ? [] : [0.75, 0.5, 0.25, 1.25, 2]) {
    if (out.length >= 3) break;
    const changed = { ...d, defaultBatchSize: Math.max(1, Math.min(500, Math.round(d.defaultBatchSize * factor))), fos: d.fos.map(f => ({ ...f, batchSize: Math.max(1, Math.min(500, Math.round(f.batchSize * factor))) })) };
    tryDraft(changed, 'Adjust new people per day', changed.fos.map(f => `${fos.find(fo => fo.id === f.id)?.name}: ${f.batchSize}`).join(' · '));
  }
  // Broader recovery when a small edit cannot work. This changes pacing, so never
  // apply automatically; describe it explicitly and retain all authored messages.
  if (!out.length && options.outreach !== false) {
    for (const gap of [2, 3, 1]) {
      const flows = d.flows.map(f => ({ ...f, steps: f.steps.map((s, i) => ({ ...s, day: 1 + i * gap })) }));
      // The studio keeps its dates here; a date change is offered on its own, below.
      for (const delta of options.verify ? [0] : [0, -7, 7, -14, 14]) {
        if (out.length >= 3) break;
        const endDate = addDays(d.endDate, delta);
        if (endDate < d.startDate || diffDays(d.startDate, endDate) > 366 || flows.some(f => f.steps.at(-1)!.day > 367)) continue;
        tryDraft({ ...d, flows, endDate }, `Wait ${gap} day${gap === 1 ? '' : 's'} between every step`, delta ? `Every group, messages unchanged; end on ${calendarDateLabel(endDate)}.` : 'Every group; messages unchanged.');
      }
      if (out.length) break;
    }
  }
  if (!out.length && options.verify) {
    for (const delta of [1, 2, 3, 7, 14]) {
      if (out.length) break;
      const endDate = addDays(d.endDate, delta);
      if (diffDays(d.startDate, endDate) > 366) continue;
      tryDraft({ ...d, endDate }, `End on ${shortDateLabel(endDate)}`, '');
    }
  }
  return out.slice(0, 3);
}
