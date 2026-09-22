'use client';

import { useId, useState } from 'react';
import { useFilterNavigation } from '@/components/filter-navigation';
import { useSearchBox } from '@/components/search-box';
import { IconFilter, IconSearch } from '@/components/icons';
import { optionLabel } from '@/lib/twenty/labels';
import { formatLocalDate } from '@/lib/dates';

type Props = {
  q: string;
  pods: { id: string; name: string }[];
  sequences: { id: string; name: string }[];
  fos: { id: string; name: string }[];
  products: string[];
  pod: string;
  sequence: string;
  fo: string;
  product: string;
  from: string;
  to: string;
};

/**
 * One row: search, pod, FO and a Filters button; sequence, product and the date range sit behind
 * it, and whatever is applied from there shows as chips in a row of their own. The tab stays
 * where it is.
 */
export function CampaignsToolbar({ q, pods, sequences, fos, products, pod, sequence, fo, product, from, to }: Props) {
  const navigate = useFilterNavigation();
  const [showMore, setShowMore] = useState(false);
  const panelId = useId();
  const update = (patch: Record<string, string | null>) =>
    navigate((next) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      next.delete('page');
    });
  const { text, setText, reset } = useSearchBox(q, (value) => update({ q: value }));
  const active = Boolean(q || pod || sequence || fo || product || from || to);
  const chips = [
    sequence ? { key: 'sequence', label: `Sequence: ${sequences.find((s) => s.id === sequence)?.name ?? sequence}` } : null,
    product ? { key: 'product', label: `Product: ${optionLabel(product)}` } : null,
    from ? { key: 'from', label: `From ${formatLocalDate(from)}` } : null,
    to ? { key: 'to', label: `To ${formatLocalDate(to)}` } : null,
  ].filter((c): c is { key: string; label: string } => c !== null);
  const Select = ({ name, value, label, all, items }: { name: string; value: string; label: string; all: string; items: { value: string; label: string }[] }) => (
    <select value={value} onChange={(e) => update({ [name]: e.target.value || null })} aria-label={label} className="!w-auto !max-w-[220px] !py-2 !text-[12.5px]">
      <option value="">{all}</option>
      {items.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
    </select>
  );
  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search campaigns" aria-label="Search campaigns" className="!pl-9" />
      </div>
      <Select name="pod" value={pod} label="Filter by pod" all="All pods" items={pods.map((p) => ({ value: p.id, label: p.name }))} />
      {fos.length ? <Select name="fo" value={fo} label="Filter by FO" all="All FOs" items={fos.map((f) => ({ value: f.id, label: f.name }))} /> : null}
      <button type="button" onClick={() => setShowMore(!showMore)} aria-expanded={showMore} aria-controls={panelId} className={`btn-secondary btn-sm ${showMore || chips.length ? '!border-brand-300 !bg-brand-50 !text-brand-800' : ''}`}>
        <IconFilter size={14} /> Filters
        {chips.length ? <span className="rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold leading-[17px] text-white">{chips.length}</span> : null}
      </button>
      {active ? <button type="button" onClick={() => { reset(); navigate((next) => { const tab = next.get('tab'); for (const key of [...next.keys()]) next.delete(key); if (tab) next.set('tab', tab); }); }} className="btn-ghost btn-sm">Reset</button> : null}

      <div id={panelId} className={`${showMore ? 'flex' : 'hidden'} w-full flex-wrap items-center gap-2 rounded-[10px] border border-line bg-canvas/70 p-2`}>
        <Select name="product" value={product} label="Filter by product" all="Any product" items={products.map((p) => ({ value: p, label: optionLabel(p) }))} />
        <label className="flex items-center gap-1.5 text-[12px] text-ink-500">From<input type="date" value={from} onChange={(e) => update({ from: e.target.value || null })} aria-label="Running from" className="!w-auto !py-1.5 !text-[12.5px]" /></label>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-500">To<input type="date" value={to} onChange={(e) => update({ to: e.target.value || null })} aria-label="Running to" className="!w-auto !py-1.5 !text-[12.5px]" /></label>
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
