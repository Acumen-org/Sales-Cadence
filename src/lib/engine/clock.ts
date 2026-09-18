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
 * Step days count calendar days: "three days after the call" includes the weekend. A step that
 * lands on a day nobody works rolls forward to the next working day, so work never falls on a
 * Saturday but the wait is never silently stretched by the week's shape either. Shifts remain
 * elapsed calendar days so lateness is preserved.
 */
export function plannedDateForStep(startDate: LocalDate, stepDay: number, shiftDays: number, workingDays: number[]): LocalDate {
  return nextWorkingDay(addDays(startDate, Math.max(0, stepDay - 1) + Math.max(0, shiftDays)), workingDays);
}

/**
 * Business day `d` (Monday = 1) as a calendar day, for plans written before 18 September 2026:
 * every complete working week adds its weekend. Day 6 was the following Monday - calendar day 8.
 */
export function businessDayToCalendar(day: number): number {
  return day + 2 * Math.floor((day - 1) / 5);
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
