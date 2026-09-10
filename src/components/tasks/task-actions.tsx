'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import clsx from 'clsx';
import { flushTaskDrafts } from './draft-registry';
import { completeTaskAction, finishFromTaskAction, moveToStepAction, removeFromSequenceAction, skipTaskAction, snoozeTaskAction } from '@/lib/actions/tasks';
import type { ActionResult } from '@/lib/actions/users';
import { type ActionType } from '@/lib/sequences/steps';
import { IconCheck, IconChevronLeft, IconChevronRight, IconClock, IconExternal, IconPhone, IconSkip } from '@/components/icons';

export type DispositionOption = { key: string; label: string; answered: boolean };
export type SkipReasonOption = { key: string; label: string; exit: string };

type Props = {
  taskId: string;
  action: ActionType;
  nextUrl: string | null;
  prevUrl: string | null;
  twentyUrl: string | null;
  nextWorkingDay: string;
  canPickSnoozeDate: boolean;
  dispositions: DispositionOption[];
  skipReasons: SkipReasonOption[];
  steps: { index: number; label: string }[];
  currentStep: number;
  canManageEnrollment: boolean;
  size?: 'md' | 'lg';
  keyboardEnabled?: boolean;
  /**
   * A step with several modules (email + LinkedIn) shows Done and Skip under each module and
   * one Snooze / Twenty / More / Next row for the step. 'full' is the single-module case.
   */
  variant?: 'full' | 'module' | 'step';
  /** Every open module of the step, so a snooze from the step row moves all of them. */
  snoozeTaskIds?: string[];
};

type Panel = 'none' | 'call' | 'skip' | 'snooze' | 'more';

/**
 * Ending a sequence used to be four separate buttons whose names did not say what they did.
 * It is one question now: why are you stopping? The answer decides whether the enrollment is
 * finished as replied, finished unanswered, or exited with a reason.
 */
const END_REASONS = [
  { key: 'replied', label: 'They replied', detail: 'Counts as a reply for this person and the FO.' },
  { key: 'no_reply', label: 'Ran its course, no reply', detail: 'Every step was worked and nobody answered.' },
  { key: 'not_interested', label: 'Not interested', detail: 'They said no.' },
  { key: 'opted_out', label: 'Asked not to be contacted', detail: 'Stops all outreach to this person.' },
  { key: 'bad_data', label: 'Wrong or missing details', detail: 'Ends the sequence. Correct the record in Twenty or Enrichment.' },
  { key: 'removed', label: 'Another reason', detail: 'Ends the sequence without one of the labels above.' },
] as const;

