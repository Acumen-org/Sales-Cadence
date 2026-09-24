'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { pickAllIdsAction, pickPeopleAction, pickerOptionsAction, type PickerFilters, type PickerOptions, type PickerRow } from '@/lib/actions/people-picker';
import { IconFilter, IconSearch } from '@/components/icons';
import { Badge, Count, TierBadge } from '@/components/ui';
import { optionLabel } from '@/lib/twenty/labels';
import { PRIORITY_LABELS } from '@/lib/campaign-planner';

type Props = { campaignPodId?: string; campaignFoIds?: string[]; campaignId?: string; value: string[]; onChange: (ids: string[]) => void; withinIds?: string[]; initialPod?: string; disabledIds?: string[]; disabledReason?: string };

const STATE_TONE: Record<PickerRow['state'], 'gray' | 'green' | 'blue' | 'amber' | 'red'> = { 'Never in a campaign': 'gray', 'In a campaign': 'green', Replied: 'blue', Finished: 'amber', 'Do not contact': 'red' };

/**
 * Choosing a campaign's people from the directory: the same filters as People, a page of a
 * hundred at a time, and "select all" that means every person the filters match, however many.
 * The selection lives in the parent as a list of ids; this keeps the latest copy in a ref so a
 * late search response can never overwrite a tick made while it was in flight.
 */
