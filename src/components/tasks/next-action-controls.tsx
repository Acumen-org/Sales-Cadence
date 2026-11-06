'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { completeNextActionAction, moveNextActionAction, stopNextActionAction } from '@/lib/actions/next-actions';
import type { ActionResult } from '@/lib/actions/users';
import { IconCheck, IconClock, IconClose } from '@/components/icons';
import { useConfirm } from '@/components/confirm-dialog';
import { rowControlLabel } from '@/lib/task-cues';
import { WorkingDayHint } from './working-day-hint';

type Props = {
  id: string;
  nextUrl: string;
  nextWorkingDay: string;
  repeats: boolean;
  /** The occurrence on screen: Done in a stale tab must not use up the next one. */
  dueDate?: string;
  /** A meeting is recorded, not done (B183): its button says so. */
  kind?: 'ACTION' | 'MEETING';
  /** A CRM person's meeting also goes into Meetings, where Meetings held counts it. */
  meetingHref?: string | null;
  /** A cold contact's call closes only with its call and its form (B161): Call and "Called from another phone?" stand where Done would. */
  callSlot?: React.ReactNode;
  /** Who it is for and what it says, so each control names its contact (N105). */
  subjectName?: string;
  label?: string;
  /** Settings > Rules' working days, for the weekend cue on the snooze date (N103). */
  workingDays?: number[];
};

/** Done, Snooze and Stop for a next action in Tasks; each goes on to the next item with its result. */
export function NextActionControls({ id, nextUrl, nextWorkingDay, repeats, dueDate, kind = 'ACTION', meetingHref = null, callSlot = null, subjectName, label, workingDays = [] }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [panel, setPanel] = useState<'none' | 'snooze'>('none');
  const [date, setDate] = useState(nextWorkingDay);
  const [error, setError] = useState<string | null>(null);
  const [ask, dialog] = useConfirm();

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
  const verb = kind === 'MEETING' ? 'Record meeting' : 'Done';
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {callSlot ?? <button type="button" disabled={pending} className={primary} onClick={() => run(completeNextActionAction, dueDate ? { dueDate } : {})} aria-label={subjectName ? rowControlLabel(verb, label ?? 'this task', subjectName) : undefined}><IconCheck size={16} /> {verb}</button>}
        {meetingHref && kind === 'MEETING' ? <a href={meetingHref} className={secondary}>Add to Meetings</a> : null}
        <button type="button" disabled={pending} className={clsx(secondary, panel === 'snooze' && 'border-ink-300 bg-canvas')} onClick={() => setPanel((p) => (p === 'snooze' ? 'none' : 'snooze'))}><IconClock size={16} /> Snooze</button>
        <button type="button" disabled={pending} className="btn-ghost" onClick={async () => { if (await ask({ title: 'Stop this task?', effects: [repeats ? 'It stops repeating.' : 'It closes without being done.', 'It is cleared in the CRM too.'], confirmLabel: 'Stop' })) run(stopNextActionAction); }}><IconClose size={15} /> Stop</button>
      </div>
      {dialog}
      {panel === 'snooze' ? (
        <form className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-canvas/60 p-3" onSubmit={(e) => { e.preventDefault(); run(moveNextActionAction, { dueDate: date }); }}>
          <label className="space-y-1"><span className="block text-[12px] font-medium text-ink-600">Snooze until</span><input type="date" min={nextWorkingDay} value={date} onChange={(e) => setDate(e.target.value)} className="!w-auto" /></label>
          <button type="submit" disabled={pending} className="btn-primary btn-sm">Snooze</button>
          <WorkingDayHint date={date} workingDays={workingDays} onMove={setDate} />
        </form>
      ) : null}
      {error ? <p role="alert" className="mt-3 text-[13px] text-red-700">{error}</p> : null}
    </div>
  );
}
