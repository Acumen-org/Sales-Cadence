'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { bulkTasksAction } from '@/lib/actions/tasks';
import type { ActionResult } from '@/lib/actions/users';
import { relativeDays, formatLocalDate, type LocalDate } from '@/lib/dates';
import { ActionIcon } from '@/components/icons';
import { Avatar, Badge } from '@/components/ui';
import type { DispositionOption, SkipReasonOption } from './task-actions';
import { flushTaskDrafts } from './draft-registry';

const STATE_LABELS: Record<string, string> = { DONE: 'Done', SKIPPED: 'Skipped', CANCELLED: 'Cancelled' };

/** Serialisable row for the client list. */
export type TaskListRow = {
  childActions?: Array<{ id: string; action: string; state: string }>;
  id: string;
  personName: string;
  companyName: string | null;
  label: string;
  action: string;
  stepIndex: number;
  stepDay: number;
  due: LocalDate;
  snoozed: boolean;
  state: string;
  foName: string;
  campaignName: string | null;
};

type Props = {
  rows: TaskListRow[];
  selectedId: string | null;
  today: LocalDate;
  showFo: boolean;
  /** URL of a task row with `__ID__` in place of the task id (functions cannot cross to the client). */
  hrefTemplate: string;
  dispositions: DispositionOption[];
  skipReasons: SkipReasonOption[];
  fos: { id: string; name: string }[];
  nextWorkingDay: string;
  canPickSnoozeDate: boolean;
  bulkEnabled: boolean;
};

export function TaskList({ rows, selectedId, today, showFo, hrefTemplate, dispositions, skipReasons, fos, nextWorkingDay, canPickSnoozeDate, bulkEnabled }: Props) {
  const router = useRouter();
  const hrefFor = (id: string) => hrefTemplate.replace('__ID__', encodeURIComponent(id));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [op, setOp] = useState<'complete' | 'skip' | 'snooze' | 'reassign'>('complete');
  const [reasonKey, setReasonKey] = useState(skipReasons[0]?.key ?? 'other');
  const [disposition, setDisposition] = useState(dispositions[0]?.key ?? '');
  const [toDate, setToDate] = useState(nextWorkingDay);
  const [foUserId, setFoUserId] = useState(fos[0]?.id ?? '');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const pendingRows = rows.filter((r) => r.state === 'PENDING');
  const allSelected = pendingRows.length > 0 && pendingRows.slice(0, 200).every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(pendingRows.slice(0, 200).map((r) => r.id)));
  const toggleOne = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else if (n.size < 200) n.add(id);
      return n;
    });
  const selectedHasCalls = rows.some(r => selected.has(r.id) && (r.childActions?.some(a => a.action === 'CALL' && a.state === 'PENDING') ?? r.action === 'CALL'));

  const runBulk = () =>
    start(async () => {
      if (!(await flushTaskDrafts())) { setResult({ ok: false, error: 'Save or copy your draft before continuing.' }); return; }
      const fd = new FormData();
      fd.set('taskIds', rows.filter(r => selected.has(r.id)).flatMap(r => r.childActions ? r.childActions.filter(a => a.state === 'PENDING').map(a => a.id) : [r.id]).join(','));
      fd.set('op', op);
      if (op === 'skip') fd.set('reasonKey', reasonKey);
      if (op === 'snooze') fd.set('toDate', canPickSnoozeDate ? toDate : 'next');
      if (op === 'reassign') fd.set('foUserId', foUserId);
      if (op === 'complete' && selectedHasCalls) fd.set('disposition', disposition);
      try {
        const r = await bulkTasksAction(fd);
        setResult(r);
        if (r.ok) { setSelected(new Set()); router.refresh(); }
      } catch { setResult({ ok: false, error: 'Unable to update these tasks. Please try again.' }); }
    });

  return (
    <div>
      {bulkEnabled ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-white/95 px-3 py-2 text-[12px] backdrop-blur">
          <label className="inline-flex items-center gap-2 font-normal text-ink-500">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!pendingRows.length} />
            {selected.size ? `${selected.size} selected` : pendingRows.length > 200 ? 'Select first 200' : 'Select all'}
          </label>
          {selected.size ? (
            <>
              <select value={op} onChange={(e) => setOp(e.target.value as typeof op)} className="!w-auto !py-1 !text-[12px]">
                <option value="complete">Mark done</option>
                <option value="skip">Skip</option>
                <option value="snooze">Snooze</option>
                {fos.length > 1 ? <option value="reassign">Reassign</option> : null}
              </select>
              {op === 'complete' && selectedHasCalls ? (
                <select value={disposition} onChange={(e) => setDisposition(e.target.value)} className="!w-auto !py-1 !text-[12px]" title="Call outcome for the selected calls">
                  {dispositions.map((d) => (
                    <option key={d.key} value={d.key}>
                      Calls: {d.label}
                    </option>
                  ))}
                </select>
              ) : null}
              {op === 'skip' ? (
                <select value={reasonKey} onChange={(e) => setReasonKey(e.target.value)} className="!w-auto !py-1 !text-[12px]">
                  {skipReasons.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              ) : null}
              {op === 'snooze' && canPickSnoozeDate ? <input type="date" value={toDate} min={nextWorkingDay} onChange={(e) => setToDate(e.target.value)} className="!w-auto !py-1 !text-[12px]" /> : null}
              {op === 'reassign' ? (
                <select value={foUserId} onChange={(e) => setFoUserId(e.target.value)} className="!w-auto !py-1 !text-[12px]">
                  {fos.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={runBulk}>
                Apply
              </button>
            </>
          ) : null}
          {result ? <span className={result.ok ? 'text-emerald-700' : 'text-red-700'}>{result.ok ? result.message : result.error}</span> : null}
        </div>
      ) : null}

      <ul className="divide-y divide-line">
        {rows.map((t) => {
          const overdue = t.state === 'PENDING' && t.due < today;
          const isSelected = t.id === selectedId;
          return (
            <li key={t.id} className={clsx('relative flex items-stretch', isSelected ? 'bg-brand-50/70' : 'hover:bg-canvas/70')}>
              {isSelected ? <span className="absolute inset-y-0 left-0 w-[3px] bg-brand-600" /> : null}
              {bulkEnabled ? (
                <label className="flex items-center pl-3">
                  <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleOne(t.id)} disabled={t.state !== 'PENDING'} aria-label={`Select ${t.personName}`} />
                </label>
              ) : null}
              <Link href={hrefFor(t.id)} className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5">
                <Avatar name={t.personName} shape="circle" size={30} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span data-testid="task-person" className="truncate text-[13.5px] font-medium text-ink-900">{t.personName}</span>
                    <span className={clsx('shrink-0 text-[11.5px] font-medium', overdue ? 'text-red-700' : 'text-ink-700')} title={formatLocalDate(t.due, 'long')}>
                      {t.state === 'PENDING' ? relativeDays(t.due, today) : STATE_LABELS[t.state] ?? t.state}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-600">
                    <ActionIcon action={t.action} size={12} className="text-ink-400" />
                    <span className="truncate">
                      {t.label}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-500">
                    <span className="min-w-0 flex-1 truncate">{t.companyName ?? 'No company'}</span>
                    <span className="shrink-0">Day <span className="font-medium text-ink-700">{t.stepDay}</span></span>
                    {t.snoozed ? <Badge tone="sky">snoozed</Badge> : null}
                  </span>
                  {showFo ? <span className="mt-1 block truncate text-[11px] text-ink-500">FO <span className="font-medium text-ink-700">{t.foName}</span></span> : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
