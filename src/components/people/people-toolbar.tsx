'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { IconSearch } from '@/components/icons';

type Props = { pods: { podOwnerValue: string; name: string }[]; q: string; pod: string; status: string };

const STAGES = [
  { value: '', label: 'Any stage' },
  { value: 'cold', label: 'Cold (never enrolled)' },
  { value: 'approaching', label: 'Approaching (in a sequence)' },
  { value: 'replied', label: 'Replied or meeting' },
  { value: 'unresponsive', label: 'Unresponsive (finished, no reply)' },
  { value: 'bad_data', label: 'Bad data' },
  { value: 'dnd', label: 'Do not contact / opted out' },
];

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

  const activeChips = [
    pod ? { key: 'pod', label: `Pod is ${pods.find((p) => p.podOwnerValue === pod)?.name ?? pod}` } : null,
    status ? { key: 'status', label: STAGES.find((s) => s.value === status)?.label ?? status } : null,
  ].filter((x): x is { key: string; label: string } => Boolean(x));

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, company, email" aria-label="Search people" className="!pl-9" />
      </div>

      {activeChips.map((c) => (
        <button key={c.key} type="button" className="chip" onClick={() => update({ [c.key]: null })} title="Remove this filter">
          {c.label}
          <span aria-hidden className="text-brand-500">
            ✕
          </span>
        </button>
      ))}

      <select value={pod} onChange={(e) => update({ pod: e.target.value || null })} aria-label="Filter by pod" className="!w-auto !py-2 !text-[12.5px]">
        <option value="">All pods</option>
        {pods.map((p) => (
          <option key={p.podOwnerValue} value={p.podOwnerValue}>
            {p.name}
          </option>
        ))}
      </select>
      <select value={status} onChange={(e) => update({ status: e.target.value || null })} aria-label="Filter by stage" className="!w-auto !py-2 !text-[12.5px]">
        {STAGES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}