/**
 * The controls under a task. Every control sits in one row, and every panel opens in the one
 * slot beneath it, so nothing moves when a panel opens or closes:
 *   Done / Log call · Skip · Snooze · Open in Twenty · More (becomes Less) · Previous / Next
 * Keyboard: D done, S skip, Z snooze, N or -> next, P or <- previous, O open, M more,
 * 1-9 pick a call outcome, Enter confirm, Esc close.
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
  const [endReason, setEndReason] = useState<string>('replied');
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const run = useCallback(
    (fn: () => Promise<ActionResult>, advance = true) => {
      start(async () => {
        try {
          if (!(await flushTaskDrafts())) { setError('Save or copy your draft before continuing.'); return; }
          const r = await fn();
          if (!r.ok) {
            setError(r.error);
            return;
          }
          setError(null);
          setPanel('none');
          setNote('');
          setDisposition('');
          // The confirmation travels in the URL so it survives the navigation to the next task.
          const target = new URL(advance && p.nextUrl ? p.nextUrl : window.location.pathname + window.location.search, window.location.origin);
          if (r.message) target.searchParams.set('flash', r.message);
          router.push(target.pathname + target.search);
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
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
    const ids = p.snoozeTaskIds?.length ? p.snoozeTaskIds : [p.taskId];
    run(async () => {
      let result: ActionResult | null = null;
      for (const id of ids) {
        const fd = new FormData();
        fd.set('taskId', id);
        fd.set('toDate', p.canPickSnoozeDate ? snoozeDate : 'next');
        result = await snoozeTaskAction(fd);
        if (!result.ok) return result;
      }
      return result!;
    });
  }, [p.canPickSnoozeDate, p.snoozeTaskIds, p.taskId, run, snoozeDate]);

  const submitEnd = useCallback(() => {
    const fd = new FormData();
    fd.set('taskId', p.taskId);
    if (endReason === 'replied' || endReason === 'no_reply') {
      fd.set('kind', endReason);
      run(() => finishFromTaskAction(fd));
    } else {
      fd.set('reason', endReason);
      run(() => removeFromSequenceAction(fd));
    }
  }, [endReason, p.taskId, run]);

  const submitMove = useCallback(() => {
    const fd = new FormData();
    fd.set('taskId', p.taskId);
    fd.set('stepIndex', String(moveTo));
    run(() => moveToStepAction(fd), false);
  }, [moveTo, p.taskId, run]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (p.keyboardEnabled === false) return;
      if (pending || e.repeat || e.defaultPrevented || document.querySelector('dialog[open]')) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="toolbar"]')) return;
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
      if (e.key === 'Enter' && !target?.closest('[contenteditable="true"]') && (e.ctrlKey || e.metaKey || (!typing && !target?.closest('button,a,summary,[role="button"]')))) {
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
      const key = e.key.toLowerCase();
      // A module row has no snooze/navigation; a step row has no done/skip.
      if ((key === 'd' || key === 's') && p.variant === 'step') return;
      if (['z', 'm', 'n', 'arrowright', 'p', 'arrowleft', 'o'].includes(key) && p.variant === 'module') return;
      switch (key) {
        case 'd':
          e.preventDefault();
          startDone(p.action); // either/or: D takes the primary action, the second button the other
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, disposition, pending, pendingAction, p, router, startDone, submitComplete, submitSkip, submitSnooze]);

  const big = p.size === 'lg';
  const variant = p.variant ?? 'full';
  const primary = clsx('btn-primary', big && 'px-4 py-2 text-[14.5px]');
  const secondary = clsx('btn-secondary', big && 'px-4 py-2 text-[14.5px]');
  const toggle = (x: Panel) => setPanel((v) => (v === x ? 'none' : x));
  const laterSteps = p.steps.filter((s) => s.index > p.currentStep);

  return (
    <div>
      {/* One row of controls, in one place. Its height never changes and nothing above it grows,
          so the buttons are always where the FO last saw them. */}
      <div className="flex flex-wrap items-center gap-2">
        {variant !== 'step' ? <>
        <button type="button" disabled={pending} className={primary} onClick={() => startDone(p.action)}>
          {p.action === 'CALL' ? <IconPhone size={16} /> : <IconCheck size={16} />} {p.action === 'CALL' ? 'Log call' : 'Done'}
        </button>
        <button type="button" disabled={pending} className={clsx(secondary, panel === 'skip' && 'border-ink-300 bg-canvas')} onClick={() => toggle('skip')}>
          <IconSkip size={16} /> Skip
        </button>
        </> : null}
        {variant !== 'module' ? <>
        <button type="button" disabled={pending} className={clsx(secondary, panel === 'snooze' && 'border-ink-300 bg-canvas')} onClick={() => toggle('snooze')}>
          <IconClock size={16} /> Snooze
        </button>
        {p.twentyUrl ? (
          <a href={p.twentyUrl} target="_blank" rel="noreferrer" className={secondary} title="Open this person in Twenty (O)">
            <IconExternal size={16} /> Twenty
          </a>
        ) : null}
        <button
          type="button"
          disabled={pending}
          aria-expanded={panel === 'more'}
          className={clsx('btn-ghost w-[74px] justify-center', big && 'text-[14.5px]', panel === 'more' && 'bg-canvas text-ink-900')}
          onClick={() => toggle('more')}
          title="End the sequence, or move to another step (M)"
        >
          {panel === 'more' ? 'Less' : 'More'}
        </button>

        <span className="ml-auto flex items-center gap-1">
          {p.prevUrl ? (
            <button type="button" className="btn-icon-ghost" onClick={() => router.push(p.prevUrl!)} title="Previous task (P)" aria-label="Previous task">
              <IconChevronLeft size={16} />
            </button>
          ) : null}
          {p.nextUrl ? (
            <button type="button" className={clsx('btn-ghost', big && 'text-[14.5px]')} onClick={() => router.push(p.nextUrl!)} title="Next task, leaving this one alone (N)">
              Next <IconChevronRight size={16} />
            </button>
          ) : null}
        </span>
        </> : null}
      </div>

      {/* The one panel slot. Everything opens here, in this order, and nowhere else. */}
      {panel !== 'none' || error ? (
        <div className="mt-3">
          {error ? (
            <p className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700" role="alert">
              {error}
            </p>
          ) : null}

          {panel === 'call' ? (
            <form
              className="rounded-xl border border-brand-200 bg-brand-50/50 p-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (disposition) submitComplete(pendingAction, disposition);
              }}
            >
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-brand-700">How did the call go?</p>
              <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
                {p.dispositions.map((d, i) => (
                  <label
                    key={d.key}
                    className={clsx(
                      'flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[13px] transition',
                      disposition === d.key ? 'border-brand-500 bg-white ring-2 ring-brand-100' : 'border-line bg-white hover:border-brand-300',
                    )}
                  >
                    <input type="radio" name="disposition" value={d.key} checked={disposition === d.key} onChange={() => setDisposition(d.key)} className="h-3.5 w-3.5" />
                    <span className="flex-1 font-normal text-ink-800">{d.label}</span>
                    {d.answered ? <span className="rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">answered</span> : null}
                    <span className="text-[10px] text-ink-300">{i + 1}</span>
                  </label>
                ))}
              </div>
              <div className="mt-3 space-y-1">
                <label htmlFor={`note-${p.taskId}`}>Call notes, saved to Twenty</label>
                <textarea id={`note-${p.taskId}`} ref={noteRef} rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="w-full" placeholder="What was said, the next step, the best time to call back..." />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button type="submit" disabled={pending || !disposition} className="btn-primary">
                  Log call
                </button>
                <button type="button" className="btn-ghost" onClick={() => setPanel('none')}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {panel === 'skip' ? (
            <form
              className="rounded-xl border border-amber-200 bg-amber-50/70 p-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                submitSkip();
              }}
            >
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-amber-800">Skip this one step</p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[220px] space-y-1">
                  <label htmlFor={`reason-${p.taskId}`}>Why?</label>
                  <select id={`reason-${p.taskId}`} value={reasonKey} onChange={(e) => setReasonKey(e.target.value)} className="w-full">
                    {p.skipReasons.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                        {r.exit !== 'none' ? ' - ends the sequence' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-[240px] flex-1 space-y-1">
                  <label htmlFor={`skipnote-${p.taskId}`}>Detail, optional</label>
                  <input id={`skipnote-${p.taskId}`} value={note} onChange={(e) => setNote(e.target.value)} className="w-full" placeholder="e.g. mailbox full, referred to a colleague" />
                </div>
                <button type="submit" disabled={pending} className="btn-secondary">
                  Skip step
                </button>
              </div>
            </form>
          ) : null}

          {panel === 'snooze' ? (
            <form
              className="rounded-xl border border-sky-200 bg-sky-50/70 p-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                submitSnooze();
              }}
            >
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-sky-800">Come back to this task later</p>
              <div className="flex flex-wrap items-end gap-2">
                {p.canPickSnoozeDate ? (
                  <div className="space-y-1">
                    <label htmlFor={`snooze-${p.taskId}`}>Snooze until</label>
                    <input id={`snooze-${p.taskId}`} type="date" value={snoozeDate} min={p.nextWorkingDay} onChange={(e) => setSnoozeDate(e.target.value)} />
                  </div>
                ) : (
                  <p className="text-[13px] text-sky-900">Moves to the next working day, {p.nextWorkingDay}.</p>
                )}
                <button type="submit" disabled={pending} className="btn-secondary">
                  Snooze
                </button>
              </div>
            </form>
          ) : null}

          {panel === 'more' ? (
            <div className="grid gap-3 rounded-xl border border-line bg-canvas/70 p-3.5 md:grid-cols-2">
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitEnd();
                }}
              >
                <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-500">End the sequence</p>
                <select value={endReason} onChange={(e) => setEndReason(e.target.value)} aria-label="Why are you ending the sequence?" className="w-full">
                  {END_REASONS.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <p className="min-h-[32px] text-[12px] leading-snug text-ink-400">{END_REASONS.find((r) => r.key === endReason)?.detail}</p>
                <button type="submit" disabled={pending} className="btn-secondary btn-sm">
                  End sequence
                </button>
              </form>

              {p.canManageEnrollment && laterSteps.length ? (
                <form
                  className="space-y-2 md:border-l md:border-line md:pl-3.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitMove();
                  }}
                >
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-500">Jump to another step</p>
                  {/* One control, not a select sitting next to an unrelated button. */}
                  <div className="flex overflow-hidden rounded-[10px] border border-line bg-white focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100">
                    <select
                      value={moveTo}
                      onChange={(e) => setMoveTo(Number(e.target.value))}
                      aria-label="Step to jump to"
                      className="min-w-0 flex-1 !rounded-none !border-0 !bg-transparent !ring-0"
                    >
                      {laterSteps.map((s) => (
                        <option key={s.index} value={s.index}>
                          Step {s.index + 1}: {s.label}
                        </option>
                      ))}
                    </select>
                    <button type="submit" disabled={pending} className="shrink-0 border-l border-line px-3 text-[12.5px] font-medium text-ink-700 transition hover:bg-canvas hover:text-brand-700">
                      Jump
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

    </div>
  );
}
