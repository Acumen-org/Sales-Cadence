import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/** A calendar date in a person's local timezone, formatted YYYY-MM-DD. */
export type LocalDate = string;

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== 'string' || !LOCAL_DATE_RE.test(value)) return false;
  const d = parseLocalDate(value);
  return !Number.isNaN(d.getTime()) && formatUtcDate(d) === value;
}

/** Interpret a YYYY-MM-DD as a UTC midnight Date, for arithmetic only. */
export function parseLocalDate(date: LocalDate): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatUtcDate(d: Date): LocalDate {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = parseLocalDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return formatUtcDate(d);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return Math.round((parseLocalDate(b).getTime() - parseLocalDate(a).getTime()) / 86_400_000);
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(date: LocalDate): number {
  return parseLocalDate(date).getUTCDay();
}

export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxLocalDate(a: LocalDate, b: LocalDate): LocalDate {
  return a >= b ? a : b;
}

/** Today's calendar date in the given IANA timezone. */
export function todayIn(timezone: string, now: Date = new Date()): LocalDate {
  return toLocalDate(now, timezone);
}

/** Calendar date of an instant in the given timezone. */
export function toLocalDate(instant: Date, timezone: string): LocalDate {
  const parts = dayFormatter(safeTimezone(timezone)).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * One formatter per timezone, made once. Building an Intl.DateTimeFormat costs far more than using
 * one, and a report buckets thousands of instants into days: a fresh one per call is what hung it.
 */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayFormatter(timezone: string): Intl.DateTimeFormat {
  let f = dayFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'gregory', numberingSystem: 'latn' });
    dayFormatters.set(timezone, f);
  }
  return f;
}

/** The instant of `hour`:00 local time on `date` in `timezone`. */
export function localDateToInstant(date: LocalDate, timezone: string, hour = 9): Date {
  const hh = String(hour).padStart(2, '0');
  return fromZonedTime(`${date}T${hh}:00:00`, safeTimezone(timezone));
}

/** Start of the local day as an instant. */
export function startOfLocalDay(date: LocalDate, timezone: string): Date {
  return localDateToInstant(date, timezone, 0);
}

const timezoneChecks = new Map<string, string>();

export function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  const known = timezoneChecks.get(tz);
  if (known) return known;
  let safe = 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    safe = tz;
  } catch {
    safe = 'UTC';
  }
  timezoneChecks.set(tz, safe);
  return safe;
}

/** A datetime-local field represents the user's wall clock, independent of the server clock. */
export function dateTimeInputValue(instant: Date, timezone: string): string {
  return formatInTimeZone(instant, safeTimezone(timezone), "yyyy-MM-dd'T'HH:mm");
}

/** Reject impossible dates and times skipped by a daylight-saving transition. */
export function localDateTimeToInstant(value: string, timezone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  if (!isLocalDate(value.slice(0, 10))) return null;
  const instant = fromZonedTime(value, safeTimezone(timezone));
  if (Number.isNaN(instant.getTime()) || dateTimeInputValue(instant, timezone) !== value) return null;
  return instant;
}

const localDateFormats = new Map<string, Intl.DateTimeFormat>();

export function formatLocalDate(date: LocalDate, style: 'short' | 'long' | 'month' | 'year' = 'short'): string {
  const d = parseLocalDate(date);
  let f = localDateFormats.get(style);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      weekday: style === 'long' ? 'short' : undefined,
      day: style === 'month' ? undefined : 'numeric',
      month: 'short',
      year: style === 'short' ? undefined : 'numeric',
    });
    localDateFormats.set(style, f);
  }
  return f.format(d);
}

export function formatInstant(instant: Date | string | null | undefined, timezone = 'UTC'): string {
  if (!instant) return '';
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const tz = safeTimezone(timezone);
  let f = instantFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    instantFormats.set(tz, f);
  }
  return f.format(d);
}
const instantFormats = new Map<string, Intl.DateTimeFormat>();

/** The Sunday that starts the week containing `date`. Weeks run Sunday to Saturday. */
export function startOfWeekSunday(date: LocalDate): LocalDate {
  return addDays(date, -dayOfWeek(date));
}

export function endOfWeekSaturday(date: LocalDate): LocalDate {
  return addDays(startOfWeekSunday(date), 6);
}

/**
 * This week as instants in the given timezone: [Sunday 00:00, next Sunday 00:00).
 * Used by every "this week" figure so they all agree.
 */
export function weekRange(today: LocalDate, timezone: string): { from: LocalDate; to: LocalDate; fromInstant: Date; toInstant: Date } {
  const from = startOfWeekSunday(today);
  const to = endOfWeekSaturday(today);
  return { from, to, fromInstant: startOfLocalDay(from, timezone), toInstant: startOfLocalDay(addDays(to, 1), timezone) };
}

/** The working week around a date: Monday to Sunday, in the given timezone. */
export function workWeekRange(today: LocalDate, timezone: string): { from: LocalDate; to: LocalDate; fromInstant: Date; toInstant: Date } {
  const from = addDays(today, -((dayOfWeek(today) + 6) % 7));
  const to = addDays(from, 6);
  return { from, to, fromInstant: startOfLocalDay(from, timezone), toInstant: startOfLocalDay(addDays(to, 1), timezone) };
}

export function relativeDays(date: LocalDate, today: LocalDate): string {
  const n = diffDays(today, date);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n < 0) return `${-n} days overdue`;
  return `In ${n} days`;
}
