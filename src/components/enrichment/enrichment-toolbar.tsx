'use client';
import Link from 'next/link';
import { useId, useState } from 'react';
import { SortControl } from '@/components/sort-control';
import { useFilterNavigation } from '@/components/filter-navigation';
import { useSearchBox } from '@/components/search-box';
import { IconFilter, IconSearch } from '@/components/icons';
import { optionLabel } from '@/lib/twenty/labels';

export type EnrichmentToolbarProps = {
  tab: string;
  q: string;
  fields: { field: string; label: string }[];
  wanted: string[];
  pods: { value: string; name: string }[];
  fos: { id: string; name: string }[];
  tiers: string[];
  types: string[];
  products: string[];
  tags: string[];
  accounts: { id: string; name: string }[];
  values: { pod: string; fo: string; tier: string; type: string; product: string; tag: string; account: string; priority: string; campaign: string; marks: string };
  sort: string;
  dir: 'asc' | 'desc';
  exportHref: string;
  /** Contacts carry tier, type, product, tag and campaign; accounts do not. */
  contacts: boolean;
};

/**
 * One row: search, pod, FO, what is missing (chosen one kind at a time, shown as removable chips;
 * several together mean "lacks any of these"), the sort, and a Filters button for the rest -
 * account, tier, type, product, campaign, Twenty tag, priority, and whether the view shows open
 * gaps or the ones marked not found. Every change applies at once through the shared navigation,
 * so a filter never loses a search typed a moment before.
 */
export function EnrichmentToolbar({ tab, q, fields, wanted, pods, fos, tiers, types, products, tags, accounts, values, sort, dir, exportHref, contacts }: EnrichmentToolbarProps) {
  const navigate = useFilterNavigation();
  const panelId = useId();
  const more = [values.account, values.tier, values.type, values.product, values.campaign, values.tag, values.priority, values.marks].filter(Boolean).length;
  const [showMore, setShowMore] = useState(() => more > 0);
  const push = (mutate: (next: URLSearchParams) => void) => {
    navigate((next) => {
      mutate(next);
      next.set('tab', tab);
      next.delete('page');
    });
  };
  const set = (name: string, value: string) => push((next) => { if (value) next.set(name, value); else next.delete(name); });
  const { text, setText, reset } = useSearchBox(q, (value) => set('q', value ?? ''));

  const remaining = fields.filter(({ field }) => !wanted.includes(field));
  const label = (field: string) => fields.find((f) => f.field === field)?.label ?? field;
  const active = Boolean(q || wanted.length || sort !== 'name' || values.pod || values.fo || more);
  const Select = ({ name, value, title, all, options }: { name: string; value: string; title: string; all: string; options: { value: string; label: string }[] }) => (
    <select value={value} onChange={(e) => set(name, e.target.value)} aria-label={title} className="!w-auto !py-2 !text-[12.5px]" disabled={!options.length && !value}>
      <option value="">{all}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  const plain = (list: string[]) => list.map((v) => ({ value: v, label: optionLabel(v) }));

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-[220px]">
          <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or account" aria-label="Search records to enrich" className="!pl-9" />
        </div>
        <Select name="pod" value={values.pod} title="Filter by pod" all="All pods" options={pods.map((p) => ({ value: p.value, label: p.name }))} />
        <Select name="fo" value={values.fo} title="Filter by FO" all="All FOs" options={fos.map((f) => ({ value: f.id, label: f.name }))} />
        <select value="" onChange={(e) => { const field = e.target.value; if (field) push((next) => next.append('field', field)); }} aria-label="Missing information" className="!w-auto !py-2 !text-[12.5px]">
          <option value="">{wanted.length ? 'Missing any of...' : 'Missing information'}</option>
          {remaining.map(({ field, label: name }) => <option key={field} value={field}>{name}</option>)}
        </select>
        {wanted.map((field) => (
          <button key={field} type="button" className="chip" onClick={() => push((next) => { const keep = next.getAll('field').filter((f) => f !== field); next.delete('field'); for (const f of keep) next.append('field', f); })} title="Remove this filter">
            {label(field)} missing <span aria-hidden className="text-brand-500">×</span>
          </button>
        ))}
        <button type="button" onClick={() => setShowMore(!showMore)} aria-expanded={showMore} aria-controls={panelId} className={`btn-secondary btn-sm ${showMore || more ? '!border-brand-300 !bg-brand-50 !text-brand-800' : ''}`}>
          <IconFilter size={14} /> Filters{more ? <span className="ml-1 tabular-nums">{more}</span> : null}
        </button>
        <SortControl
          value={sort}
          dir={dir}
          defaultValue="name"
          label="Sort"
          keep={{ tab }}
          options={[
            { value: 'name', label: 'Sort: name' },
            { value: 'company', label: 'Sort: account' },
            { value: 'gaps', label: 'Sort: missing fields' },
            { value: 'synced', label: 'Sort: last synced' },
          ]}
        />
        {active ? <Link href={`/enrichment?tab=${tab}`} onClick={() => reset()} className="btn-ghost btn-sm">Reset</Link> : null}
        <a href={exportHref} className="btn-secondary btn-sm ml-auto">Export to enrich</a>
      </div>
      {showMore ? (
        <div id={panelId} className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Select name="account" value={values.account} title="Filter by account" all="Any account" options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
          {contacts ? <>
            <Select name="tier" value={values.tier} title="Filter by tier" all="Any tier" options={plain(tiers)} />
            <Select name="type" value={values.type} title="Filter by contact type" all="Any type" options={plain(types)} />
            <Select name="product" value={values.product} title="Filter by product" all="Any product" options={plain(products)} />
            <Select name="campaign" value={values.campaign} title="Filter by campaign" all="In or out of campaigns" options={[{ value: 'any', label: 'In a campaign' }, { value: 'none', label: 'Not in a campaign' }]} />
            <Select name="tag" value={values.tag} title="Filter by Twenty tag" all="Any Twenty tag" options={plain(tags)} />
          </> : null}
          <Select name="priority" value={values.priority} title="Filter by priority" all="Any priority" options={[{ value: 'critical', label: 'Critical' }, { value: 'useful', label: 'Useful only' }]} />
          <Select name="marks" value={values.marks} title="Show open or not-found gaps" all="Open gaps" options={[{ value: 'notfound', label: 'Marked not found' }]} />
        </div>
      ) : null}
    </div>
  );
}
