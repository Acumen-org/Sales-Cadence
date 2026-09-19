'use client';
import { SortControl } from '@/components/sort-control';

import { useFilterNavigation } from '@/components/filter-navigation';
import { useSearchBox } from '@/components/search-box';
import { IconSearch } from '@/components/icons';
import { optionLabel } from '@/lib/twenty/labels';

type Props = {
  q: string;
  pods: { podOwnerValue: string; name: string }[];
  fos: { id: string; name: string }[];
  products: string[];
  pod: string;
  fo: string;
  product: string;
  campaign: string;
  sort: string;
  dir: 'asc' | 'desc';
};

const SORTS = [
  { value: 'people', label: 'Sort: people' },
  { value: 'name', label: 'Sort: name' },
  { value: 'inSequence', label: 'Sort: in a campaign' },
  { value: 'replied', label: 'Sort: replies' },
  { value: 'lastTouch', label: 'Sort: last touch' },
];

/** Filters whose "All" is a choice worth keeping in the URL, because the section has a default. */
const EXPLICIT = new Set(['pod', 'fo']);

export function AccountsToolbar({ q, pods, fos, products, pod, fo, product, campaign, sort, dir }: Props) {
  const navigate = useFilterNavigation();

  const update = (patch: Record<string, string | null>) => {
    navigate((next) => {
    next.delete('page');
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else if (EXPLICIT.has(k)) next.set(k, '');
      else next.delete(k);
    }
    });
  };

  const { text, setText } = useSearchBox(q, (value) => update({ q: value }));

  const chips = [
    pod ? { key: 'pod', label: `Pod is ${pods.find((p) => p.podOwnerValue === pod)?.name ?? optionLabel(pod)}` } : null,
    fo ? { key: 'fo', label: `FO is ${fos.find((f) => f.id === fo)?.name ?? fo}` } : null,
    product ? { key: 'product', label: optionLabel(product) } : null,
    campaign ? { key: 'campaign', label: campaign === 'any' ? 'Someone in a campaign' : campaign === 'all' ? 'Everyone in a campaign' : 'Nobody in a campaign' } : null,
  ].filter((x): x is { key: string; label: string } => Boolean(x));

  return (
    <div className="flex-1">
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name or domain" aria-label="Search accounts" className="!pl-9" />
      </div>
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
      <select value={campaign} onChange={(e) => update({ campaign: e.target.value || null })} aria-label="Filter by campaign membership" className="!w-auto !py-2 !text-[12.5px]">
        <option value="">In a campaign: any</option>
        <option value="any">Someone in a campaign</option>
        <option value="all">Everyone in a campaign</option>
        <option value="none">Nobody in a campaign</option>
      </select>
      {/* "Most people" is the default order (DEFAULT_ACCOUNT_SORT), so it leaves the URL clean. */}
      <SortControl value={sort} dir={dir} options={SORTS} defaultValue="people" label="Sort accounts" />
    </div>
    {chips.length ? (
      <div className="mt-2 flex flex-wrap items-center gap-2">
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
