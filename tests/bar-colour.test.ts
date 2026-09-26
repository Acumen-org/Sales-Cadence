import { describe, expect, it } from 'vitest';
import { barColour } from '@/lib/bar-colour';

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const tenths = (surface?: 'light' | 'dark') => Array.from({ length: 11 }, (_, i) => luminance(barColour(i / 10, surface)));

describe('a bar darkens as it fills', () => {
  it('runs from a light green to the deep evergreen, darker at every step', () => {
    expect(barColour(0)).toBe('#82c4ac');
    expect(barColour(1)).toBe('#1d4a3f');
    const l = tenths();
    for (let i = 1; i < l.length; i++) expect(l[i]).toBeLessThan(l[i - 1]);
  });

  it('holds its ends for values outside a whole', () => {
    expect(barColour(1.4)).toBe(barColour(1));
    expect(barColour(-0.2)).toBe(barColour(0));
    expect(barColour(Number.NaN)).toBe(barColour(0));
  });

  it('on a dark band, darkens too while staying light enough to see', () => {
    const l = tenths('dark');
    for (let i = 1; i < l.length; i++) expect(l[i]).toBeLessThan(l[i - 1]);
    expect(l[10]).toBeGreaterThan(0.5);
  });
});
