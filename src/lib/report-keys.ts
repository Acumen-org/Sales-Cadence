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
