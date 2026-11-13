import { prisma } from '../db';
import { todayIn } from '../dates';
import { zonedInstant } from './words';

/**
 * When a call may be made (owner, 13 Nov 2026; audit M02, M03): only from 8am to 9pm in the
 * contact's own time zone, at most 2 call attempts per person per calendar day (the contact's day),
 * and in a two-party-consent state the rep reads a short recording notice first. Where the contact
 * is not known, the firm's state is used, else US Eastern time, and the rep is told so. A state that
 * spans two zones must be inside the hours in both.
 */

export const CALL_HOURS = { start: 8, end: 21 } as const;
export const MAX_CALL_ATTEMPTS_PER_DAY = 2;
const EASTERN = 'America/New_York';

const ET = 'America/New_York', CT = 'America/Chicago', MT = 'America/Denver', PT = 'America/Los_Angeles';
const STATE_ZONES: Record<string, string[]> = {
  AL: [CT], AK: ['America/Anchorage', 'America/Adak'], AZ: ['America/Phoenix'], AR: [CT], CA: [PT], CO: [MT], CT: [ET], DE: [ET], DC: [ET],
  FL: [ET, CT], GA: [ET], HI: ['Pacific/Honolulu'], ID: [MT, PT], IL: [CT], IN: [ET, CT], IA: [CT], KS: [CT, MT], KY: [ET, CT], LA: [CT],
  ME: [ET], MD: [ET], MA: [ET], MI: [ET, CT], MN: [CT], MS: [CT], MO: [CT], MT: [MT], NE: [CT, MT], NV: [PT], NH: [ET], NJ: [ET], NM: [MT],
  NY: [ET], NC: [ET], ND: [CT, MT], OH: [ET], OK: [CT], OR: [PT, MT], PA: [ET], RI: [ET], SC: [ET], SD: [CT, MT], TN: [CT, ET], TX: [CT, MT],
  UT: [MT], VT: [ET], VA: [ET], WA: [PT], WV: [ET], WI: [CT], WY: [MT], PR: ['America/Puerto_Rico'], GU: ['Pacific/Guam'], VI: ['America/St_Thomas'],
};
const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME',
  maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR', guam: 'GU',
};
/** States where every party to a call must agree to its recording. */
export const TWO_PARTY_CONSENT_STATES = new Set(['CA', 'CT', 'DE', 'FL', 'IL', 'MD', 'MA', 'MI', 'MT', 'NV', 'NH', 'PA', 'WA']);

/** A US state as its two-letter code, from "IL", "Illinois" or a CRM city like "Chicago, IL". */
export function stateCode(raw: string | null | undefined): string | null {
  const v = raw?.split(',').pop()?.trim().replace(/\.$/, '') ?? '';
  if (!v) return null;
  const up = v.toUpperCase();
  if (STATE_ZONES[up]) return up;
  return STATE_NAMES[v.toLowerCase()] ?? null;
}

const isUs = (country: string | null | undefined) => !country || /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/i.test(country.trim());

export type CallPlace = { zones: string[]; state: string | null; abroad: boolean; /** Why the zone is a guess, said to the rep. */ guessed: string | null };

/** The contact's time zone(s): their own state, else the firm's state, else US Eastern (said so). */
export function callPlace(contact: { state?: string | null; country?: string | null }, firm: { state?: string | null; country?: string | null } = {}): CallPlace {
  const own = isUs(contact.country) ? stateCode(contact.state) : null;
  const abroad = !isUs(contact.country);
  if (own) return { zones: STATE_ZONES[own], state: own, abroad, guessed: null };
  const firmState = isUs(firm.country) ? stateCode(firm.state) : null;
  if (firmState) return { zones: STATE_ZONES[firmState], state: firmState, abroad, guessed: `Cadence does not know where this person is, so it used their firm's state (${firmState}).` };
  return { zones: [EASTERN], state: null, abroad, guessed: 'Cadence does not know where this person or their firm is, so it used US Eastern time.' };
}

function localTime(zone: string, now: Date): { minutes: number; words: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { minutes: h * 60 + m, words: new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(now) };
}

/** Why a call may not be made now because of the hour, or null. */
export function callingHoursBlock(place: CallPlace, now = new Date()): string | null {
  for (const zone of place.zones) {
    const t = localTime(zone, now);
    if (t.minutes < CALL_HOURS.start * 60 || t.minutes >= CALL_HOURS.end * 60) {
      return `It is ${t.words} where this person is. Calls are allowed only from 8am to 9pm in their time zone.${place.guessed ? ` ${place.guessed}` : ''}`;
    }
  }
  return null;
}

/** The notice the rep reads before a call that will be recorded, where everyone must agree to it. */
export function recordingNotice(place: CallPlace): string | null {
  if (!(place.state && TWO_PARTY_CONSENT_STATES.has(place.state)) && !place.abroad) return null;
  const where = place.abroad ? 'outside the US' : `in ${place.state}`;
  return `Recording notice: this person is ${where}, where everyone on a call must agree to its recording. Say first: "This call is recorded. Is that all right with you?" If they say no, end the call.`;
}

/** Call attempts at this person today, in their own day: calls made, and Call clicks not yet matched to a call. */
export async function callAttemptsToday(subject: { personId?: string | null; sandboxContactId?: string | null }, place: CallPlace, now = new Date()): Promise<number> {
  const where = subject.personId ? { personId: subject.personId } : subject.sandboxContactId ? { sandboxContactId: subject.sandboxContactId } : null;
  if (!where) return 0;
  const since = zonedInstant(todayIn(place.zones[0], now), '00:00', place.zones[0]) ?? new Date(now.getTime() - 24 * 3600_000);
  const [calls, intents] = await Promise.all([
    prisma.callLog.count({ where: { ...where, direction: 'OUTBOUND', discardedAt: null, OR: [{ startedAt: { gte: since } }, { startedAt: null, createdAt: { gte: since } }] } }),
    prisma.callIntent.count({ where: { ...where, callId: null, createdAt: { gte: since } } }),
  ]);
  return calls + intents;
}

export function attemptLimitBlock(attempts: number, place: CallPlace): string | null {
  return attempts >= MAX_CALL_ATTEMPTS_PER_DAY ? `This person has already been called ${attempts} times today. At most ${MAX_CALL_ATTEMPTS_PER_DAY} calls a day are allowed; call again tomorrow (their time).${place.guessed ? ` ${place.guessed}` : ''}` : null;
}
