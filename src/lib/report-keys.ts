import { optionLabel } from './twenty/labels';

/** The channels a report splits outreach into. */
export type Channel = 'EMAIL' | 'CALL' | 'LINKEDIN';
export const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'EMAIL', label: 'Email' },
  { key: 'CALL', label: 'Calls' },
  { key: 'LINKEDIN', label: 'LinkedIn' },
];
export const channelOf = (action: string): Channel => (action === 'EMAIL' ? 'EMAIL' : action === 'CALL' ? 'CALL' : 'LINKEDIN');

/** The products a campaign or meeting can be about, in the order every chart and table uses. */
export const PRODUCT_ORDER = ['PHH', 'ACUBOOTH', 'GLYNAC', 'TOLLBOOTH'];
export const NO_PRODUCT = 'none';
export const SEVERAL_PRODUCTS = 'several';
export const productRank = (p: string) => { const i = PRODUCT_ORDER.indexOf(p); return i < 0 ? PRODUCT_ORDER.length : i; };
export const productLabel = (key: string) => (key === NO_PRODUCT ? 'No product' : key === SEVERAL_PRODUCTS ? 'Several products' : optionLabel(key));

/** What a Reports address carries: the period, who it covers, the breakdown tab, the view and the audience. */
export type ReportParams = { tab: string; from: string; to: string; pod: string; fo: string; view: 'outreach' | 'calls'; audience: 'all' | 'crm' | 'cold' };

/**
 * A Reports address. Every filter change keeps the others, the view (Outreach or Calls) and the
 * audience (B042); an empty pod or FO is kept as the reader's "All", and the defaults (the Outreach
 * view, All outreach) are left out.
 */
export function reportsHref(base: ReportParams, patch: Partial<ReportParams> = {}, path = '/reports'): string {
  const p = { ...base, ...patch };
  const params = new URLSearchParams({ tab: p.tab, from: p.from, to: p.to, pod: p.pod, fo: p.fo });
  if (p.view === 'calls') params.set('view', 'calls');
  if (p.audience !== 'all') params.set('audience', p.audience);
  return `${path}?${params.toString()}`;
}
