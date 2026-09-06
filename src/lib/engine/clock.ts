import { addDays, dayOfWeek, diffDays, type LocalDate } from '../dates';

export type ClockMode = 'shift' | 'hold';

export function isWorkingDay(date: LocalDate, workingDays: number[]): boolean {
  return workingDays.includes(dayOfWeek(date));
}

/** `date` itself if it is a working day, otherwise the next working day. */
export function nextWorkingDay(date: LocalDate, workingDays: number[]): LocalDate {
  if (!workingDays.length) return date;
  let d = date;
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(d, workingDays)) return d;
    d = addDays(d, 1);
  }
  return d;
}

/** The working day strictly after `date`. */
export function followingWorkingDay(date: LocalDate, workingDays: number[]): LocalDate {
  return nextWorkingDay(addDays(date, 1), workingDays);
}

/**
 * Planned date of a step: enrollment start + (day - 1) + accumulated shift, rolled forward
 * to a working day. Day 1 is the start date itself.
 */
export function plannedDateForStep(startDate: LocalDate, stepDay: number, shiftDays: number, workingDays: number[]): LocalDate {
  const raw = addDays(startDate, Math.max(0, stepDay - 1) + Math.max(0, shiftDays));
  return nextWorkingDay(raw, workingDays);
}

/** Calendar days a step finished after its planned date (never negative). */
export function lateDelayDays(plannedDate: LocalDate, completedOn: LocalDate): number {
  return Math.max(0, diffDays(plannedDate, completedOn));
}

/**
 * Rule 2: per-person clocks. In `shift` mode a late step pushes every later,
 * not-yet-generated step by the same delay. In `hold` mode the plan stands.
 */
export function shiftAfterStep(currentShift: number, plannedDate: LocalDate, completedOn: LocalDate, mode: ClockMode): number {
  if (mode === 'hold') return currentShift;
  return currentShift + lateDelayDays(plannedDate, completedOn);
}

/** Whether a not-yet-generated step should be generated today (hold mode generates when due). */
export function shouldGenerateNow(params: { previousStepDone: boolean; plannedDate: LocalDate; today: LocalDate; mode: ClockMode; isFirstStep: boolean }): boolean {
  if (params.isFirstStep) return true;
  if (params.previousStepDone) return true;
  if (params.mode === 'hold') return params.plannedDate <= params.today;
  return false;
}
