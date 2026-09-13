'use client';

import { useFilterNavigation } from '@/components/filter-navigation';
import { useEffect, useState } from 'react';
import { IconSearch, IconStar } from '@/components/icons';
import { optionLabel } from '@/lib/twenty/labels';

type Props = { who: string; product: string; from: string; to: string; favourites: boolean; products: readonly string[] };

/**
 * The meetings filters: who was there, which product, when, and the ones this reader starred.
 * Each change applies at once; the URL carries the state so a filtered list can be shared.
 */
export function MeetingsToolbar({ who, product, from, to, favourites, products }: Props) {
  const navigate = useFilterNavigation();
  const [text, setText] = useState(who);
  useEffect(() => setText(who), [who]);

  const update = (patch: Record<string, string | null>) => {
    navigate((next) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete('page');
    });
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== who) update({ who: text || null });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const active = Boolean(who || product || from || to || favourites);
  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <div className="relative w-full max-w-[260px]">
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Attendee, title or account" aria-label="Search meetings" className="!pl-9" />
      </div>
      <select value={product} onChange={(e) => update({ product: e.target.value || null })} aria-label="Filter by product" className="!w-auto !py-2 !text-[12.5px]">
        <option value="">Any product</option>
        {products.map((p) => <option key={p} value={p}>{optionLabel(p)}</option>)}
      </select>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-500">From<input type="date" value={from} onChange={(e) => update({ from: e.target.value || null })} aria-label="From date" className="!w-auto !py-1.5 !text-[12.5px]" /></label>
      <label className="flex items-center gap-1.5 text-[12px] text-ink-500">To<input type="date" value={to} onChange={(e) => update({ to: e.target.value || null })} aria-label="To date" className="!w-auto !py-1.5 !text-[12.5px]" /></label>
      <button type="button" onClick={() => update({ fav: favourites ? null : '1' })} aria-pressed={favourites} className={favourites ? 'chip' : 'chip-muted'} title="Only the meetings you starred">
        <IconStar size={13} filled={favourites} /> Favourites
      </button>
      {active ? <button type="button" onClick={() => { setText(''); navigate((next) => { for (const key of [...next.keys()]) next.delete(key); }); }} className="btn-ghost btn-sm">Reset</button> : null}
    </div>
  );
}
