'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { completeNextActionAction, moveNextActionAction, stopNextActionAction } from '@/lib/actions/next-actions';
import type { ActionResult } from '@/lib/actions/users';
import { IconCheck, IconClock, IconClose } from '@/components/icons';

/** Done, Snooze and Stop for a next action in Tasks; each goes on to the next item with its result. */
export function NextActionControls({ id, nextUrl, nextWorkingDay, repeats }: { id: string; nextUrl: string; nextWorkingDay: string; repeats: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [panel, setPanel] = useState<'none' | 'snooze'>('none');
  const [date, setDate] = useState(nextWorkingDay);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string> = {}) =>
    start(async () => {
      const fd = new FormData();
      fd.set('id', id);
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      try {
        const r = await fn(fd);
        if (!r.ok) { setError(r.error); return; }
        setError(null);
        const target = new URL(nextUrl, window.location.origin);
        if (r.message) target.searchParams.set('flash', r.message);
        router.push(target.pathname + target.search);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  const primary = 'btn-primary';
  const secondary = 'btn-secondary';
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={pending} className={primary} onClick={() => run(completeNextActionAction)}><IconCheck size={16} /> Done</button>
        <button type="button" disabled={pending} className={clsx(secondary, panel === 'snooze' && 'border-ink-300 bg-canvas')} onClick={() => setPanel((p) => (p === 'snooze' ? 'none' : 'snooze'))}><IconClock size={16} /> Snooze</button>
        <button type="button" disabled={pending} className="btn-ghost" onClick={() => { if (window.confirm(repeats ? 'Stop this next action? It stops repeating and is cleared in Twenty.' : 'Stop this next action? It is cleared in Twenty.')) run(stopNextActionAction); }}><IconClose size={15} /> Stop</button>
      </div>
      {panel === 'snooze' ? (
        <form className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-canvas/60 p-3" onSubmit={(e) => { e.preventDefault(); run(moveNextActionAction, { dueDate: date }); }}>
          <label className="space-y-1"><span className="block text-[12px] font-medium text-ink-600">Snooze until</span><input type="date" min={nextWorkingDay} value={date} onChange={(e) => setDate(e.target.value)} className="!w-auto" /></label>
          <button type="submit" disabled={pending} className="btn-primary btn-sm">Snooze</button>
        </form>
      ) : null}
      {error ? <p role="alert" className="mt-3 text-[13px] text-red-700">{error}</p> : null}
    </div>
  );
}
