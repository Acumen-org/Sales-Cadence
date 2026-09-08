'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { ACTIVITY_KINDS, KIND_LABELS, type ActivityKind } from '@/lib/activity-query';
import { IconSearch } from '@/components/icons';

export function ActivityToolbar({ users, actorId, kinds, q }: { users: { id: string; name: string }[]; actorId: string | null; kinds: ActivityKind[]; q: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(q);

  const push = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    // Any filter change restarts the feed at the newest item.
    next.delete('before');
    router.push(`${pathname}?${next.toString()}`);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== q) push({ q: text || null });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const toggleKind = (k: ActivityKind) => {
    const set = new Set(kinds);
    if (set.has(k)) set.delete(k);
    else set.add(k);
    push({ kind: set.size ? [...set].join(',') : null });
  };

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search activity" aria-label="Search activity" className="!pl-9" />
      </div>

      <select value={actorId ?? ''} onChange={(e) => push({ actor: e.target.value || null })} aria-label="Filter by person" className="!w-auto !py-2 !text-[12.5px]">
        <option value="">Everyone</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>

      {ACTIVITY_KINDS.map((k) => (
        <button key={k} type="button" onClick={() => toggleKind(k)} className={clsx(kinds.includes(k) ? 'chip' : 'chip-muted')}>
          {KIND_LABELS[k]}
        </button>
      ))}

      {kinds.length || actorId || q ? (
        <button type="button" onClick={() => push({ kind: null, actor: null, q: null })} className="btn-ghost btn-sm">
          Clear
        </button>
      ) : null}
    </div>
  );
}
