import type { CallingSettings } from '../settings';
import { workspaceTimezone } from '../workspace';

/**
 * Calling hours (decision 14): 8:00 to 21:00 in the contact's local time, checked on Cadence's own
 * Call button only. It needs no Twilio change and cannot stop a number dialled straight into the
 * dialpad. The zone comes from the number first (B090, N047): a country's own zone outside North
 * America, a North American area code (US states, Canada and the territories), then the state, then
 * the country. When the place spans zones (Tennessee, Texas, Australia) or nothing names one, the
 * check applies the strictest window over every zone it could be, and says the zone was guessed.
 */

const E = 'America/New_York', C = 'America/Chicago', M = 'America/Denver', AZ = 'America/Phoenix', P = 'America/Los_Angeles', AK = 'America/Anchorage', HI = 'Pacific/Honolulu';
const AT = 'America/Halifax', NL = 'America/St_Johns', SK = 'America/Regina', PR = 'America/Puerto_Rico';

/** A state's zones; the split states have two, and the area code picks between them (B090). */
const STATE_ZONES: Record<string, string[]> = {
  AL: [C], AK: [AK], AZ: [AZ], AR: [C], CA: [P], CO: [M], CT: [E], DE: [E], DC: [E], FL: [E, C], GA: [E], HI: [HI], ID: [M, P], IL: [C], IN: [E, C], IA: [C], KS: [C, M], KY: [E, C], LA: [C], ME: [E], MD: [E],
  MA: [E], MI: [E, C], MN: [C], MS: [C], MO: [C], MT: [M], NE: [C, M], NV: [P], NH: [E], NJ: [E], NM: [M], NY: [E], NC: [E], ND: [C, M], OH: [E], OK: [C], OR: [P, M], PA: [E], RI: [E], SC: [E],
  SD: [C, M], TN: [C, E], TX: [C, M], UT: [M], VT: [E], VA: [E], WA: [P], WV: [E], WI: [C], WY: [M], PR: [PR], VI: ['America/St_Thomas'], GU: ['Pacific/Guam'],
  // Canada's provinces, for a contact whose state is a province.
  ON: [E], QC: [E], BC: [P], AB: [M], MB: [C], SK: [SK], NS: [AT], NB: [AT], PE: [AT], NF: [NL], NT: [M], YT: [P], NU: [E, C, M],
};
const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL',
  georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR', 'virgin islands': 'VI', guam: 'GU', ontario: 'ON', quebec: 'QC', 'british columbia': 'BC', alberta: 'AB', manitoba: 'MB', saskatchewan: 'SK',
  'nova scotia': 'NS', 'new brunswick': 'NB', 'prince edward island': 'PE', newfoundland: 'NF', 'newfoundland and labrador': 'NF', nl: 'NF',
};
/** North American area codes by zone: the US, Canada and the territories (N047 added 686, 787/939, 340, 671, 670, 684; 364 is Central). */
const AREA_GROUPS: Array<[string, string]> = [
  [P, '209 213 279 310 323 341 350 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951 206 253 360 425 509 564 458 503 541 971 702 725 775 604 778 236 250 672'],
  [M, '303 719 720 970 983 385 435 801 505 575 208 986 406 307 915 403 587 825 368 780'],
  [AZ, '480 520 602 623 928'],
  [C, '217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 872 210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979 218 320 507 612 651 763 952 262 274 414 534 608 715 920 314 417 557 573 636 660 816 319 515 563 641 712 316 620 785 913 308 402 531 405 539 572 580 918 479 501 870 225 318 337 504 985 228 601 662 769 205 251 256 334 659 938 615 629 731 901 931 701 605 850 219 270 364 204 431'],
  [E, '212 315 332 347 516 518 585 607 631 646 680 716 718 838 845 914 917 929 934 239 305 321 352 386 407 448 561 656 689 727 754 772 786 813 863 904 941 954 229 404 470 478 678 706 762 770 912 943 252 336 704 743 828 910 919 980 984 803 839 843 854 864 276 434 540 571 686 703 757 804 826 948 215 223 267 272 412 445 484 570 582 610 717 724 814 835 878 201 551 609 640 732 848 856 862 908 973 339 351 413 508 617 774 781 857 978 216 220 234 283 326 330 380 419 436 440 513 567 614 740 937 231 248 269 313 517 586 616 679 734 810 906 947 989 260 317 463 574 765 812 930 502 606 859 227 240 301 410 443 667 202 771 203 475 860 959 304 681 302 207 603 802 401 423 865 416 647 437 905 289 365 742 613 343 753 705 249 683 807 548 519 226 514 438 450 579 354 418 581 367 819 873 468'],
  [SK, '306 639 474'],
  [AT, '902 782 506 428'],
  [NL, '709 879'],
  [AK, '907'],
  [HI, '808'],
  [PR, '787 939'],
  ['America/St_Thomas', '340'],
  ['Pacific/Guam', '671'],
  ['Pacific/Saipan', '670'],
  ['Pacific/Pago_Pago', '684'],
];
const AREA_TZ = new Map(AREA_GROUPS.flatMap(([tz, codes]) => codes.split(' ').map((code) => [code, tz] as const)));

