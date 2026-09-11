'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { pickPeopleAction, pickerOptionsAction, type PickerFilters, type PickerOptions, type PickerRow } from '@/lib/actions/people-picker';
import { optionLabel } from '@/lib/twenty/labels';
import { IconSearch } from '@/components/icons';
import { Badge, Count, Empty } from '@/components/ui';

const STATES: { value: PickerFilters['state']; label: string }[] = [
  { value: 'cold', label: 'Never enrolled' },
  { value: 'finished', label: 'Finished a sequence' },
  { value: 'enrolled', label: 'In a sequence now' },
  { value: 'any', label: 'Any state' },
];

const STATE_TONE: Record<PickerRow['state'], 'green' | 'blue' | 'gray' | 'red' | 'amber'> = {
  'Never enrolled': 'gray',
  'In a sequence': 'blue',
  Replied: 'green',
  Finished: 'gray',
  'Do not contact': 'red',
};

/**
 * Choose a campaign's people from the directory: the People filters, a table, tick boxes, and
 * "everyone matching" for the whole list. What is chosen is a set of ids the form submits the way
 * pasted ids always were, so the server side does not change.
 */
export function PeoplePicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [options, setOptions] = useState<PickerOptions | null>(null);
  const [filters, setFilters] = useState<PickerFilters>({ q: '', pod: '', fo: '', product: '', tier: '', type: '', state: 'cold' });
  const [text, setText] = useState('');
  const [rows, setRows] = useState<PickerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [matchingIds, setMatchingIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const selected = useMemo(() => new Set(value), [value]);

  useEffect(() => {
    pickerOptionsAction().then(setOptions).catch(() => setOptions({ pods: [], fos: [], tiers: [], types: [], products: [] }));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === text ? f : { ...f, q: text })), 300);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    start(async () => {
      const r = await pickPeopleAction(filters);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setError(null);
      setRows(r.rows);
      setTotal(r.total);
      setMatchingIds(r.ids);
    });
  }, [filters]);

  const toggle = (id: string) => onChange(selected.has(id) ? value.filter((x) => x !== id) : [...value, id]);
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const set = (patch: Partial<PickerFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const Select = ({ name, label, all, items }: { name: keyof PickerFilters; label: string; all: string; items: { value: string; label: string }[] }) => (
    <select value={String(filters[name])} onChange={(e) => set({ [name]: e.target.value } as Partial<PickerFilters>)} aria-label={label} className="!w-auto !py-1.5 !text-[12.5px]">
      <option value="">{all}</option>
      {items.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
    </select>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, company, email" aria-label="Search people to add" className="!pl-9 !py-1.5" />
        </div>
        <Select name="pod" label="Pick by pod" all="All pods" items={(options?.pods ?? []).map((p) => ({ value: p.value, label: p.name }))} />
        <Select name="fo" label="Pick by FO" all="All FOs" items={(options?.fos ?? []).map((f) => ({ value: f.id, label: f.name }))} />
        <Select name="product" label="Pick by product" all="Any product" items={(options?.products ?? []).map((v) => ({ value: v, label: optionLabel(v) }))} />
        <Select name="tier" label="Pick by tier" all="Any tier" items={(options?.tiers ?? []).map((v) => ({ value: v, label: optionLabel(v) }))} />
        <Select name="type" label="Pick by type" all="Any type" items={(options?.types ?? []).map((v) => ({ value: v, label: optionLabel(v) }))} />
        <select value={filters.state} onChange={(e) => set({ state: e.target.value as PickerFilters['state'] })} aria-label="Pick by sequence state" className="!w-auto !py-1.5 !text-[12.5px]">
          {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-ink-600">
        <span><Count value={total} /> matching{rows.length < total ? <span className="text-ink-400"> · showing the first {rows.length}</span> : null}</span>
        <button type="button" className="btn-secondary btn-sm" disabled={!matchingIds.length} onClick={() => onChange([...new Set([...value, ...matchingIds])])}>
          Select everyone matching{total > matchingIds.length ? ` (first ${matchingIds.length})` : ''}
        </button>
        <span className="ml-auto flex items-center gap-2"><Badge tone={value.length ? 'green' : 'gray'}>{value.length} selected</Badge>{value.length ? <button type="button" className="btn-ghost btn-sm" onClick={() => onChange([])}>Clear</button> : null}</span>
      </div>

      {error ? <p role="alert" className="text-[13px] text-red-700">{error}</p> : null}
      <div className={pending ? 'opacity-60 transition' : 'transition'}>
        <div className="max-h-[420px] overflow-auto scroll-thin rounded-xl border border-line">
          <table className="table">
            <thead>
              <tr>
                <th className="w-9 pl-4 pr-0"><input type="checkbox" aria-label="Select everyone shown" checked={allShownSelected} onChange={() => onChange(allShownSelected ? value.filter((id) => !rows.some((r) => r.id === id)) : [...new Set([...value, ...rows.map((r) => r.id)])])} /></th>
                <th>Person</th>
                <th>Company</th>
                <th>Pod</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? 'bg-brand-50/40' : undefined}>
                  <td className="pl-4 pr-0"><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td><span className="font-medium text-ink-900">{r.name}</span>{r.title ? <span className="block text-[12px] text-ink-500">{r.title}</span> : null}</td>
                  <td className="text-[12.5px]">{r.company ?? <Empty />}</td>
                  <td className="text-[12.5px]">{r.pod ?? <Empty />}</td>
                  <td><Badge tone={STATE_TONE[r.state]}>{r.state}</Badge></td>
                </tr>
              ))}
              {!rows.length && !pending ? <tr><td colSpan={5} className="py-8 text-center text-[13px] text-ink-400">Nobody matches these filters</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
