'use client';

import { useFilterNavigation } from '@/components/filter-navigation';

type Option = { value: string; label: string };

/**
 * Moves to CRM's filters on one row, as Campaigns has them: pod, what happened, who moved. Each
 * applies as it is chosen. Pod opens on the reader's own, so "All pods" is kept as an empty value.
 */
export function MovesToolbar({ pod, podDefault, state, mover, pods, movers }: { pod: string; podDefault: string; state: string; mover: string; pods: Option[]; movers: Option[] }) {
  const navigate = useFilterNavigation();
  const set = (key: string, value: string) => navigate((next) => {
    if (value || key === 'pod') next.set(key, value); else next.delete(key);
  });
  const active = Boolean(state || mover || pod !== podDefault);
  const select = (key: string, value: string, label: string, all: string, items: Option[]) => (
    <select value={value} onChange={(e) => set(key, e.target.value)} aria-label={label} className="!w-auto !max-w-[220px] !py-2 !text-[12.5px]">
      <option value="">{all}</option>
      {items.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
    </select>
  );
  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      {select('pod', pod, 'Pod', 'All pods', pods)}
      {select('state', state, 'What happened', 'Every move', [{ value: 'failed', label: 'With failures' }, { value: 'running', label: 'Still moving' }, { value: 'undone', label: 'With undos' }])}
      {select('mover', mover, 'Moved by', 'Anyone', movers)}
      {active ? <button type="button" className="btn-ghost btn-sm" onClick={() => navigate((next) => { for (const k of [...next.keys()]) next.delete(k); })}>Reset</button> : null}
    </div>
  );
}