/** Calling codes outside North America, longest first when matched: one zone, or every zone a country spans. */
const COUNTRY_CODES: Record<string, string[]> = {
  '44': ['Europe/London'], '353': ['Europe/Dublin'], '33': ['Europe/Paris'], '49': ['Europe/Berlin'], '31': ['Europe/Amsterdam'], '32': ['Europe/Brussels'], '41': ['Europe/Zurich'],
  '34': ['Europe/Madrid'], '39': ['Europe/Rome'], '351': ['Europe/Lisbon'], '352': ['Europe/Luxembourg'], '43': ['Europe/Vienna'], '45': ['Europe/Copenhagen'], '46': ['Europe/Stockholm'],
  '47': ['Europe/Oslo'], '358': ['Europe/Helsinki'], '48': ['Europe/Warsaw'], '420': ['Europe/Prague'], '30': ['Europe/Athens'], '36': ['Europe/Budapest'], '40': ['Europe/Bucharest'],
  '972': ['Asia/Jerusalem'], '971': ['Asia/Dubai'], '966': ['Asia/Riyadh'], '974': ['Asia/Qatar'], '91': ['Asia/Kolkata'], '65': ['Asia/Singapore'], '852': ['Asia/Hong_Kong'],
  '81': ['Asia/Tokyo'], '82': ['Asia/Seoul'], '86': ['Asia/Shanghai'], '886': ['Asia/Taipei'], '27': ['Africa/Johannesburg'], '64': ['Pacific/Auckland'],
  '61': ['Australia/Perth', 'Australia/Adelaide', 'Australia/Sydney'], '52': ['America/Tijuana', 'America/Mexico_City', 'America/Cancun'], '55': ['America/Manaus', 'America/Sao_Paulo'],
  '7': ['Europe/Moscow', 'Asia/Yekaterinburg', 'Asia/Vladivostok'], '62': ['Asia/Jakarta', 'Asia/Jayapura'],
};
const COUNTRY_ISO: Record<string, string[]> = {
  GB: ['Europe/London'], UK: ['Europe/London'], IE: ['Europe/Dublin'], FR: ['Europe/Paris'], DE: ['Europe/Berlin'], NL: ['Europe/Amsterdam'], BE: ['Europe/Brussels'], CH: ['Europe/Zurich'],
  ES: ['Europe/Madrid'], IT: ['Europe/Rome'], PT: ['Europe/Lisbon'], LU: ['Europe/Luxembourg'], AT: ['Europe/Vienna'], DK: ['Europe/Copenhagen'], SE: ['Europe/Stockholm'], NO: ['Europe/Oslo'],
  FI: ['Europe/Helsinki'], PL: ['Europe/Warsaw'], IL: ['Asia/Jerusalem'], AE: ['Asia/Dubai'], IN: ['Asia/Kolkata'], SG: ['Asia/Singapore'], HK: ['Asia/Hong_Kong'], JP: ['Asia/Tokyo'],
  CN: ['Asia/Shanghai'], ZA: ['Africa/Johannesburg'], NZ: ['Pacific/Auckland'], AU: ['Australia/Perth', 'Australia/Adelaide', 'Australia/Sydney'], CA: [AT, E, C, M, P], US: [E, C, M, P],
  PR: [PR], MX: ['America/Tijuana', 'America/Mexico_City', 'America/Cancun'], BR: ['America/Manaus', 'America/Sao_Paulo'],
};

