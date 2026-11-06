'use client';
import { SortControl } from '@/components/sort-control';

import Link from 'next/link';
import { useFilterNavigation } from '@/components/filter-navigation';
import { useId, useState } from 'react';
import { useSearchBox } from '@/components/search-box';
import { IconFilter, IconSearch } from '@/components/icons';
import { optionLabel } from '@/lib/twenty/labels';
import { CONTACT_SOURCES, SOURCE_LABELS, ownerPatch, type ListView } from '@/lib/sandbox/list-view';

type Props = {
  variant?: 'crm';
  /** Only most-important people (Twenty's MIP tag). */
  mip?: boolean;
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
  dir: 'asc' | 'desc';
  tag: string; tags: string[]; listCategory: string;
  status: string;
  tier: string;
  type: string;
  /** Upcoming and running campaigns the reader can see, for the campaign filter. */
  campaigns: { id: string; name: string; kind: 'upcoming' | 'running' }[];
  campaign: string;
};

/**
 * Two kinds of filter, kept apart on purpose: what Twenty says about the person (pod, tier,
 * type, product interest) and what Cadence has done with them (FO, sequence state). Mixing them
 * into one "stage" dropdown was what made the old list read like a guess.
 */
const SEQUENCE_STATES = [
  { value: '', label: 'Any campaign state' },
  { value: 'cold', label: 'Never in a campaign' },
  { value: 'enrolled', label: 'In a campaign' },
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

/**
 * The directory's filter row: CRM people, or with `variant: 'cold'` Cold outreach's contacts (PLAN 4.1).
 * Both are one row that applies as it changes, with the filters in force as removable chips.
 */
export function PeopleToolbar(props: Props | ColdToolbarProps) {
  return props.variant === 'cold' ? <ColdToolbar {...props} /> : <CrmToolbar {...props} />;
}

function CrmToolbar({ pods, fos, products, tiers, types, q, pod, fo, product, sort, status, tier, type, dir, tag, tags, listCategory, campaigns, campaign, mip = false }: Props) {
  const navigate = useFilterNavigation();
  const panelId = useId();
  /** Open on arrival when the URL already carries one of these, so nothing filters invisibly. */
  const [showMore, setShowMore] = useState(() => Boolean(product || tier || type || tag || status));

  const update = (patch: Record<string, string | null>) => {
    navigate((next) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else if (EXPLICIT.has(k)) next.set(k, '');
      else next.delete(k);
    }
    next.delete('page');
    next.delete('list');
    });
  };

  const { text, setText } = useSearchBox(q, (value) => update({ q: value }));

  const activeChips = [
    tag ? { key: 'tag', label: optionLabel(tag) } : null,
    listCategory ? { key: 'listCategory', label: optionLabel(listCategory) } : null,
    pod ? { key: 'pod', label: `Pod is ${pods.find((p) => p.podOwnerValue === pod)?.name ?? optionLabel(pod)}` } : null,
    fo ? { key: 'fo', label: `FO is ${fos.find((f) => f.id === fo)?.name ?? fo}` } : null,
    campaign ? { key: 'campaign', label: `In ${campaigns.find((c) => c.id === campaign)?.name ?? 'a campaign'}` } : null,
    product ? { key: 'product', label: optionLabel(product) } : null,
    tier ? { key: 'tier', label: optionLabel(tier) } : null,
    type ? { key: 'type', label: optionLabel(type) } : null,
    status ? { key: 'status', label: SEQUENCE_STATES.find((s) => s.value === status)?.label ?? status } : null,
  ].filter((x): x is { key: string; label: string } => Boolean(x));

  /** What the CRM says about a person: kept behind one button so the bar stays a single row. */
  const moreCount = [product, tier, type, tag, status].filter(Boolean).length;

  const filterSelect = ({ name, value, label, options, all }: { name: string; value: string; label: string; options: string[]; all: string }) => (
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
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, company, email, phone" aria-label="Search people" className="!pl-9 !text-[12.5px]" />
      </div>

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
      {/* Always in the first row, even with nothing to choose: the filter is part of the bar, not a surprise. */}
      <select value={campaign} onChange={(e) => update({ campaign: e.target.value || null })} aria-label="Filter by campaign" className="!w-auto !max-w-[200px] !py-2 !text-[12.5px]" disabled={!campaigns.length}>
        <option value="">{campaigns.length ? 'Any campaign' : 'No campaigns yet'}</option>
        {campaigns.some((c) => c.kind === 'running') ? <optgroup label="Active">{campaigns.filter((c) => c.kind === 'running').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup> : null}
        {campaigns.some((c) => c.kind === 'upcoming') ? <optgroup label="Upcoming">{campaigns.filter((c) => c.kind === 'upcoming').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup> : null}
      </select>
      <button type="button" onClick={() => update({ mip: mip ? null : '1' })} aria-pressed={mip} className={`btn-secondary !text-[12.5px] ${mip ? '!border-brand-300 !bg-brand-50 !text-brand-800' : ''}`} title="Most-important people">MIP</button>
      <button type="button" onClick={() => setShowMore(!showMore)} aria-expanded={showMore} aria-controls={panelId} className={`btn-secondary !text-[12.5px] ${showMore || moreCount ? '!border-brand-300 !bg-brand-50 !text-brand-800' : ''}`}>
        <IconFilter size={14} /> Filters
        {moreCount ? <span className="rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold leading-[17px] text-white">{moreCount}</span> : null}
      </button>
      <SortControl value={sort} dir={dir} options={SORTS} defaultValue="name" label="Sort people" />

      {activeChips.length ? (
        <div className="flex w-full flex-wrap items-center gap-2">
          {activeChips.map((c) => (
            <button key={c.key} type="button" className="chip" onClick={() => update({ [c.key]: null })} title="Remove this filter">
              {c.label}
              <span aria-hidden className="text-brand-500">
                ✕
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div id={panelId} className={`${showMore ? 'flex' : 'hidden'} w-full flex-wrap items-center gap-2 rounded-[10px] border border-line bg-canvas/70 p-2`}>
        {filterSelect({ name: 'product', value: product, label: 'Filter by product interest', options: products, all: 'Any product' })}
        {filterSelect({ name: 'tier', value: tier, label: 'Filter by tier', options: tiers, all: 'Any tier' })}
        {filterSelect({ name: 'type', value: type, label: 'Filter by contact type', options: types, all: 'Any type' })}
        {filterSelect({ name: 'tag', value: tag, label: 'Filter by Twenty tag', options: tags, all: 'Any Twenty tag' })}
        <select value={status} onChange={(e) => update({ status: e.target.value || null })} aria-label="Filter by campaign state" className="!w-auto !py-2 !text-[12.5px]">
          {SEQUENCE_STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

type ColdToolbarProps = {
  variant: 'cold';
  q: string;
  /** The open quick view: choosing Mine or Unclaimed as the owner opens that view (N082). */
  view: ListView;
  /** The owner shown: the view's own when it fixes one. */
  owner: string;
  pod: string;
  source: string;
  /** Active sales reps only (B208). */
  owners: { id: string; name: string }[];
  pods: { id: string; name: string }[];
  /** The reader's pods: "Your pods" is a choice when there are several. */
  myPodIds: string[];
  /** The reader owns contacts (Mine), and looks after leavers' contacts (Needs a new owner). */
  offersMine: boolean;
  offersNeedsOwner: boolean;
  /** The filters in force, the role's defaults included, each a link that removes it (N081). */
  chips: { key: string; label: string; isDefault: boolean; href: string }[];
};

/**
 * Cold outreach's filter row: search, Owner, Pod and Source, applied as they change (B152). Search
 * looks at every status from the list's default view (N079); "Unclaimed" is an owner (N082).
 */
function ColdToolbar({ q, view, owner, pod, source, owners, pods, myPodIds, offersMine, offersNeedsOwner, chips }: ColdToolbarProps) {
  const navigate = useFilterNavigation();
  const update = (patch: Record<string, string | null>) =>
    navigate((next) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      // The old /sandbox filters are views now; the page, a flash and the old keys never outlive a change.
      for (const k of ['page', 'flash', 'flashTone', 'status', 'ready']) next.delete(k);
    });
  const { text, setText } = useSearchBox(q, (value) => update({ q: value }));
  const podValue = pod === 'mine' && myPodIds.length === 1 ? myPodIds[0] : pod;
  const select = '!w-auto !max-w-[200px] !py-2 !text-[12.5px]';

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, firm, email, phone" aria-label="Search contacts" className="!pl-9 !text-[12.5px]" />
      </div>
      <select value={owner} onChange={(e) => update(ownerPatch(e.target.value, view))} aria-label="Filter by owner" className={select}>
        <option value="">Every owner</option>
        {offersMine ? <option value="mine">Mine</option> : null}
        <option value="unclaimed">Unclaimed</option>
        {offersNeedsOwner ? <option value="needs_owner">Needs a new owner</option> : null}
        {owners.length ? <optgroup label="Sales reps">{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup> : null}
      </select>
      <select value={podValue} onChange={(e) => update({ pod: e.target.value })} aria-label="Filter by pod" className={select}>
        <option value="">All pods</option>
        {myPodIds.length > 1 ? <option value="mine">Your pods</option> : null}
        {pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select value={source} onChange={(e) => update({ source: e.target.value || null })} aria-label="Filter by source" className={select}>
        <option value="">Any source</option>
        {CONTACT_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
      </select>

      {chips.length ? (
        <div className="flex w-full flex-wrap items-center gap-2">
          {chips.map((c) => (
            <Link key={c.key} href={c.href} scroll={false} className="chip" title={c.isDefault ? 'Shown first for your role. Remove it to see more.' : 'Remove this filter'}>
              {c.label}
              <span aria-hidden className="text-brand-500">
                ✕
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
