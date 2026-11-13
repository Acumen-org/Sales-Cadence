import { addDays, formatLocalDate, todayIn } from '../dates';

/**
 * How a call's time and length read wherever a call is named: the waiting forms, the form's header and
 * the Call button's block (N096). A time alone was ambiguous overnight and across zones, so each
 * carries its day and its zone: "today 14:05 CT", "yesterday 20:20 CT", "3 Nov 09:12 GMT".
 */

/** How a Call blocked by a waiting form begins, so the button can offer to open it (B089). */
export const FORM_FIRST = 'Fill in the form for your';
/** Opens the first waiting form from anywhere on the page: the Call button's "Fill it in" (B089). */
export const OPEN_FORM_EVENT = 'cadence:open-call-form';

/** US zones by their everyday letters; anything else as Intl names it (GMT, BST, CET). */
const PLAIN_ZONE: Record<string, string> = { EST: 'ET', EDT: 'ET', CST: 'CT', CDT: 'CT', MST: 'MT', MDT: 'MT', PST: 'PT', PDT: 'PT' };

const zoneName = (at: Date, tz: string) => {
  const raw = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? tz;
  return PLAIN_ZONE[raw] ?? raw;
};

export function callTimeWords(at: Date, timezone: string, now = new Date()): string {
  const day = todayIn(timezone, at);
  const today = todayIn(timezone, now);
  const dayWords = day === today ? 'today' : day === addDays(today, -1) ? 'yesterday' : formatLocalDate(day);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  return `${dayWords} ${time} ${zoneName(at, timezone)}`;
}

/** The instant a wall-clock day and HH:MM mean in a zone: a meeting's start, a call logged by hand. */
export function zonedInstant(day: string, time: string, timezone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const guess = new Date(`${day}T${time}:00Z`).getTime();
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
  const offsetAt = (at: number) => {
    const shown = fmt.formatToParts(new Date(at));
    const get = (t: string) => Number(shown.find((p) => p.type === t)?.value ?? 0);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute')) - at;
  };
  // M34: the zone's offset is taken again at the answer, so a time just after a clock change is not an hour out.
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

/** "3m 12s", "45s"; null when nobody talked. */
export function talkWords(sec: number | null | undefined): string | null {
  if (!sec) return null;
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
