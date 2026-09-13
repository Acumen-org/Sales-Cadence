'use client';

import Link from 'next/link';
import { useFilterNavigation } from '@/components/filter-navigation';
import { useEffect, useState } from 'react';
import { IconSearch } from '@/components/icons';

type Props = { tab: string; q: string; fields: [string, string][]; wanted: string[]; sort: string; exportHref: string };

/**
 * What is missing, chosen from a list one kind at a time and shown as removable chips; several
 * kinds together mean "lacks any of these". Every change applies at once.
 */
export function EnrichmentToolbar({ tab, q, fields, wanted, sort, exportHref }: Props) {
  const navigate = useFilterNavigation();
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const push = (mutate: (next: URLSearchParams) => void) => {
    navigate((next) => {
    mutate(next);
    next.set('tab', tab);
    next.delete('page');
    });
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== q) push((next) => { if (text) next.set('q', text); else next.delete('q'); });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const remaining = fields.filter(([field]) => !wanted.includes(field));
  const label = (field: string) => fields.find(([f]) => f === field)?.[1] ?? field;
  return (
    <div className="flex flex-wrap items-center gap-2 p-4">
      <div className="relative w-full max-w-[260px]">
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or account" aria-label="Search records to enrich" className="!pl-9" />
      </div>
      <select value="" onChange={(e) => { const field = e.target.value; if (field) push((next) => next.append('field', field)); }} aria-label="Missing information" className="!w-auto !py-2 !text-[12.5px]">
        <option value="">{wanted.length ? 'Missing any of...' : 'Missing information'}</option>
        {remaining.map(([field, name]) => <option key={field} value={field}>{name}</option>)}
      </select>
      {wanted.map((field) => (
        <button key={field} type="button" className="chip" onClick={() => push((next) => { const keep = next.getAll('field').filter((f) => f !== field); next.delete('field'); for (const f of keep) next.append('field', f); })} title="Remove this filter">
          {label(field)} missing <span aria-hidden className="text-brand-500">×</span>
        </button>
      ))}
      <select value={sort} onChange={(e) => push((next) => { if (e.target.value === 'name') next.delete('sort'); else next.set('sort', e.target.value); })} aria-label="Sort" className="!w-auto !py-2 !text-[12.5px]">
        <option value="name">Sort: name</option>
        <option value="company">Sort: company</option>
        <option value="gaps">Sort: most missing</option>
      </select>
      {q || wanted.length || sort !== 'name' ? <Link href={`/enrichment?tab=${tab}`} onClick={() => setText('')} className="btn-ghost btn-sm">Reset</Link> : null}
      <a href={exportHref} className="btn-secondary btn-sm ml-auto">Export to enrich</a>
    </div>
  );
}
