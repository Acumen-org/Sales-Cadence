'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { IconSearch } from '@/components/icons';
import { optionLabel } from '@/lib/twenty/labels';

type Props = {
  pods: { podOwnerValue: string; name: string }[];
  fos: { id: string; name: string }[];
  /** Option values from the Twenty mapping, so the filters offer exactly what the CRM holds. */
  products: string[];
  tiers: string[];
  types: string[];
  q: string;
  pod: string;
  fo: string;
  product: string;
  sort: string;
  status: string;
  tier: string;
  type: string;
};

/**
 * Two kinds of filter, kept apart on purpose: what Twenty says about the person (pod, tier,
 * type, product interest) and what Cadence has done with them (FO, sequence state). Mixing them
 * into one "stage" dropdown was what made the old list read like a guess.
 */
const SEQUENCE_STATES = [
  { value: '', label: 'Any sequence state' },
  { value: 'cold', label: 'Never enrolled' },
  { value: 'enrolled', label: 'In a sequence' },
  { value: 'replied', label: 'Replied or meeting' },
  { value: 'unresponsive', label: 'Finished, no reply' },
  { value: 'bad_data', label: 'Contact details wrong' },
  { value: 'dnd', label: 'Do not contact' },
];

const SORTS = [
  { value: 'name', label: 'Sort: name' },
  { value: 'company', label: 'Sort: company' },
  { value: 'tier', label: 'Sort: tier' },
  { value: 'recent', label: 'Sort: recently updated' },
];

/** Filters whose "All" is a choice worth keeping in the URL, because the section has a default. */
const EXPLICIT = new Set(['pod', 'fo']);

export function PeopleToolbar({ pods, fos, products, tiers, types, q, pod, fo, product, sort, status, tier, type }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else if (EXPLICIT.has(k)) next.set(k, '');
      else next.delete(k);
    }
    next.delete('page');
    next.delete('list');
    router.push(`${pathname}?${next.toString()}`);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== q) update({ q: text || null });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const activeChips = [
    pod ? { key: 'pod', label: `Pod is ${pods.find((p) => p.podOwnerValue === pod)?.name ?? optionLabel(pod)}` } : null,
    fo ? { key: 'fo', label: `FO is ${fos.find((f) => f.id === fo)?.name ?? fo}` } : null,
    product ? { key: 'product', label: optionLabel(product) } : null,
    tier ? { key: 'tier', label: optionLabel(tier) } : null,
    type ? { key: 'type', label: optionLabel(type) } : null,
    status ? { key: 'status', label: SEQUENCE_STATES.find((s) => s.value === status)?.label ?? status } : null,
  ].filter((x): x is { key: string; label: string } => Boolean(x));

  const Select = ({ name, value, label, options, all }: { name: string; value: string; label: string; options: string[]; all: string }) => (
    <select value={value} onChange={(e) => update({ [name]: e.target.value || null })} aria-label={label} className="!w-auto !py-2 !text-[12.5px]">
      <option value="">{all}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {optionLabel(o)}
        </option>
      ))}
    </select>
  );

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, company, email, phone" aria-label="Search people" className="!pl-9" />
      </div>

      {activeChips.map((c) => (
        <button key={c.key} type="button" className="chip" onClick={() => update({ [c.key]: null })} title="Remove this filter">
          {c.label}
          <span aria-hidden className="text-brand-500">
            ✕
          </span>
        </button>
      ))}

      <select value={pod} onChange={(e) => update({ pod: e.target.value || null })} aria-label="Filter by pod" className="!w-auto !py-2 !text-[12.5px]">
        <option value="">All pods</option>
        {pods.map((p) => (
          <option key={p.podOwnerValue} value={p.podOwnerValue}>
            {p.name}
          </option>
        ))}
      </select>
      {fos.length ? (
        <select value={fo} onChange={(e) => update({ fo: e.target.value || null })} aria-label="Filter by FO" className="!w-auto !py-2 !text-[12.5px]">
          <option value="">All FOs</option>
          {fos.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      ) : null}
      <Select name="product" value={product} label="Filter by product interest" options={products} all="Any product" />
      <Select name="tier" value={tier} label="Filter by tier" options={tiers} all="Any tier" />
      <Select name="type" value={type} label="Filter by contact type" options={types} all="Any type" />
      <select value={status} onChange={(e) => update({ status: e.target.value || null })} aria-label="Filter by sequence state" className="!w-auto !py-2 !text-[12.5px]">
        {SEQUENCE_STATES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <select value={sort} onChange={(e) => update({ sort: e.target.value === 'name' ? null : e.target.value })} aria-label="Sort people" className="!w-auto !py-2 !text-[12.5px]">
        {SORTS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}