export type ZoneFrom = 'area code' | 'number' | 'state' | 'country' | 'workspace';
/** The zones the contact may be in; `zone` is the one to show. Guessed: more than one, or none known. */
export type ZoneGuess = { zone: string; zones: string[]; from: ZoneFrom; guessed: boolean };

/** "N.Y.", "ny", "New York", "Tenn" read as a state's code. */
function stateCode(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const letters = s.replace(/[.\s]/g, '').toUpperCase();
  if (letters.length === 2 && STATE_ZONES[letters]) return letters;
  return STATE_NAMES[s.toLowerCase().replace(/\./g, '').trim()] ?? null;
}

export function zoneFor(c: { state?: string | null; companyState?: string | null; phone?: string | null; country?: string | null }): ZoneGuess {
  const one = (zone: string, from: ZoneFrom): ZoneGuess => ({ zone, zones: [zone], from, guessed: false });
  const many = (zones: string[], from: ZoneFrom): ZoneGuess => (zones.length === 1 ? one(zones[0], from) : { zone: zones[0], zones, from, guessed: true });
  const phone = (c.phone ?? '').replace(/[^\d+]/g, '');
  const state = stateCode(c.state) ?? stateCode(c.companyState);
  const stateZones = state ? STATE_ZONES[state] : null;
  const nanp = phone.match(/^\+1(\d{3})\d{7}$/);
  if (nanp) {
    const area = AREA_TZ.get(nanp[1]);
    // A split state takes the area code's zone when it is one of the state's own (865 Knoxville is Eastern).
    if (area && (!stateZones || stateZones.includes(area))) return one(area, 'area code');
    if (stateZones) return many(stateZones, 'state');
    if (area) return one(area, 'area code');
  } else if (phone.startsWith('+')) {
    const code = ['', '', ''].map((_, i) => phone.slice(1, 4 - i)).find((k) => COUNTRY_CODES[k]);
    if (code) return many(COUNTRY_CODES[code], 'number');
  }
  if (stateZones) return many(stateZones, 'state');
  const country = COUNTRY_ISO[(c.country ?? '').trim().toUpperCase()];
  if (country) return many(country, 'country');
  return { zone: workspaceTimezone(), zones: [workspaceTimezone()], from: 'workspace', guessed: true };
}

export type HoursCheck = { allowed: boolean; warning: string | null; localTime: string; zone: string; guessed: boolean };

const hourIn = (zone: string, now: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: false }).formatToParts(now);
  return { hour: Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24, minute: parts.find((p) => p.type === 'minute')?.value ?? '00' };
};
const zoneName = (zone: string, now: Date) => new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? zone;

/** Whether Cadence's Call button may ring this contact now; outside the window it is blocked or warned. A guessed zone uses the strictest window. */
export function callingHours(c: Parameters<typeof zoneFor>[0], settings: CallingSettings, now = new Date()): HoursCheck {
  const guess = zoneFor(c);
  const inside = (zone: string) => { const h = hourIn(zone, now).hour; return h >= settings.startHour && h < settings.endHour; };
  // The strictest window: every zone the contact could be in must be inside the hours.
  const outside = guess.zones.find((z) => !inside(z));
  const shown = outside ?? guess.zone;
  const { hour, minute } = hourIn(shown, now);
  const localTime = `${hour}:${minute}`;
  const zone = zoneName(shown, now);
  if (!outside || settings.callingHours === 'off') return { allowed: true, warning: null, localTime, zone, guessed: guess.guessed };
  const text = `It is ${localTime} ${zone} for this contact${guess.guessed ? ' (zone guessed: the strictest of the zones they could be in)' : ''}, outside ${settings.startHour}:00 to ${settings.endHour}:00.`;
  return settings.callingHours === 'warn' ? { allowed: true, warning: text, localTime, zone, guessed: guess.guessed } : { allowed: false, warning: text, localTime, zone, guessed: guess.guessed };
}
