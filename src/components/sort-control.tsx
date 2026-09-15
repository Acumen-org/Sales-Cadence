'use client';

import { useFilterNavigation } from './filter-navigation';
import { IconArrowDown, IconArrowUp } from './icons';
import type { SortDirection } from '@/lib/sorting';

export type SortOption = { value: string; label: string };

/**
 * One control, not two: the field is a menu and the direction is the arrow beside it, the way
 * every list that sorts does it. Choosing a different field drops the explicit direction, so the
 * section's own default for that field applies: a date newest first, a name A-Z.
 */
export function SortControl({ value, dir, options, defaultValue, label = 'Sort', keep }: { value: string; dir: SortDirection; options: SortOption[]; defaultValue: string; label?: string; /** Params the section needs on every URL it builds, such as the open tab. */ keep?: Record<string, string> }) {
  const navigate = useFilterNavigation();
  const apply = (mutate: (next: URLSearchParams) => void) =>
    navigate((next) => {
      mutate(next);
      for (const [key, param] of Object.entries(keep ?? {})) next.set(key, param);
      next.delete('page');
      next.delete('before');
    });
  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-[10px] border border-line bg-white focus-within:border-brand-400 focus-within:ring-4 focus-within:ring-brand-100/70">
      <select
        value={value}
        aria-label={label}
        onChange={(e) =>
          apply((next) => {
            if (e.target.value === defaultValue) next.delete('sort');
            else next.set('sort', e.target.value);
            next.delete('dir');
          })
        }
        className="!w-auto !rounded-none !border-0 !bg-transparent !py-2 !text-[12.5px] focus:!border-0 focus:!ring-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label={`Sort direction: ${dir === 'asc' ? 'ascending' : 'descending'}`}
        title={dir === 'asc' ? 'Ascending - click to reverse' : 'Descending - click to reverse'}
        onClick={() => apply((next) => {
          const field = next.get('sort') ?? defaultValue;
          const fallback = field === value ? dir : ['name', 'company', 'tier'].includes(field) ? 'asc' : 'desc';
          const current = next.get('dir') ?? fallback;
          next.set('dir', current === 'asc' ? 'desc' : 'asc');
        })}
        className="flex items-center border-l border-line px-2 text-ink-600 hover:bg-canvas hover:text-ink-900 focus-visible:bg-canvas"
      >
        {dir === 'asc' ? <IconArrowUp size={14} /> : <IconArrowDown size={14} />}
      </button>
    </div>
  );
}

/**
 * A column header that sorts: click the one you want, click it again to reverse. The arrow only
 * shows on the column in force, so the header row stays a header row.
 */
export function SortableHeader({ field, label, sort, dir, defaultValue, defaultDir = 'desc', className }: { field: string; label: string; sort: string; dir: SortDirection; defaultValue: string; defaultDir?: SortDirection; className?: string }) {
  const navigate = useFilterNavigation();
  const active = sort === field;
  return (
    <th className={className} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() =>
          navigate((next) => {
            const currentField = next.get('sort') ?? defaultValue;
            const currentDir = next.get('dir') ?? (currentField === sort ? dir : defaultDir);
            const nextDir = currentField === field ? (currentDir === 'asc' ? 'desc' : 'asc') : defaultDir;
            if (field === defaultValue) next.delete('sort');
            else next.set('sort', field);
            next.set('dir', nextDir);
            next.delete('page');
            next.delete('before');
          })
        }
        title={`Sort by ${label.toLowerCase()}`}
        className={`group inline-flex max-w-full items-baseline gap-1 rounded text-left focus-visible:ring-2 focus-visible:ring-brand-300 ${active ? 'text-ink-900' : 'hover:text-ink-900'}`}
      >
        <span>{label}</span>
        {active ? (
          dir === 'asc' ? <IconArrowUp size={12} className="shrink-0 text-brand-600" /> : <IconArrowDown size={12} className="shrink-0 text-brand-600" />
        ) : (
          <IconArrowDown size={12} className="shrink-0 text-ink-300 opacity-0 transition group-hover:opacity-100" />
        )}
      </button>
    </th>
  );
}
