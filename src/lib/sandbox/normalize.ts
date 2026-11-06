/**
 * Normalisation for sandbox contacts (contract section 14.5 of docs/outreach-sandbox-plan.md). One
 * implementation serves the Bellwether push, manual add, dedupe, call matching and Graph mail
 * matching, so a value compared anywhere was cleaned the same way everywhere.
 */

/** One address: a local part with no spaces or brackets, and a domain of letter-or-digit labels with a real top level. */
const EMAIL = /^[^\s@<>()[\],;:"\\]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,63}$/u;

/**
 * Trim and lower-case the whole address. Dots and +tags are kept; a `mailto:` in front and a dot at
 * the end are dropped (B169). Null when it is not an address.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase().replace(/^mailto:/, '').replace(/\.+$/, '');
  if (!value || value.length > 254) return null;
  return EMAIL.test(value) ? value : null;
}

/**
 * The local part of a shared inbox (info@, sales@, compliance@...), which nobody in particular reads
 * and different people really do share. The same pattern as Bellwether's ROLE_RE (prospect/contacts.py)
 * and the 20261105000001_cold_outreach_backfill migration, so all three agree on which address is one.
 */
export const ROLE_EMAIL = /^(info|contact|hello|hi|hey|enquir(y|ies)|inquir(y|ies)|sales|support|help|admin|office|team|mail|press|media|marketing|careers|jobs|hr|recruit(ing|ment)?|billing|accounts?|accounting|finance|invoices?|legal|privacy|security|partners|partnerships|business|bd|general|customerservice|customer[-_.]?care|service|services|booking|reservations|orders?|webmaster|hostmaster|it|desk|reception|newsletter|subscribe|feedback|questions|ask|talk|connect|compliance|operations|ops|clientservices?|client[-_.]?service|clients?|advisors?|planning|wealth|invest(ments?|ing)?|trading|trade|custody|transfers?|documents?|statements?|noreply|no[-_.]?reply|frontdesk|main|appointments?|scheduling|events?)s?([-_.].*)?$/i;

/** Whether an address is a shared inbox rather than one person's (B177, N025). */
export function isRoleEmail(email: string | null | undefined): boolean {
  const at = (email ?? '').lastIndexOf('@');
  return at > 0 && ROLE_EMAIL.test((email ?? '').slice(0, at));
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
 * leading + or 00 and its country code, the "+44 (0)20" trunk included; a national number from
 * another region is read with that region's calling code after dropping its trunk 0. Null when it
 * cannot be a real number: a North American number is 10 digits, or 11 with the leading 1, and any
 * other count is a typo, never a foreign number (B014).
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
  // "+44 (0)20 7946 0000": the (0) is the trunk prefix, dialled only from inside the country.
  if (international) value = value.replace(/\(\s*0\s*\)/g, '');
  let digits = value.replace(/\D/g, '');
  if (international && value.trim().startsWith('00')) digits = digits.slice(2);
  const region = (country ?? 'US').trim().toUpperCase() || 'US';
  let full: string;
  if (international) {
    full = digits;
  } else {
    const code = CALLING_CODES[region];
    if (!code) return null;
    if (code === '1') {
      if (digits.length === 10) full = `1${digits}`;
      else if (digits.length === 11 && digits.startsWith('1')) full = digits;
      else return null;
    } else full = `${code}${digits.replace(/^0+/, '')}`;
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

/**
 * linkedin.com/in/<slug>, or null for anything that is not a person profile. The slug is decoded
 * first and lower-cased after, so an encoded capital (%C3%89) compares equal to its small letter (B169).
 */
export function normalizeLinkedin(raw: string | null | undefined): string | null {
  let value = (raw ?? '').trim();
  if (!value) return null;
  value = value.replace(/^[a-z]+:\/\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  value = value.replace(/^(www\.|[a-z]{2}\.|m\.)/i, '');
  const match = value.match(/^linkedin\.com\/in\/([^/\s]+)/i);
  if (!match) return null;
  let slug = match[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep as is */ }
  slug = slug.toLowerCase();
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

/**
 * A firm name compared loosely: no LLC/Inc./Ltd, punctuation or case. Letters of every alphabet are
 * kept, so "Müller Vermögen" is never compared as "m ller verm gen" (B170).
 */
export function normalizeFirmName(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])(llc|l l c|inc|incorporated|ltd|limited|corp|corporation|co|company|lp|llp|plc|pllc|pc|the)(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Common ways of writing a country that are not its ISO 3166-1 alpha-2 code. */
const COUNTRY_ALIASES: Record<string, string> = {
  UK: 'GB', USA: 'US', 'U S': 'US', 'U S A': 'US', AMERICA: 'US', 'UNITED STATES OF AMERICA': 'US', 'GREAT BRITAIN': 'GB', BRITAIN: 'GB', ENGLAND: 'GB', SCOTLAND: 'GB',
  WALES: 'GB', 'NORTHERN IRELAND': 'GB', GBR: 'GB', CAN: 'CA', AUS: 'AU', IRL: 'IE', DEU: 'DE', FRA: 'FR', CHE: 'CH', NLD: 'NL', SGP: 'SG', HKG: 'HK', IND: 'IN', NZL: 'NZ',
  ESP: 'ES', ITA: 'IT', BEL: 'BE', SWE: 'SE', NOR: 'NO', DNK: 'DK', FIN: 'FI', AUT: 'AT', PRT: 'PT', POL: 'PL', ISR: 'IL', ZAF: 'ZA', MEX: 'MX', BRA: 'BR', JPN: 'JP',
  CHN: 'CN', ARE: 'AE', PRI: 'PR', UAE: 'AE', HOLLAND: 'NL',
};
/** Codes that name no country: the UN, the EU, private-use and pseudo regions. */
const NOT_COUNTRIES = new Set(['UN', 'EU', 'EZ', 'QO', 'ZZ', 'XA', 'XB']);
const countryKey =(v: string) => v.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
let regionNames: Map<string, string> | null = null;
/** Every region's English name, keyed loosely, to its code ("United Kingdom" to GB). */
function regionsByName(): Map<string, string> {
  if (regionNames) return regionNames;
  regionNames = new Map();
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      let name: string | undefined;
      try { name = names.of(code); } catch { name = undefined; }
      // A retired code (UK, BU, DD) names its successor's country: only the code in use is kept.
      if (name && name !== code && !NOT_COUNTRIES.has(code) && Intl.getCanonicalLocales(`und-${code}`)[0] === `und-${code}`) regionNames.set(countryKey(name), code);
    }
  }
  return regionNames;
}

/**
 * A country as ISO 3166-1 alpha-2 (B072): a code as given, "UK" as GB, an English name or a common
 * alias as its code. Null when it is not a country Cadence knows, so the caller can say so rather
 * than file "United Kingdom" as US or "UN".
 */
export function normalizeCountry(raw: string | null | undefined): string | null {
  const key = countryKey(raw ?? '');
  if (!key) return null;
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
  if (/^[A-Z]{2}$/.test(key)) return [...regionsByName().values()].includes(key) ? key : null;
  return regionsByName().get(key) ?? null;
}

/** Control characters other than tab and newline: never stored (a NUL breaks Postgres text, B012). */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export const stripControl = (s: string) => s.replace(CONTROL, '');
export const hasControl = (s: string) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);

const ENTITIES: Record<string, string> = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", amp: '&' };

/**
 * Text from outside Cadence as plain text (B114): HTML tags and comments gone (a block tag becomes a
 * line break), a markdown link or image reduced to its words and its http(s) address (any other
 * address is dropped), no control characters. Used at Bellwether's intake and on every note Cadence
 * writes to the CRM, so neither HTML nor a crafted link reaches a CRM note.
 */
export function plainText(raw: string): string {
  return stripControl(raw)
    .replace(/&(nbsp|lt|gt|quot|apos|#39|amp);/g, (_, name: string) => ENTITIES[name])
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|table|blockquote)(?:\s[^<>]*)?\/?>/gi, '\n')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, '')
    .replace(/!?\[([^\]]*)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))*)>?(?:\s+"[^"]*")?\s*\)/g, (_, words: string, href: string) => (/^https?:\/\//i.test(href) ? `${words.trim()} (${href})`.trim() : words.trim()))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A person's name from outside Cadence: plain text, then no brackets or angle brackets left at all (B114). */
export const plainName = (raw: string) => plainText(raw).replace(/[<>[\]()]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Cut text at a word boundary to at most `max` characters (B072, B172): never mid-word, and without
 * a trailing comma or dash. A single word longer than `max` is cut at `max`.
 */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const at = head.search(/\s\S*$/);
  const cut = (at > max / 2 ? head.slice(0, at) : text.slice(0, max)).replace(/[\s,;:.\-\u2013]+$/, '');
  return cut || text.slice(0, max);
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
