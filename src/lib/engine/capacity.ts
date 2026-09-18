import { prisma } from '../db';
import { addDays, diffDays, type LocalDate } from '../dates';
import { needsPod } from '../auth/rbac';
import { getSettings } from '../settings';
import { lastDay, parseSteps, type SequenceStep } from '../sequences/steps';
import type { DayLoad } from './caps';
import { effectiveDailyCap } from '../settings';
import { isWorkingDay, nextWorkingDay, plannedDateForStep } from './clock';
import { foLoad } from './tasks';

/**
 * How many people a campaign can take between two dates.
 *
 * The problem the owner described: start twenty people a day and by day three each FO is doing
 * twenty first steps plus the second steps of the people from day one, and so on - the load grows
 * until, near the end date, there is no room left for the people who have not started. So the
 * planner works backwards. The last day anyone may start is the last day from which the whole plan
 * still finishes by the end date. Between the first and that last day, each FO can start a fixed
 * number of people per working day; the number is found by simulating every step of every start
 * onto the FO's calendar, on top of the work they already hold, and taking the largest rate whose
 * worst day still fits under their daily cap. Capacity is that rate times the starting days,
 * summed over the pod's FOs. Nothing here guesses: it is the same clock and the same cap the
 * scheduler uses when the work actually lands.
 */
export type CapacityFo = { id: string; name: string; cap: number; committed: DayLoad };

export type CapacityInput = {
  steps: SequenceStep[];
  /** Days the plan spans; the last step's day when the plan has not said. */
  durationDays: number;
  startDate: LocalDate;
  endDate: LocalDate;
  fos: CapacityFo[];
  workingDays: number[];
  /** A ceiling on starts per FO per day chosen by hand; null lets the cap decide. */
  maxRate?: number | null;
};

export type FoCapacity = { id: string; name: string; rate: number; capacity: number; cap: number; worstDay: LocalDate | null; worstLoad: number };

export type CapacityPlan = {
  startingDays: LocalDate[];
  lastStart: LocalDate | null;
  touchesPerPerson: number;
  perFo: FoCapacity[];
  total: number;
  /** The window is shorter than the plan: nobody can finish in time. */
  tooShort: boolean;
};

/** Working days from `from` up to and including `to`. */
function workingDaysBetween(from: LocalDate, to: LocalDate, workingDays: number[]): LocalDate[] {
  const days: LocalDate[] = [];
  for (let d = nextWorkingDay(from, workingDays); d <= to; d = addDays(d, 1)) if (isWorkingDay(d, workingDays)) days.push(d);
  return days;
}

/** The latest date a person can start and still have every step land on or before `endDate`. */
export function lastStartDate(input: Pick<CapacityInput, 'steps' | 'durationDays' | 'startDate' | 'endDate' | 'workingDays'>): LocalDate | null {
  const span = Math.max(input.durationDays, lastDay(input.steps));
  for (let d = input.endDate; d >= input.startDate; d = addDays(d, -1)) {
    if (!isWorkingDay(d, input.workingDays)) continue;
    if (plannedDateForStep(d, span, 0, input.workingDays) <= input.endDate) return d;
  }
  return null;
}

/** Simulate `rate` starts on every starting day for one FO; the worst day's load against the cap. */
function simulate(rate: number, startingDays: LocalDate[], steps: SequenceStep[], committed: DayLoad, workingDays: number[]): { worstDay: LocalDate | null; worstLoad: number } {
  const load = new Map<LocalDate, number>(committed);
  for (const start of startingDays) {
    for (const step of steps) {
      const due = plannedDateForStep(start, step.day, 0, workingDays);
      load.set(due, (load.get(due) ?? 0) + rate * step.actions.length);
    }
  }
  let worstDay: LocalDate | null = null;
  let worstLoad = 0;
  for (const [day, n] of load) if (n > worstLoad) { worstLoad = n; worstDay = day; }
  return { worstDay, worstLoad };
}

export function planCapacity(input: CapacityInput): CapacityPlan {
  const touchesPerPerson = input.steps.reduce((n, s) => n + s.actions.length, 0);
  const lastStart = lastStartDate(input);
  const startingDays = lastStart ? workingDaysBetween(input.startDate, lastStart, input.workingDays) : [];
  const perFo: FoCapacity[] = input.fos.map((fo) => {
    if (!startingDays.length || touchesPerPerson === 0) return { id: fo.id, name: fo.name, rate: 0, capacity: 0, cap: fo.cap, worstDay: null, worstLoad: 0 };
    // The largest rate whose worst day fits: monotone in the rate, so a binary search finds it.
    let low = 0;
    let high = Math.min(fo.cap, input.maxRate ?? fo.cap);
    let best = simulate(0, startingDays, input.steps, fo.committed, input.workingDays);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const result = simulate(mid, startingDays, input.steps, fo.committed, input.workingDays);
      if (result.worstLoad <= fo.cap) { low = mid; best = result; } else high = mid - 1;
    }
    return { id: fo.id, name: fo.name, rate: low, capacity: low * startingDays.length, cap: fo.cap, worstDay: best.worstDay, worstLoad: best.worstLoad };
  });
  return { startingDays, lastStart, touchesPerPerson, perFo, total: perFo.reduce((n, f) => n + f.capacity, 0), tooShort: lastStart === null };
}

/** The earliest end date at which `audience` people fit, searching a year ahead; null if never. */
export function endDateThatFits(input: CapacityInput, audience: number): LocalDate | null {
  for (let end = input.endDate, i = 0; i < 366; end = addDays(end, 1), i++) {
    if (planCapacity({ ...input, endDate: end }).total >= audience) return end;
  }
  return null;
}

/** Capacity for a real campaign: the plan, the pod's FOs, their caps and the work they already hold. */
export async function planCampaignCapacity(params: { sequenceId: string; podId: string; startDate: LocalDate; endDate: LocalDate; maxRate?: number | null; excludeCampaignId?: string | null }): Promise<(CapacityPlan & { durationDays: number; input: CapacityInput }) | { error: string }> {
  const [sequence, pod, settings] = await Promise.all([
    prisma.sequence.findUnique({ where: { id: params.sequenceId } }),
    prisma.pod.findUnique({ where: { id: params.podId }, include: { users: { include: { user: true } } } }),
    getSettings(),
  ]);
  if (!sequence) return { error: 'Choose a sequence.' };
  if (!pod) return { error: 'Choose a pod.' };
  const steps = parseSteps(sequence.steps);
  const durationDays = sequence.durationDays ?? lastDay(steps);
  if (params.endDate < params.startDate) return { error: 'The end date is before the start date.' };
  const fos = pod.users.map((u) => u.user).filter((u) => u.active && needsPod(u.role));
  const horizon = Math.max(1, diffDays(params.startDate, params.endDate) + 1);
  const committed = await Promise.all(fos.map((fo) => foLoad(prisma, fo.id, params.startDate, horizon + 60)));
  const input: CapacityInput = {
    steps,
    durationDays,
    startDate: params.startDate,
    endDate: params.endDate,
    workingDays: settings.rules.workingDays,
    maxRate: params.maxRate ?? null,
    fos: fos.map((fo, i) => ({ id: fo.id, name: fo.name, cap: effectiveDailyCap(fo, settings.rules), committed: committed[i] })),
  };
  return { ...planCapacity(input), durationDays, input };
}
