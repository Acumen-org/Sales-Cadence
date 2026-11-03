/**
 * Normalisation for sandbox contacts (contract section 14.5 of docs/outreach-sandbox-plan.md). One
 * implementation serves the Bellwether push, manual add, dedupe, call matching and Graph mail
 * matching, so a value compared anywhere was cleaned the same way everywhere.
 */

/** Trim and lower-case the whole address. Dots and +tags are kept. Null when it is not an address. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || value.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

/** Calling codes for the regions Bellwether sends today, keyed by ISO 3166-1 alpha-2. */
const CALLING_CODES: Record<string, string> = {
  US: '1', CA: '1', PR: '1', GB: '44', IE: '353', AU: '61', NZ: '64', IN: '91', SG: '65', HK: '852', AE: '971',
  DE: '49', FR: '33', ES: '34', IT: '39', NL: '31', BE: '32', CH: '41', AT: '43', SE: '46', NO: '47', DK: '45', FI: '358',
  PT: '351', PL: '48', IL: '972', ZA: '27', MX: '52', BR: '55', JP: '81', CN: '86',
};

const NANP = /^1([2-9]\d{2})([2-9]\d{2})(\d{4})$/;

export type ParsedPhone = { e164: string; extension: string | null };

/**
 * Parse a phone number to E.164 with the region from `country` (default US). The extension is
 * split off. Handles North American numbers in any common format and any number written with a
 * leading + or 00 and its country code; a national number from another region is read with that
 * region's calling code after dropping its trunk 0. Null when it cannot be a real number.
 */
export function parsePhone(raw: string | null | undefined, country: string | null | undefined = 'US'): ParsedPhone | null {
  let value = (raw ?? '').trim();
  if (!value) return null;
  let extension: string | null = null;
  const ext = value.match(/(?:;\s*ext=|\s*(?:ext\.?|extension|x|#)\s*)(\d{1,10})\s*$/i);
  if (ext && ext.index !== undefined && ext.index > 0) {
    extension = ext[1];
    value = value.slice(0, ext.index);
  }
  const international = /^\s*(\+|00)/.test(value);
  let digits = value.replace(/\D/g, '');
  if (international && value.trim().startsWith('00')) digits = digits.slice(2);
  const region = (country ?? 'US').trim().toUpperCase() || 'US';
  let full: string;
  if (international) {
    full = digits;
  } else {
    const code = CALLING_CODES[region];
    if (!code) return null;
    if (code === '1') full = digits.length === 10 ? `1${digits}` : digits;
    else full = `${code}${digits.replace(/^0+/, '')}`;
  }
  if (full.startsWith('1')) {
    if (!NANP.test(full)) return null;
  } else if (full.length < 8 || full.length > 15 || full.startsWith('0')) {
    return null;
  }
  return { e164: `+${full}`, extension };
}

export function toE164(raw: string | null | undefined, country?: string | null): string | null {
  return parsePhone(raw, country)?.e164 ?? null;
}

/** linkedin.com/in/<slug>, or null for anything that is not a person profile. */
export function normalizeLinkedin(raw: string | null | undefined): string | null {
  let value = (raw ?? '').trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z]+:\/\//, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  value = value.replace(/^(www\.|[a-z]{2}\.|m\.)/, '');
  const match = value.match(/^linkedin\.com\/in\/([^/\s]+)/);
  if (!match) return null;
  let slug = match[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep as is */ }
  return slug ? `linkedin.com/in/${slug}` : null;
}

/** The URL Twenty stores: the normalised profile with its https://www. prefix restored. */
export function linkedinHref(normalized: string | null | undefined): string | null {
  return normalized ? `https://www.${normalized}` : null;
}

/** Digits only, leading zeros removed. */
export function normalizeCrd(raw: string | number | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return digits || null;
}

/** Lower-case; no scheme, www. or path. */
export function normalizeDomain(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) ? value : null;
}

/** A firm name compared loosely: no LLC/Inc./Ltd, punctuation or case. */
export function normalizeFirmName(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(llc|l l c|inc|incorporated|ltd|limited|corp|corporation|co|company|lp|llp|plc|pllc|pc|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const PHONE_TYPES = ['direct', 'mobile', 'office', 'main', 'toll_free', 'unknown'] as const;
export type PhoneType = (typeof PHONE_TYPES)[number];

/** Numbers that belong to one person: the only ones that may match a call or a sandbox contact. */
export const personalPhone = (type: string | null | undefined) => type === 'direct' || type === 'mobile';

/** "lastname firstname" for ordering, the way the person cache sorts. */
export function sandboxSortName(firstName: string, lastName: string): string | null {
  const key = `${lastName} ${firstName}`.trim().toLowerCase();
  return key || null;
}

export type ExtraPhone = { number: string; type: string };

export function readExtraPhones(value: unknown): ExtraPhone[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (item && typeof item === 'object' && typeof (item as ExtraPhone).number === 'string' ? [{ number: (item as ExtraPhone).number, type: String((item as ExtraPhone).type ?? 'unknown') }] : []));
}

/** An E.164 number as Twenty's phone composite holds it: calling code, national number, region. */
export function splitE164(e164: string | null | undefined): { callingCode: string; number: string; country: string } | null {
  if (!e164 || !e164.startsWith('+')) return null;
  const digits = e164.slice(1);
  const byLength = Object.entries(CALLING_CODES).sort((a, b) => b[1].length - a[1].length);
  const hit = byLength.find(([, code]) => digits.startsWith(code));
  if (!hit) return { callingCode: '', number: e164, country: '' };
  const [country, code] = hit;
  return { callingCode: `+${code}`, number: digits.slice(code.length), country: code === '1' ? 'US' : country };
}
