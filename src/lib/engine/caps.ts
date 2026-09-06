import { addDays, type LocalDate } from '../dates';
import { nextWorkingDay } from './clock';

/** Number of actions already scheduled per local date for one FO. */
export type DayLoad = Map<LocalDate, number>;

export function loadFromRows(rows: Array<{ dueDate: string; snoozedTo: string | null }>): DayLoad {
  const load: DayLoad = new Map();
  for (const r of rows) {
    const d = r.snoozedTo ?? r.dueDate;
    load.set(d, (load.get(d) ?? 0) + 1);
  }
  return load;
}

export function reserve(load: DayLoad, date: LocalDate, n: number) {
  load.set(date, (load.get(date) ?? 0) + n);
}

/**
 * Rule 5: daily caps with roll-forward. Returns the first working day at or after `from`
 * where `needed` more actions fit under `cap`. A step's actions are never split across days;
 * if `needed` alone exceeds the cap, the first working day with nothing scheduled is used.
 */
export function findDateWithCapacity(
  from: LocalDate,
  needed: number,
  cap: number,
  load: DayLoad,
  workingDays: number[],
  maxLookaheadDays = 180,
): LocalDate {
  let d = nextWorkingDay(from, workingDays);
  for (let i = 0; i < maxLookaheadDays; i++) {
    const used = load.get(d) ?? 0;
    if (used + needed <= cap) return d;
    if (needed > cap && used === 0) return d;
    d = nextWorkingDay(addDays(d, 1), workingDays);
  }
  return d;
}
