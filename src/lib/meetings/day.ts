import { isLocalDate, localDateToInstant, toLocalDate, type LocalDate } from '../dates';
import { workspaceTimezone } from '../workspace';

/**
 * A meeting has a day, not a time (owner, 10 October 2026: "I don't want to store time, only
 * date"). The day is kept as midday on the workspace's clock, so it reads as the same date in any
 * timezone the team is in, and every screen, report and the record in Twenty show the day alone.
 */
export function meetingDayInstant(day: LocalDate): Date {
  return localDateToInstant(day, workspaceTimezone(), 12);
}

/** The day a meeting was on. Meetings saved before 10 October 2026 still carry a time; this drops it. */
export function meetingDay(instant: Date): LocalDate {
  return toLocalDate(instant, workspaceTimezone());
}

/** What the form sends: "YYYY-MM-DD", or an older "YYYY-MM-DDTHH:mm" whose date is kept. */
export function parseMeetingDay(value: string): LocalDate | null {
  const day = value.trim().slice(0, 10);
  return isLocalDate(day) ? day : null;
}
