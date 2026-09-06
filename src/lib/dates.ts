import { fromZonedTime, toZonedTime } from 'date-fns-tz';

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
  const zoned = toZonedTime(instant, safeTimezone(timezone));
  const y = zoned.getFullYear();
  const m = String(zoned.getMonth() + 1).padStart(2, '0');
  const d = String(zoned.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

export function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export function formatLocalDate(date: LocalDate, style: 'short' | 'long' = 'short'): string {
  const d = parseLocalDate(date);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: style === 'long' ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: style === 'long' ? 'numeric' : undefined,
  }).format(d);
}

export function formatInstant(instant: Date | string | null | undefined, timezone = 'UTC'): string {
  if (!instant) return '';
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: safeTimezone(timezone),
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function relativeDays(date: LocalDate, today: LocalDate): string {
  const n = diffDays(today, date);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n < 0) return `${-n} days overdue`;
  return `In ${n} days`;
}
