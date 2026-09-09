'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import clsx from 'clsx';

type Props = {
  pods: { id: string; name: string }[];
  fos: { id: string; name: string; podIds: string[] }[];
  podId: string | null;
  foUserId: string | null;
  mode: 'list' | 'flow';
};

/** Pod / FO filters and the list-vs-flow toggle. All state lives in the URL. */
export function TaskFilters({ pods, fos, podId, foUserId, mode }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete('task');
    next.delete('flash');
    router.push(`${pathname}?${next.toString()}`);
  };

  const visibleFos = podId ? fos.filter((f) => f.podIds.includes(podId) || f.podIds.length === 0) : fos;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {pods.length ? (
        <select value={podId ?? ''} onChange={(e) => update({ pod: e.target.value || null, fo: null })} aria-label="Filter by pod" className="!w-auto !py-1.5 !text-[12.5px]">
          <option value="">All pods</option>
          {pods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : null}
      {fos.length ? (
        <select value={foUserId ?? ''} onChange={(e) => update({ fo: e.target.value || null })} aria-label="Filter by FO" className="!w-auto !py-1.5 !text-[12.5px]">
          <option value="">All FOs</option>
          {visibleFos.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      ) : null}
      <div className="inline-flex overflow-hidden rounded-[10px] border border-line bg-white p-0.5 text-[12.5px]">
        {(['list', 'flow'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => update({ mode: m === 'flow' ? 'flow' : null })}
            className={clsx('rounded-lg px-2.5 py-1 font-medium transition', mode === m ? 'bg-brand-600 text-white' : 'text-ink-500 hover:text-ink-700')}
          >
            {m === 'list' ? 'List' : 'Task flow'}
          </button>
        ))}
      </div>
    </div>
  );
}
