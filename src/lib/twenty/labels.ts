/**
 * Twenty stores select and multi-select values as shouty constants (LEVEL_3,
 * FPA_WISCONSIN_JULY_2026, CLIENT_S_CLIENT). The human label lives in the field's metadata,
 * which Cadence only sees when `pnpm verify:schema` or a pod sync reads it, so everywhere else
 * we render the value. Printing it raw makes the whole app look like a database dump, so this
 * turns a value into something readable without inventing meaning.
 *
 * Rules: acronyms the team uses stay upper-case, a trailing four-digit year is split off, and
 * anything the general rule gets outright wrong is listed in OVERRIDES.
 */

/** Words that must not be title-cased. Ordered for reading, not by importance. */
const ACRONYMS = new Set([
  // products and internal names
  'PHH', 'AY', 'CE', 'MIP', 'GHL', 'BV', 'BAVU', 'NIL', 'FDL', 'KM', 'SLA', 'POC', 'LI',
  // industry bodies and events
  'FPA', 'FPAIN', 'CFA', 'WM', 'RIA', 'RIAS', 'HNWI', 'FB',
  // states and regions
  'IL', 'WI', 'IN', 'US', 'UK', 'NY', 'CA', 'TX',
  // status shorthands
  'BD', 'DNC', 'DND', 'CRM', 'TOP20', 'FU',
]);

/** Values the general rule reads badly. */
const OVERRIDES: Record<string, string> = {
  DO_NOT_DISTURB: 'Do not contact',
  DO_NOT_CONTACT: 'Do not contact',
  DO_NOT_CALL: 'Do not call',
  DNC: 'Do not contact',
  BI_WEEKLY: 'Bi-weekly',
  BIWEEKLY: 'Bi-weekly',
  TWICE_WEEKLY: 'Twice weekly',
  COLD_BD: 'Cold BD',
  UNASSIGNED: 'Unassigned',
  CLIENT_S_CLIENT: "Client's client",
  CLIENTS: 'Client',
  LINKEDIN_MESSAGE: 'LinkedIn message',
  LINKEDIN: 'LinkedIn',
  LEADGEN: 'Lead gen',
  MISSING_EMAIL: 'Email missing',
  MISSING_PHONE: 'Phone missing',
  MISSING_ADDRESS: 'Address missing',
  ENRICHMENT_REQUIRED: 'Needs enrichment',
  FOR_REVIEW: 'For review',
  TO_CALL_LIST: 'To call',
  TO_TEXT_LIST: 'To text',
  KANBAN_AWARENESS: 'Kanban: awareness',
  KANBAN_OPPORTUNITY: 'Kanban: opportunity',
  HIGH_PRIORITY_HOT_LEAD: 'Hot lead',
  AY_PHH_POST_WEBINAR: 'AY PHH post-webinar',
  CE_PRESENTATION: 'CE presentation',
  WEALTH_MANAGEMENT_FIRMS_IL_WI_IN: 'Wealth management firms (IL, WI, IN)',
  QUATERLY: 'Quarterly',
};

/** LEVEL_2 -> Tier 2, and any other LEVEL_n. */
const LEVEL = /^LEVEL[_-]?(\d+)$/i;
/** ROTATED_OUT_LEIGH -> Rotated out to Leigh. */
const ROTATED = /^ROTATED[_-]OUT[_-](.+)$/i;

function word(w: string): string {
  if (!w) return w;
  const upper = w.toUpperCase();
  if (ACRONYMS.has(upper)) return upper;
  if (/^\d+$/.test(w)) return w;
  // FEB2026 -> Feb 2026, ORIONASCENTFEB2026 -> Orionascentfeb 2026.
  const withYear = /^([A-Za-z]+)(\d{4})$/.exec(w);
  if (withYear) return `${word(withYear[1])} ${withYear[2]}`;
  return upper.charAt(0) + w.slice(1).toLowerCase();
}

/** A single option value as a human would read it. Free text is returned unchanged. */
export function optionLabel(value: string | null | undefined): string {
  if (!value) return '';
  const raw = value.trim();
  if (!raw) return '';
  // Anything that is not a constant (has a space or a lower-case letter) is already prose.
  if (/[a-z]/.test(raw) && !/_/.test(raw)) return raw;

  const key = raw.toUpperCase();
  if (OVERRIDES[key]) return OVERRIDES[key];

  const level = LEVEL.exec(raw);
  if (level) return `Tier ${level[1]}`;

  const rotated = ROTATED.exec(raw);
  if (rotated) return `Rotated out to ${optionLabel(rotated[1])}`;

  return raw.split(/[_\s]+/).filter(Boolean).map(word).join(' ');
}

/** Several option values, joined for a single line. */
export function optionLabels(values: readonly string[] | null | undefined, separator = ', '): string {
  return (values ?? []).map(optionLabel).filter(Boolean).join(separator);
}

/**
 * How urgent a tier is, best first, for sorting and colouring. Unknown values sort last so a
 * value the workspace added after this file was written is never silently promoted.
 */
export function tierRank(tier: string | null | undefined, order: readonly string[]): number {
  if (!tier) return order.length + 1;
  const i = order.indexOf(tier);
  return i < 0 ? order.length : i;
}