export function PeoplePicker({ campaignPodId, campaignFoIds, campaignId, value, onChange, withinIds, initialPod, disabledIds = [], disabledReason = 'Assigned to another outreach group' }: Props) {
  const foKey = JSON.stringify(campaignFoIds ?? []);
  const [selectionNotice, setSelectionNotice] = useState('');
  const latest = useRef(value);
  latest.current = value;
  const [options, setOptions] = useState<PickerOptions | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [filters, setFilters] = useState<PickerFilters>({ q: '', pod: initialPod ?? '', fo: '', product: '', tier: '', type: '', tag: '', account: '', state: 'any', priority: [], page: 1 });
  const moreCount = [filters.tier, filters.type, filters.product, filters.tag].filter(Boolean).length;
  const [text, setText] = useState('');
  const [rows, setRows] = useState<PickerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [selectingAll, setSelectingAll] = useState(false);
  const request = useRef(0);

  useEffect(() => { void pickerOptionsAction().then(setOptions); }, []);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === text ? f : { ...f, q: text, page: 1 })), 300);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    const id = ++request.current;
    start(async () => {
      const r = await pickPeopleAction({ ...filters, withinIds, campaignPodId, campaignFoIds: JSON.parse(foKey), campaignId });
      // An older answer arriving after a newer one is dropped.
      if (id !== request.current) return;
      if (r.ok) { setRows(r.rows); setTotal(r.total); setPageSize(r.pageSize); setError(null); }
      else setError(r.error);
    });
  }, [filters, withinIds, campaignPodId, foKey, campaignId]);

  const set = (patch: Partial<PickerFilters>) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  const selected = new Set(value);
  const disabled = new Set([...disabledIds, ...rows.filter(r => r.ineligibleReason).map(r => r.id)]);
  const available = rows.filter(r => !disabled.has(r.id));
  const shownSelected = available.length > 0 && available.every((r) => selected.has(r.id));
  const toggle = (id: string) => {
    // Someone who cannot join can still be taken out; they just cannot be ticked.
    if (disabled.has(id) && !latest.current.includes(id)) return;
    const next = new Set(latest.current);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  };
  const toggleShown = () => {
    const next = new Set(latest.current);
    if (shownSelected) for (const r of available) next.delete(r.id); else for (const r of available) next.add(r.id);
    onChange([...next]);
  };
  const selectAll = async () => {
    setSelectingAll(true);
    try {
      const r = await pickAllIdsAction({ ...filters, withinIds, campaignPodId, campaignFoIds: JSON.parse(foKey), campaignId });
      if (r.ok) { onChange([...new Set([...latest.current, ...r.ids.filter(id => !disabled.has(id))])]); setSelectionNotice(r.skipped ? `${r.skipped === 1 ? "1 person can't join this campaign and wasn't" : `${r.skipped.toLocaleString('en-US')} people can't join this campaign and weren't`} added` : ''); }
      else setError(r.error);
    } finally {
      setSelectingAll(false);
    }
  };
  const first = (filters.page - 1) * pageSize + 1;
  const last = Math.min(filters.page * pageSize, total);

  const Select = ({ name, label, all, items }: { name: keyof PickerFilters; label: string; all: string; items: { value: string; label: string }[] }) => (
    <select value={String(filters[name])} onChange={(e) => set({ [name]: e.target.value } as Partial<PickerFilters>)} aria-label={label} className="!w-auto !py-1.5 !text-[12.5px]">
      <option value="">{all}</option>
      {items.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
    </select>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-[220px]">
          <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search people" aria-label="Search people to add" className="!pl-9 !py-1.5" />
        </div>
        {options ? (
          <>
            <Select name="pod" label="Filter by pod" all="All pods" items={options.pods.map((p) => ({ value: p.value, label: p.name }))} />
            <Select name="fo" label="Filter by FO" all="All FOs" items={options.fos.map((f) => ({ value: f.id, label: f.name }))} />
            <select value={filters.state} onChange={(e) => set({ state: e.target.value as PickerFilters['state'] })} aria-label="Campaign state" className="!w-auto !max-w-[190px] !py-1.5 !text-[12.5px]">
              <option value="cold">Never in a campaign</option>
              <option value="enrolled">In a campaign</option>
              <option value="any">Any campaign state</option>
            </select>
            <PriorityFilter value={filters.priority} onChange={priority => set({ priority })} />
            <button type="button" onClick={() => setShowMore(!showMore)} aria-expanded={showMore} className={`btn-secondary btn-sm ${showMore || moreCount ? '!border-brand-300 !bg-brand-50 !text-brand-800' : ''}`}>
              <IconFilter size={14} /> Filters{moreCount ? <span className="ml-1 tabular-nums">{moreCount}</span> : null}
            </button>
            {showMore || moreCount ? <div className="flex w-full flex-wrap items-center gap-2 rounded-[10px] border border-line bg-canvas/70 p-2">
              <Select name="tier" label="Filter by tier" all="Any tier" items={options.tiers.map((t) => ({ value: t, label: optionLabel(t) }))} />
              <Select name="type" label="Filter by contact type" all="Any type" items={options.types.map((t) => ({ value: t, label: optionLabel(t) }))} />
              <Select name="product" label="Filter by product" all="Any product" items={options.products.map((p) => ({ value: p, label: optionLabel(p) }))} />
              {options.tags.length ? <Select name="tag" label="Filter by Twenty tag" all="Any tag" items={options.tags.map((t) => ({ value: t, label: optionLabel(t) }))} /> : null}
            </div> : null}
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-ink-600">
        <span><Count value={total} /> matching{total > 0 ? <span className="text-ink-400"> · {first.toLocaleString('en-US')}–{last.toLocaleString('en-US')}</span> : null}</span>
        <button type="button" className="btn-secondary btn-sm" disabled={pending || selectingAll || total === 0} onClick={() => void selectAll()}>
          {selectingAll ? 'Selecting…' : 'Select all matching'}
        </button>
        {selectionNotice && <span role="status" className="text-ink-500">{selectionNotice}</span>}
        <span className="ml-auto flex items-center gap-2">
          <span><Count value={value.length} /> selected</span>
          {value.length ? <button type="button" className="btn-ghost btn-sm" onClick={() => onChange([])}>Clear selection</button> : null}
        </span>
      </div>

      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}

      <div className={pending ? 'opacity-60 transition' : 'transition'}>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="table table-dense w-full table-fixed">
            <colgroup><col className="w-9" /><col style={{ width: '44%' }} /><col style={{ width: '18%' }} /><col style={{ width: '14%' }} /><col style={{ width: '20%' }} /></colgroup>
            <thead>
              <tr>
                <th className="pl-3 pr-0"><input type="checkbox" aria-label="Select everyone shown" checked={shownSelected} onChange={toggleShown} disabled={!available.length} /></th>
                <th>Person</th>
                <th>Pod</th>
                <th>Tier</th>
                <th>Campaign</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected.has(r.id) && !disabled.has(r.id) ? 'bg-brand-50/60' : undefined} title={r.ineligibleReason ?? (disabled.has(r.id) ? disabledReason : undefined)}>
                  <td className="pl-3 pr-0"><input type="checkbox" aria-label={`Select ${r.name}`} disabled={disabled.has(r.id) && !selected.has(r.id)} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td>
                    <div className={`truncate text-[13px] font-medium ${disabled.has(r.id) ? 'text-ink-400' : 'text-ink-900'}`}>{r.name}</div>
                    {r.ineligibleReason ? <div className={`truncate text-[12px] ${r.state === 'Do not contact' ? 'text-red-700' : 'text-ink-600'}`}>{r.ineligibleReason}{r.company ? <span className="text-ink-400"> · {r.company}</span> : null}</div> : r.title || r.company ? <div className={`truncate text-[12px] ${disabled.has(r.id) ? 'text-ink-400' : 'text-ink-500'}`}>{[r.title, r.company].filter(Boolean).join(' · ')}</div> : null}
                  </td>
                  <td className="truncate text-[12.5px] text-ink-700">{r.pod ?? <span className="text-ink-300">-</span>}</td>
                  <td><TierBadge tier={r.tier} /></td>
                  <td><Badge tone={STATE_TONE[r.state]}>{r.state}</Badge></td>
                </tr>
              ))}
              {!rows.length && !pending ? <tr><td colSpan={5} className="py-8 text-center text-[13px] text-ink-400">Nobody matches these filters</td></tr> : null}
            </tbody>
          </table>
        </div>
        {total > pageSize ? (
          <div className="mt-2 flex items-center justify-between text-[12.5px] text-ink-500">
            <span>Page {filters.page} of {Math.ceil(total / pageSize)}</span>
            <span className="flex gap-2">
              <button type="button" className="btn-secondary btn-sm" disabled={pending || filters.page === 1} onClick={() => set({ page: filters.page - 1 })}>Previous page</button>
              <button type="button" className="btn-secondary btn-sm" disabled={pending || last >= total} onClick={() => set({ page: filters.page + 1 })}>Next page</button>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The planner's priority groups as one multi-choice control; a contact in any chosen group matches. */
function PriorityFilter({ value, onChange }: { value: number[]; onChange: (groups: number[]) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  const label = value.length ? [...value].sort().map(g => PRIORITY_LABELS[g]).join(', ') : 'Any priority';
  return (
    <div ref={box} className="relative">
      <button type="button" aria-haspopup="true" aria-expanded={open} aria-label="Filter by priority" onClick={() => setOpen(!open)} className={`btn-secondary btn-sm max-w-[240px] ${value.length ? '!border-brand-300 !bg-brand-50 !text-brand-800' : ''}`}>
        <span className="truncate">{label}</span>
      </button>
      {open ? (
        <div role="group" aria-label="Priority" className="absolute left-0 top-full z-20 mt-1 w-48 rounded-[10px] border border-line bg-white p-1.5 shadow-lg">
          {PRIORITY_LABELS.map((name, g) => (
            <label key={name} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-canvas">
              <input type="checkbox" checked={value.includes(g)} onChange={() => onChange(value.includes(g) ? value.filter(x => x !== g) : [...value, g])} />
              {name}
            </label>
          ))}
          {value.length ? <button type="button" className="btn-ghost btn-sm mt-1 w-full justify-start" onClick={() => onChange([])}>Any priority</button> : null}
        </div>
      ) : null}
    </div>
  );
}
