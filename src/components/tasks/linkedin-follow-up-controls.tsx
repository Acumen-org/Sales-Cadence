'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { completeFollowUpAction, dismissFollowUpAction, moveFollowUpAction } from '@/lib/actions/linkedin';
import type { ActionResult } from '@/lib/actions/users';
import { IconCheck, IconClock, IconClose } from '@/components/icons';
import { rowControlLabel } from '@/lib/task-cues';
import { WorkingDayHint } from './working-day-hint';

/** Done, Snooze and Not needed for a LinkedIn task; each goes on to the next item with its result. */
export function LinkedInFollowUpControls({ id, nextUrl, nextWorkingDay, subjectName, label, workingDays = [] }: { id: string; nextUrl: string; nextWorkingDay: string; subjectName: string; label: string; workingDays?: number[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [panel, setPanel] = useState<'none' | 'snooze' | 'dismiss'>('none');
  const [date, setDate] = useState(nextWorkingDay);
  const [reason, setReason] = useState('');
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

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={pending} className="btn-primary" onClick={() => run(completeFollowUpAction)} aria-label={rowControlLabel('Done', label, subjectName)}><IconCheck size={16} /> Done</button>
        <button type="button" disabled={pending} className={clsx('btn-secondary', panel === 'snooze' && 'border-ink-300 bg-canvas')} onClick={() => setPanel((p) => (p === 'snooze' ? 'none' : 'snooze'))}><IconClock size={16} /> Snooze</button>
        <button type="button" disabled={pending} className="btn-ghost" onClick={() => setPanel((p) => (p === 'dismiss' ? 'none' : 'dismiss'))}><IconClose size={15} /> Not needed</button>
      </div>
      {panel === 'snooze' ? (
        <form className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-canvas/60 p-3" onSubmit={(e) => { e.preventDefault(); run(moveFollowUpAction, { dueDate: date }); }}>
          <label className="space-y-1"><span className="block text-[12px] font-medium text-ink-600">Snooze until</span><input type="date" min={nextWorkingDay} value={date} onChange={(e) => setDate(e.target.value)} className="!w-auto" /></label>
          <button type="submit" disabled={pending} className="btn-primary btn-sm">Snooze</button>
          <WorkingDayHint date={date} workingDays={workingDays} onMove={setDate} />
        </form>
      ) : null}
      {panel === 'dismiss' ? (
        <form className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-canvas/60 p-3" onSubmit={(e) => { e.preventDefault(); run(dismissFollowUpAction, { reason }); }}>
          <label className="min-w-[16rem] flex-1 space-y-1"><span className="block text-[12px] font-medium text-ink-600">Why is it not needed?</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: we spoke by phone" maxLength={200} /></label>
          <button type="submit" disabled={pending} className="btn-secondary btn-sm">Close it</button>
        </form>
      ) : null}
      {error ? <p role="alert" className="mt-3 text-[13px] text-red-700">{error}</p> : null}
    </div>
  );
}
