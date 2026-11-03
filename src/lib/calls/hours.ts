import type { CallingSettings } from '../settings';
import { workspaceTimezone } from '../workspace';

/**
 * Calling hours (decision 14): 8:00 to 21:00 in the contact's local time, checked on Cadence's own
 * Call button only. It needs no Twilio change and cannot stop a number dialled straight into the
 * dialpad. The zone comes from the state, else the area code, else the workspace clock.
 */

const E = 'America/New_York', C = 'America/Chicago', M = 'America/Denver', AZ = 'America/Phoenix', P = 'America/Los_Angeles', AK = 'America/Anchorage', HI = 'Pacific/Honolulu';

const STATE_TZ: Record<string, string> = {
  AL: C, AK, AZ, AR: C, CA: P, CO: M, CT: E, DE: E, DC: E, FL: E, GA: E, HI, ID: M, IL: C, IN: E, IA: C, KS: C, KY: E, LA: C, ME: E, MD: E,
  MA: E, MI: E, MN: C, MS: C, MO: C, MT: M, NE: C, NV: P, NH: E, NJ: E, NM: M, NY: E, NC: E, ND: C, OH: E, OK: C, OR: P, PA: E, RI: E, SC: E,
  SD: C, TN: C, TX: C, UT: M, VT: E, VA: E, WA: P, WV: E, WI: C, WY: M, PR: 'America/Puerto_Rico',
};
const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL',
  georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const AREA_GROUPS: Array<[string, string]> = [
  [P, '209 213 279 310 323 341 350 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951 206 253 360 425 509 564 458 503 541 971 702 725 775'],
  [M, '303 719 720 970 983 385 435 801 505 575 208 986 406 307 915'],
  [AZ, '480 520 602 623 928'],
  [C, '217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 872 210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979 218 320 507 612 651 763 952 262 274 414 534 608 715 920 314 417 557 573 636 660 816 319 515 563 641 712 316 620 785 913 308 402 531 405 539 572 580 918 479 501 870 225 318 337 504 985 228 601 662 769 205 251 256 334 659 938 615 629 731 901 931 701 605 850 219 270'],
  [E, '212 315 332 347 516 518 585 607 631 646 680 716 718 838 845 914 917 929 934 239 305 321 352 386 407 448 561 656 689 727 754 772 786 813 863 904 941 954 229 404 470 478 678 706 762 770 912 943 252 336 704 743 828 910 919 980 984 803 839 843 854 864 276 434 540 571 703 757 804 826 948 215 223 267 272 412 445 484 570 582 610 717 724 814 835 878 201 551 609 640 732 848 856 862 908 973 339 351 413 508 617 774 781 857 978 216 220 234 283 326 330 380 419 436 440 513 567 614 740 937 231 248 269 313 517 586 616 679 734 810 906 947 989 260 317 463 574 765 812 930 364 502 606 859 227 240 301 410 443 667 202 771 203 475 860 959 304 681 302 207 603 802 401 423 865'],
  [AK, '907'],
  [HI, '808'],
];
const AREA_TZ = new Map(AREA_GROUPS.flatMap(([tz, codes]) => codes.split(' ').map((code) => [code, tz] as const)));

export function zoneFor(c: { state?: string | null; companyState?: string | null; phone?: string | null; country?: string | null }): { zone: string; from: 'state' | 'area code' | 'workspace' } {
  for (const s of [c.state, c.companyState]) {
    const raw = (s ?? '').trim();
    const code = raw.length === 2 ? raw.toUpperCase() : STATE_NAMES[raw.toLowerCase()];
    if (code && STATE_TZ[code]) return { zone: STATE_TZ[code], from: 'state' };
  }
  const nanp = c.phone?.match(/^\+1(\d{3})\d{7}$/);
  if (nanp && AREA_TZ.has(nanp[1])) return { zone: AREA_TZ.get(nanp[1])!, from: 'area code' };
  return { zone: workspaceTimezone(), from: 'workspace' };
}

export type HoursCheck = { allowed: boolean; warning: string | null; localTime: string; zone: string };

/** Whether Cadence's Call button may ring this contact now; outside the window it is blocked or warned. */
export function callingHours(c: Parameters<typeof zoneFor>[0], settings: CallingSettings, now = new Date()): HoursCheck {
  const { zone } = zoneFor(c);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: false }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const localTime = `${hour}:${minute}`;
  const zoneName = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? zone;
  const inside = hour >= settings.startHour && hour < settings.endHour;
  if (inside || settings.callingHours === 'off') return { allowed: true, warning: null, localTime, zone: zoneName };
  const text = `It is ${localTime} ${zoneName} for this contact, outside ${settings.startHour}:00 to ${settings.endHour}:00.`;
  return settings.callingHours === 'warn' ? { allowed: true, warning: text, localTime, zone: zoneName } : { allowed: false, warning: text, localTime, zone: zoneName };
}
