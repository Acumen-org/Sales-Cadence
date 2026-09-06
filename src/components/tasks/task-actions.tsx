'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import clsx from 'clsx';
import {
  completeTaskAction,
  finishFromTaskAction,
  moveToStepAction,
  pauseFromTaskAction,
  removeFromSequenceAction,
  skipTaskAction,
  snoozeTaskAction,
} from '@/lib/actions/tasks';
import type { ActionResult } from '@/lib/actions/users';
import { ACTION_LABELS, type ActionType } from '@/lib/sequences/steps';
import { IconCheck, IconChevronLeft, IconChevronRight, IconClock, IconExternal, IconPhone, IconSkip } from '@/components/icons';
import { CopyButton } from '@/components/copy-button';

export type DispositionOption = { key: string; label: string; answered: boolean };
export type SkipReasonOption = { key: string; label: string; exit: string };

type Props = {
  taskId: string;
  action: ActionType;
  altAction: ActionType | null;
  nextUrl: string | null;
  prevUrl: string | null;
  twentyUrl: string | null;
  copyText: string;
  nextWorkingDay: string;
  canPickSnoozeDate: boolean;
  dispositions: DispositionOption[];
  skipReasons: SkipReasonOption[];
  steps: { index: number; label: string }[];
  currentStep: number;
  canManageEnrollment: boolean;
  size?: 'md' | 'lg';
};

type Panel = 'none' | 'call' | 'skip' | 'snooze' | 'more';

/**
 * Task flow controls, Outreach style:
 *  Done (calls need a disposition), Skip (reason), Snooze, Open in Twenty, Copy, Next/Previous,
 *  and an overflow with Finish (Replied) / Finish (No Reply) / Pause / Move to step / Remove.
 *  Keyboard: D done, S skip, Z snooze, N or -> next, P or <- previous, C copy, O open, M more,
 *  1-9 pick a call outcome, Enter confirm, Esc close.
 */
