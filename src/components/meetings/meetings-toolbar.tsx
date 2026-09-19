'use client';

import { useId, useState } from 'react';
import { useFilterNavigation } from '@/components/filter-navigation';
import { useSearchBox } from '@/components/search-box';
import { IconFilter, IconSearch, IconStar } from '@/components/icons';
import { optionLabel } from '@/lib/twenty/labels';
import { formatLocalDate } from '@/lib/dates';

type Props = { who: string; product: string; from: string; to: string; favourites: boolean; products: readonly string[]; booked: string; fos: { id: string; name: string }[] };

/**
 * The meetings filters: who was there, who booked it, the ones this reader starred; product and
 * the date range behind Filters, applied ones shown as chips in their own row. Each change
 * applies at once; the URL carries the state so a filtered list can be shared.
 */
export function MeetingsToolbar({ who, product, from, to, favourites, products, booked, fos }: Props) {
  const navigate = useFilterNavigation();
  const [showMore, setShowMore] = useState(false);
  const panelId = useId();

  const update = (patch: Record<string, string | null>) => {
    navigate((next) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      next.delete('page');
    });
  };

  const { text, setText, reset } = useSearchBox(who, (value) => update({ who: value }));

  const active = Boolean(who || product || from || to || favourites || booked);
  const chips = [
    product ? { key: 'product', label: `Product: ${optionLabel(product)}` } : null,
    from ? { key: 'from', label: `From ${formatLocalDate(from)}` } : null,
    to ? { key: 'to', label: `To ${formatLocalDate(to)}` } : null,
  ].filter((c): c is { key: string; label: string } => c !== null);
  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <div className="relative w-full max-w-[260px]">
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Attendee, title or account" aria-label="Search meetings" className="!pl-9" />
      </div>
      <select value={booked} onChange={(e) => update({ booked: e.target.value || null })} aria-label="Booked by" className="!w-auto !max-w-[200px] !py-2 !text-[12.5px]">
        <option value="">Booked by anyone</option>
        {fos.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      <button type="button" onClick={() => update({ fav: favourites ? null : '1' })} aria-pressed={favourites} className={favourites ? 'chip' : 'chip-muted'} title="Only the meetings you starred">
        <IconStar size={13} filled={favourites} /> Favourites
      </button>
      <button type="button" onClick={() => setShowMore(!showMore)} aria-expanded={showMore} aria-controls={panelId} className={`btn-secondary btn-sm ${showMore || chips.length ? '!border-brand-300 !bg-brand-50 !text-brand-800' : ''}`}>
        <IconFilter size={14} /> Filters
        {chips.length ? <span className="rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold leading-[17px] text-white">{chips.length}</span> : null}
      </button>
      {active ? <button type="button" onClick={() => { reset(); navigate((next) => { for (const key of [...next.keys()]) next.delete(key); }); }} className="btn-ghost btn-sm">Reset</button> : null}

      <div id={panelId} className={`${showMore ? 'flex' : 'hidden'} w-full flex-wrap items-center gap-2 rounded-[10px] border border-line bg-canvas/70 p-2`}>
        <select value={product} onChange={(e) => update({ product: e.target.value || null })} aria-label="Filter by product" className="!w-auto !py-2 !text-[12.5px]">
          <option value="">Any product</option>
          {products.map((p) => <option key={p} value={p}>{optionLabel(p)}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-500">From<input type="date" value={from} onChange={(e) => update({ from: e.target.value || null })} aria-label="From date" className="!w-auto !py-1.5 !text-[12.5px]" /></label>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-500">To<input type="date" value={to} onChange={(e) => update({ to: e.target.value || null })} aria-label="To date" className="!w-auto !py-1.5 !text-[12.5px]" /></label>
      </div>

      {chips.length ? (
        <div className="flex w-full flex-wrap items-center gap-2">
          {chips.map((c) => (
            <button key={c.key} type="button" className="chip" onClick={() => update({ [c.key]: null })} title="Remove this filter">
              {c.label}
              <span aria-hidden className="text-brand-500">✕</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
