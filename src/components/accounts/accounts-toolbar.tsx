'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { IconSearch } from '@/components/icons';
import { optionLabel } from '@/lib/twenty/labels';

type Props = {
  q: string;
  scope: 'all' | 'mine';
  mineCount: number;
  allCount: number;
  pods: { podOwnerValue: string; name: string }[];
  fos: { id: string; name: string }[];
  products: string[];
  pod: string;
  fo: string;
  product: string;
  sort: string;
};

const SORTS = [
  { value: 'name', label: 'Sort: name' },
  { value: 'people', label: 'Sort: most people' },
  { value: 'inSequence', label: 'Sort: most in sequence' },
  { value: 'replied', label: 'Sort: most replies' },
  { value: 'lastTouch', label: 'Sort: last touch' },
];

/** Filters whose "All" is a choice worth keeping in the URL, because the section has a default. */
const EXPLICIT = new Set(['pod', 'fo']);

export function AccountsToolbar({ q, scope, mineCount, allCount, pods, fos, products, pod, fo, product, sort }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(q);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else if (EXPLICIT.has(k)) next.set(k, '');
      else next.delete(k);
    }
    router.push(`${pathname}?${next.toString()}`);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== q) update({ q: text || null });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const withScope = (s: 'all' | 'mine') => {
    const next = new URLSearchParams(params.toString());
    if (s === 'mine') next.set('scope', 'mine');
    else next.delete('scope');
    return `${pathname}?${next.toString()}`;
  };

  const chips = [
    pod ? { key: 'pod', label: `Pod is ${pods.find((p) => p.podOwnerValue === pod)?.name ?? optionLabel(pod)}` } : null,
    fo ? { key: 'fo', label: `FO is ${fos.find((f) => f.id === fo)?.name ?? fo}` } : null,
    product ? { key: 'product', label: optionLabel(product) } : null,
  ].filter((x): x is { key: string; label: string } => Boolean(x));

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, domain, industry, city" aria-label="Search accounts" className="!pl-9" />
      </div>
      <Link href={withScope('all')} className={scope === 'all' ? 'chip' : 'chip-muted'}>
        All <span className="ml-0.5 opacity-60">{allCount}</span>
      </Link>
      <Link href={withScope('mine')} className={scope === 'mine' ? 'chip' : 'chip-muted'}>
        Mine <span className="ml-0.5 opacity-60">{mineCount}</span>
      </Link>
      {chips.map((c) => (
        <button key={c.key} type="button" className="chip" onClick={() => update({ [c.key]: null })} title="Remove this filter">
          {c.label}
          <span aria-hidden className="text-brand-500">✕</span>
        </button>
      ))}
      <select value={pod} onChange={(e) => update({ pod: e.target.value || null })} aria-label="Filter by pod" className="!w-auto !py-2 !text-[12.5px]">
        <option value="">All pods</option>
        {pods.map((p) => <option key={p.podOwnerValue} value={p.podOwnerValue}>{p.name}</option>)}
      </select>
      {fos.length ? (
        <select value={fo} onChange={(e) => update({ fo: e.target.value || null })} aria-label="Filter by FO" className="!w-auto !py-2 !text-[12.5px]">
          <option value="">All FOs</option>
          {fos.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      ) : null}
      <select value={product} onChange={(e) => update({ product: e.target.value || null })} aria-label="Filter by product interest" className="!w-auto !py-2 !text-[12.5px]">
        <option value="">Any product</option>
        {products.map((p) => <option key={p} value={p}>{optionLabel(p)}</option>)}
      </select>
      {/* "Most people" is the default order (DEFAULT_ACCOUNT_SORT), so it leaves the URL clean. */}
      <select value={sort} onChange={(e) => update({ sort: e.target.value === 'people' ? null : e.target.value })} aria-label="Sort accounts" className="!w-auto !py-2 !text-[12.5px]">
        {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
    </div>
  );
}
