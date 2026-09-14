'use client';
import { useFilterNavigation } from './filter-navigation';
import type { SortDirection as Direction } from '@/lib/sorting';
export function SortDirection({ value }: { value: Direction }) {
  const navigate = useFilterNavigation();
  return <select aria-label="Sort direction" value={value} onChange={e => navigate(next => { next.set('dir', e.target.value); next.delete('page'); next.delete('before'); })} className="!w-auto !py-2 !text-[12.5px]">
    <option value="asc">Ascending</option><option value="desc">Descending</option>
  </select>;
}
