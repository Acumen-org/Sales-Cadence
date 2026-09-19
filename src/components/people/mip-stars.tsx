'use client';

import { useState, useTransition } from 'react';
import { setMipStarsAction } from '@/lib/actions/mip';

/**
 * Three stars for a most-important person. Empty until the pod says; click a star to set that
 * many, click the last lit one to clear. Read-only for anyone outside the pod, where the stars
 * just show what the pod decided.
 */
export function MipStars({ personId, name, stars: initial, canRate }: { personId: string; name: string; stars: number; canRate: boolean }) {
  const [stars, setStars] = useState(initial);
  const [pending, start] = useTransition();
  const set = (n: number) => start(async () => {
    const next = n === stars ? 0 : n;
    const before = stars;
    setStars(next);
    const result = await setMipStarsAction(personId, next);
    if (!result.ok) setStars(before);
  });
  return (
    <span className="inline-flex items-center gap-0.5" role={canRate ? 'radiogroup' : undefined} aria-label={`${name}: ${stars ? `${stars} of 3 stars` : 'no stars yet'}`} title={stars ? `${stars} of 3` : canRate ? 'Click a star' : undefined}>
      {[1, 2, 3].map((n) => {
        const lit = n <= stars;
        const glyph = <svg viewBox="0 0 20 20" width={16} height={16} aria-hidden className={lit ? 'fill-amber-400 stroke-amber-500' : 'fill-transparent stroke-ink-300'} strokeWidth={1.4}><path d="M10 1.8l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L10 14.5l-5.1 2.7 1.1-5.6L1.8 7.7l5.7-.7z" /></svg>;
        return canRate
          ? <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={`${n} star${n === 1 ? '' : 's'}`} disabled={pending} onClick={() => set(n)} className="rounded p-0.5 transition hover:scale-110 focus-visible:ring-2 focus-visible:ring-brand-300">{glyph}</button>
          : <span key={n} className="p-0.5">{glyph}</span>;
      })}
    </span>
  );
}