export function TaskActions(p: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [panel, setPanel] = useState<Panel>('none');
  const [pendingAction, setPendingAction] = useState<ActionType>(p.action);
  const [disposition, setDisposition] = useState<string>('');
  const [note, setNote] = useState('');
  const [reasonKey, setReasonKey] = useState(p.skipReasons[0]?.key ?? 'other');
  const [snoozeDate, setSnoozeDate] = useState(p.nextWorkingDay);
  const [moveTo, setMoveTo] = useState<number>(p.steps.find((s) => s.index > p.currentStep)?.index ?? p.currentStep + 1);
  const [feedback, setFeedback] = useState<ActionResult | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const run = useCallback(
    (fn: () => Promise<ActionResult>, advance = true) => {
      start(async () => {
        try {
          const r = await fn();
          setFeedback(r);
          if (r.ok) {
            setPanel('none');
            setNote('');
            setDisposition('');
            // Carry the confirmation in the URL so it survives the navigation / re-render.
            const target = new URL(advance && p.nextUrl ? p.nextUrl : window.location.pathname + window.location.search, window.location.origin);
            if (r.message) target.searchParams.set('flash', r.message);
            router.push(target.pathname + target.search);
            router.refresh();
          }
        } catch (err) {
          setFeedback({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      });
    },
    [p.nextUrl, router],
  );

  const submitComplete = useCallback(
    (chosen: ActionType, dispositionKey?: string) => {
      const fd = new FormData();
      fd.set('taskId', p.taskId);
      fd.set('chosenAction', chosen);
      if (dispositionKey) fd.set('disposition', dispositionKey);
      if (note.trim()) fd.set('note', note.trim());
      run(() => completeTaskAction(fd));
    },
    [note, p.taskId, run],
  );

  const startDone = useCallback(
    (chosen: ActionType) => {
      setPendingAction(chosen);
      if (chosen === 'CALL') {
        setPanel('call');
        setTimeout(() => noteRef.current?.focus(), 0);
      } else submitComplete(chosen);
    },
    [submitComplete],
  );

  const submitSkip = useCallback(() => {
    const fd = new FormData();
    fd.set('taskId', p.taskId);
    fd.set('reasonKey', reasonKey);
    if (note.trim()) fd.set('note', note.trim());
    run(() => skipTaskAction(fd));
  }, [note, p.taskId, reasonKey, run]);
  const submitSnooze = useCallback(() => {
    const fd = new FormData();
    fd.set('taskId', p.taskId);
    fd.set('toDate', p.canPickSnoozeDate ? snoozeDate : 'next');
    run(() => snoozeTaskAction(fd));
  }, [p.canPickSnoozeDate, p.taskId, run, snoozeDate]);
  const enrollmentOp = (fn: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string> = {}, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    const fd = new FormData();
    fd.set('taskId', p.taskId);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    run(() => fn(fd));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (e.key === 'Escape') {
        setPanel('none');
        return;
      }
      if (panel === 'call' && !typing && /^[1-9]$/.test(e.key)) {
        const d = p.dispositions[Number(e.key) - 1];
        if (d) setDisposition(d.key);
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !typing)) {
        if (panel === 'call' && disposition) {
          e.preventDefault();
          submitComplete(pendingAction, disposition);
        } else if (panel === 'skip') {
          e.preventDefault();
          submitSkip();
        } else if (panel === 'snooze') {
          e.preventDefault();
          submitSnooze();
        }
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case 'd':
          e.preventDefault();
          startDone(p.action); // either/or: D = the primary action, click the second button for the alternative
          break;
        case 's':
          e.preventDefault();
          setPanel((v) => (v === 'skip' ? 'none' : 'skip'));
          break;
        case 'z':
          e.preventDefault();
          setPanel((v) => (v === 'snooze' ? 'none' : 'snooze'));
          break;
        case 'm':
          e.preventDefault();
          setPanel((v) => (v === 'more' ? 'none' : 'more'));
          break;
        case 'n':
        case 'arrowright':
          if (p.nextUrl) router.push(p.nextUrl);
          break;
        case 'p':
        case 'arrowleft':
          if (p.prevUrl) router.push(p.prevUrl);
          break;
        case 'o':
          if (p.twentyUrl) window.open(p.twentyUrl, '_blank', 'noreferrer');
          break;
        case 'c':
          void navigator.clipboard?.writeText(p.copyText);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, disposition, pendingAction, p, router, startDone, submitComplete, submitSkip, submitSnooze]);

  const big = p.size === 'lg';
  const primary = clsx('btn-primary', big && 'px-4 py-2 text-base');
  const secondary = clsx('btn-secondary', big && 'px-4 py-2 text-base');
  const toggle = (x: Panel) => setPanel((v) => (v === x ? 'none' : x));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {p.altAction ? (
          <>
            <button type="button" disabled={pending} className={primary} onClick={() => startDone(p.action)}>
              <IconCheck size={16} /> Done: {ACTION_LABELS[p.action]}
            </button>
            <button type="button" disabled={pending} className={primary} onClick={() => startDone(p.altAction!)}>
              <IconCheck size={16} /> Done: {ACTION_LABELS[p.altAction]}
            </button>
          </>
        ) : (
          <button type="button" disabled={pending} className={primary} onClick={() => startDone(p.action)}>
            {p.action === 'CALL' ? <IconPhone size={16} /> : <IconCheck size={16} />} {p.action === 'CALL' ? 'Log call' : 'Done'}
          </button>
        )}
        <button type="button" disabled={pending} className={secondary} onClick={() => toggle('skip')}>
          <IconSkip size={16} /> Skip
        </button>
        <button type="button" disabled={pending} className={secondary} onClick={() => toggle('snooze')}>
          <IconClock size={16} /> Snooze
        </button>
        {p.twentyUrl ? (
          <a href={p.twentyUrl} target="_blank" rel="noreferrer" className={secondary}>
            <IconExternal size={16} /> Open in Twenty
          </a>
        ) : null}
        <CopyButton text={p.copyText} label="Copy template" className={secondary} />
        <button type="button" disabled={pending} className={clsx('btn-ghost', big && 'text-base')} onClick={() => toggle('more')} title="Finish, pause, move to step, remove">
          More
        </button>
        <span className="ml-auto flex items-center gap-1">
          {p.prevUrl ? (
            <button type="button" className="btn-ghost" onClick={() => router.push(p.prevUrl!)} title="Previous task (P)">
              <IconChevronLeft size={16} />
            </button>
          ) : null}
          {p.nextUrl ? (
            <button type="button" className={clsx('btn-ghost', big && 'text-base')} onClick={() => router.push(p.nextUrl!)} title="Next task without changing this one (N)">
              Next <IconChevronRight size={16} />
            </button>
          ) : null}
        </span>
      </div>

      {panel === 'call' ? (
        <form
          className="space-y-3 rounded-md border border-brand-200 bg-brand-50/60 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (disposition) submitComplete(pendingAction, disposition);
          }}
        >
          <div>
            <label className="mb-1 block">Call outcome (required)</label>
            <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
              {p.dispositions.map((d, i) => (
                <label
                  key={d.key}
                  className={clsx(
                    'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm',
                    disposition === d.key ? 'border-brand-500 bg-white ring-2 ring-brand-100' : 'border-slate-200 bg-white hover:border-slate-300',
                  )}
                >
                  <input type="radio" name="disposition" value={d.key} checked={disposition === d.key} onChange={() => setDisposition(d.key)} className="h-3.5 w-3.5" />
                  <span className="flex-1 font-normal text-slate-800">{d.label}</span>
                  <span className="text-[10px] text-slate-400">{i + 1}</span>
                  {d.answered ? <span className="rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">answered</span> : null}
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor={`note-${p.taskId}`}>Call notes (optional, saved to Twenty)</label>
            <textarea id={`note-${p.taskId}`} ref={noteRef} rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="w-full" placeholder="What was said, next step, best time to call back..." />
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={pending || !disposition} className="btn-primary">
              Log call
            </button>
            <button type="button" className="btn-ghost" onClick={() => setPanel('none')}>
              Cancel
            </button>
            <span className="text-xs text-slate-500">Press 1-{Math.min(9, p.dispositions.length)} to pick, Enter to log.</span>
          </div>
        </form>
      ) : null}

      {panel === 'skip' ? (
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border border-amber-200 bg-amber-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            submitSkip();
          }}
        >
          <div className="min-w-[220px] space-y-1">
            <label htmlFor={`reason-${p.taskId}`}>Why are you skipping this step?</label>
            <select id={`reason-${p.taskId}`} value={reasonKey} onChange={(e) => setReasonKey(e.target.value)} className="w-full">
              {p.skipReasons.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                  {r.exit !== 'none' ? ' (ends the sequence)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[240px] flex-1 space-y-1">
            <label htmlFor={`skipnote-${p.taskId}`}>Detail (optional)</label>
            <input id={`skipnote-${p.taskId}`} value={note} onChange={(e) => setNote(e.target.value)} className="w-full" placeholder="e.g. mailbox full, referred to colleague" />
          </div>
          <button type="submit" disabled={pending} className="btn-secondary">
            Confirm skip
          </button>
        </form>
      ) : null}

      {panel === 'snooze' ? (
        <form
          className="flex flex-wrap items-end gap-2 rounded-md border border-sky-200 bg-sky-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            submitSnooze();
          }}
        >
          {p.canPickSnoozeDate ? (
            <div className="space-y-1">
              <label htmlFor={`snooze-${p.taskId}`}>Snooze until</label>
              <input id={`snooze-${p.taskId}`} type="date" value={snoozeDate} min={p.nextWorkingDay} onChange={(e) => setSnoozeDate(e.target.value)} />
            </div>
          ) : (
            <p className="text-sm text-sky-900">Snooze to the next working day ({p.nextWorkingDay}).</p>
          )}
          <button type="submit" disabled={pending} className="btn-secondary">
            Confirm snooze
          </button>
        </form>
      ) : null}

      {panel === 'more' ? (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          <button type="button" disabled={pending} className="btn-secondary btn-sm" onClick={() => enrollmentOp(finishFromTaskAction, { kind: 'replied' }, 'Mark this person as replied and finish the sequence?')}>
            Finish (Replied)
          </button>
          <button type="button" disabled={pending} className="btn-secondary btn-sm" onClick={() => enrollmentOp(finishFromTaskAction, { kind: 'no_reply' }, 'Finish the sequence for this person with no reply?')}>
            Finish (No reply)
          </button>
          {p.canManageEnrollment ? (
            <>
              <button type="button" disabled={pending} className="btn-secondary btn-sm" onClick={() => enrollmentOp(pauseFromTaskAction)}>
                Pause
              </button>
              {p.steps.some((s) => s.index > p.currentStep) ? (
                <span className="inline-flex items-end gap-1">
                  <select value={moveTo} onChange={(e) => setMoveTo(Number(e.target.value))} className="text-xs">
                    {p.steps
                      .filter((s) => s.index > p.currentStep)
                      .map((s) => (
                        <option key={s.index} value={s.index}>
                          Step {s.index + 1}: {s.label}
                        </option>
                      ))}
                  </select>
                  <button type="button" disabled={pending} className="btn-secondary btn-sm" onClick={() => enrollmentOp(moveToStepAction, { stepIndex: String(moveTo) })}>
                    Move to step
                  </button>
                </span>
              ) : null}
              <button type="button" disabled={pending} className="btn-ghost btn-sm text-red-600" onClick={() => enrollmentOp(removeFromSequenceAction, { reason: 'removed' }, 'Remove this person from the sequence? Open tasks will be cancelled.')}>
                Remove from sequence
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {feedback ? (
        <p className={clsx('text-sm', feedback.ok ? 'text-emerald-700' : 'text-red-700')} role="status">
          {feedback.ok ? feedback.message : feedback.error}
        </p>
      ) : null}
      <p className="text-[11px] text-slate-400">
        Shortcuts: <kbd>D</kbd> done · <kbd>S</kbd> skip · <kbd>Z</kbd> snooze · <kbd>N</kbd>/<kbd>P</kbd> next/previous · <kbd>C</kbd> copy · <kbd>O</kbd> open in Twenty · <kbd>M</kbd> more · <kbd>Esc</kbd> close
      </p>
    </div>
  );
}
