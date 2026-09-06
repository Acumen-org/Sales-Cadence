'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

type Props = {
  pods: { id: string; name: string }[];
  fos: { id: string; name: string; podIds: string[] }[];
  podId: string | null;
  foUserId: string | null;
  mode: 'list' | 'flow';
};

/** Pod / FO filters and list-vs-flow toggle. All state lives in the URL. */
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
    router.push(`${pathname}?${next.toString()}`);
  };

  const visibleFos = podId ? fos.filter((f) => f.podIds.includes(podId) || f.podIds.length === 0) : fos;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {pods.length ? (
        <select value={podId ?? ''} onChange={(e) => update({ pod: e.target.value || null, fo: null })} className="text-sm">
          <option value="">All pods</option>
          {pods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : null}
      {fos.length ? (
        <select value={foUserId ?? ''} onChange={(e) => update({ fo: e.target.value || null })} className="text-sm">
          <option value="">All FOs</option>
          {visibleFos.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      ) : null}
      <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-sm shadow-sm">
        <button
          type="button"
          onClick={() => update({ mode: null })}
          className={mode === 'list' ? 'bg-slate-800 px-3 py-1.5 text-white' : 'bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50'}
        >
          List
        </button>
        <button
          type="button"
          onClick={() => update({ mode: 'flow' })}
          className={mode === 'flow' ? 'bg-slate-800 px-3 py-1.5 text-white' : 'bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50'}
        >
          Task flow
        </button>
      </div>
    </div>
  );
}
