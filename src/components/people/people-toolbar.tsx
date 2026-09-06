'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { IconSearch } from '@/components/icons';

type Props = { pods: { podOwnerValue: string; name: string }[]; q: string; pod: string; status: string };

export function PeopleToolbar({ pods, q, pod, status }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(q);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete('page');
    router.push(`${pathname}?${next.toString()}`);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== q) update({ q: text || null });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <IconSearch size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, company, email" className="w-64 pl-8 text-sm" />
      </div>
      <select value={pod} onChange={(e) => update({ pod: e.target.value || null })} className="text-sm">
        <option value="">All pods</option>
        {pods.map((p) => (
          <option key={p.podOwnerValue} value={p.podOwnerValue}>
            {p.name}
          </option>
        ))}
      </select>
      <select value={status} onChange={(e) => update({ status: e.target.value || null })} className="text-sm">
        <option value="">Any status</option>
        <option value="enrolled">In a sequence</option>
        <option value="not_enrolled">Not enrolled</option>
        <option value="replied">Replied or meeting</option>
        <option value="dnd">Do not contact</option>
      </select>
    </div>
  );
}
