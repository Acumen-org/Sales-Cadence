'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { completeTaskAction, skipTaskAction, snoozeTaskAction } from '@/lib/actions/tasks';
import type { ActionResult } from '@/lib/actions/users';
import { ACTION_LABELS, type ActionType } from '@/lib/sequences/steps';
import { IconCheck, IconChevronRight, IconClock, IconExternal, IconSkip } from '@/components/icons';
import { CopyButton } from '@/components/copy-button';

type Props = {
  taskId: string;
  action: ActionType;
  altAction: ActionType | null;
  nextUrl: string | null;
  twentyUrl: string | null;
  copyText: string;
  nextWorkingDay: string;
  canPickSnoozeDate: boolean;
  size?: 'md' | 'lg';
};

/**
 * Done / Skip / Snooze / Open in Twenty / Copy template, plus Next.
 * After an action the page navigates to the next task (task flow) or refreshes.
 */
export function TaskActions({ taskId, action, altAction, nextUrl, twentyUrl, copyText, nextWorkingDay, canPickSnoozeDate, size = 'md' }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [panel, setPanel] = useState<'none' | 'skip' | 'snooze'>('none');
  const [reason, setReason] = useState('');
  const [snoozeDate, setSnoozeDate] = useState(nextWorkingDay);
  const [feedback, setFeedback] = useState<ActionResult | null>(null);

  const run = (fn: () => Promise<ActionResult>) => {
    start(async () => {
      try {
        const r = await fn();
        setFeedback(r);
        if (r.ok) {
          setPanel('none');
          setReason('');
          if (nextUrl) router.push(nextUrl);
          router.refresh();
        }
      } catch (err) {
        setFeedback({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  };

  const complete = (chosen?: ActionType) =>
    run(() => {
      const fd = new FormData();
      fd.set('taskId', taskId);
      if (chosen) fd.set('chosenAction', chosen);
      return completeTaskAction(fd);
    });

  const big = size === 'lg';
  const primary = clsx('btn-primary', big && 'px-4 py-2 text-base');
  const secondary = clsx('btn-secondary', big && 'px-4 py-2 text-base');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {altAction ? (
          <>
            <button type="button" disabled={pending} className={primary} onClick={() => complete(action)}>
              <IconCheck size={16} /> Done: {ACTION_LABELS[action]}
            </button>
            <button type="button" disabled={pending} className={primary} onClick={() => complete(altAction)}>
              <IconCheck size={16} /> Done: {ACTION_LABELS[altAction]}
            </button>
          </>
        ) : (
          <button type="button" disabled={pending} className={primary} onClick={() => complete()}>
            <IconCheck size={16} /> Done
          </button>
        )}
        <button type="button" disabled={pending} className={secondary} onClick={() => setPanel(panel === 'skip' ? 'none' : 'skip')}>
          <IconSkip size={16} /> Skip
        </button>
        <button type="button" disabled={pending} className={secondary} onClick={() => setPanel(panel === 'snooze' ? 'none' : 'snooze')}>
          <IconClock size={16} /> Snooze
        </button>
        {twentyUrl ? (
          <a href={twentyUrl} target="_blank" rel="noreferrer" className={secondary}>
            <IconExternal size={16} /> Open in Twenty
          </a>
        ) : null}
        <CopyButton text={copyText} label="Copy template" className={secondary} />
        {nextUrl ? (
          <button type="button" disabled={pending} className={clsx('btn-ghost ml-auto', big && 'text-base')} onClick={() => router.push(nextUrl)} title="Skip to the next task without changing this one">
            Next <IconChevronRight size={16} />
          </button>
        ) : null}
      </div>

      {panel === 'skip' ? (
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border border-amber-200 bg-amber-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => {
              const fd = new FormData();
              fd.set('taskId', taskId);
              fd.set('reason', reason);
              return skipTaskAction(fd);
            });
          }}
        >
          <div className="min-w-[240px] flex-1 space-y-1">
            <label htmlFor={`reason-${taskId}`}>Why are you skipping this step?</label>
            <input id={`reason-${taskId}`} value={reason} onChange={(e) => setReason(e.target.value)} className="w-full" placeholder="e.g. bounced, wrong number, asked to stop" required autoFocus />
          </div>
          <button type="submit" disabled={pending || !reason.trim()} className="btn-secondary">
            Confirm skip
          </button>
        </form>
      ) : null}

      {panel === 'snooze' ? (
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border border-sky-200 bg-sky-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => {
              const fd = new FormData();
              fd.set('taskId', taskId);
              fd.set('toDate', canPickSnoozeDate ? snoozeDate : 'next');
              return snoozeTaskAction(fd);
            });
          }}
        >
          {canPickSnoozeDate ? (
            <div className="space-y-1">
              <label htmlFor={`snooze-${taskId}`}>Snooze until</label>
              <input id={`snooze-${taskId}`} type="date" value={snoozeDate} min={nextWorkingDay} onChange={(e) => setSnoozeDate(e.target.value)} />
            </div>
          ) : (
            <p className="text-sm text-sky-900">Snooze to the next working day ({nextWorkingDay}).</p>
          )}
          <button type="submit" disabled={pending} className="btn-secondary">
            Confirm snooze
          </button>
        </form>
      ) : null}

      {feedback ? (
        <p className={clsx('text-sm', feedback.ok ? 'text-emerald-700' : 'text-red-700')} role="status">
          {feedback.ok ? feedback.message : feedback.error}
        </p>
      ) : null}
    </div>
  );
}
