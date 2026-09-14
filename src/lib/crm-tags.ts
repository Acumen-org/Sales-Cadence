import type { BadgeTone } from '@/components/ui';
import { optionLabel } from './twenty/labels';
import { defaultTwentySchema } from './twenty/twenty-schema';
export function tagFilter(tag: string): { key: string; value: string } {
  for (const [key, values] of [['tier', defaultTwentySchema.personValues.tier], ['listCategory', defaultTwentySchema.personValues.listCategory], ['type', defaultTwentySchema.personValues.contactType], ['product', defaultTwentySchema.personValues.productInterest]] as const) {
    const value = values.find(value => value === tag || optionLabel(value).toLowerCase() === optionLabel(tag).toLowerCase());
    if (value) return { key, value };
  }
  return { key: 'tag', value: tag };
}
export function tagTone(tag: string): BadgeTone {
  const label = optionLabel(tag).toLowerCase();
  if (/do.not|opt.out|bounce|bad.email|bad.phone/.test(label)) return 'red';
  if (/missing|enrich|verif|priority/.test(label)) return 'amber';
  if (/client|customer|won/.test(label)) return 'green';
  if (/partner|opportunity/.test(label)) return 'purple';
  const palette: BadgeTone[] = ['blue', 'purple', 'green', 'sky', 'amber'];
  let hash = 0;
  for (const character of label) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}
