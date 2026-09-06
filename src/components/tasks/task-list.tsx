'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { bulkTasksAction } from '@/lib/actions/tasks';
import type { ActionResult } from '@/lib/actions/users';
import { relativeDays, formatLocalDate, type LocalDate } from '@/lib/dates';
import { ActionIcon } from '@/components/icons';
import { Badge } from '@/components/ui';
import type { DispositionOption, SkipReasonOption } from './task-actions';

/** Serialisable row for the client list. */
export type TaskListRow = {
  id: string;
  personName: string;
  companyName: string | null;
  label: string;
  action: string;
  altAction: string | null;
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
  hrefFor: (taskId: string) => string;
  dispositions: DispositionOption[];
  skipReasons: SkipReasonOption[];
  fos: { id: string; name: string }[];
  nextWorkingDay: string;
  canPickSnoozeDate: boolean;
  bulkEnabled: boolean;
};

export function TaskList({ rows, selectedId, today, showFo, hrefFor, dispositions, skipReasons, fos, nextWorkingDay, canPickSnoozeDate, bulkEnabled }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [op, setOp] = useState<'complete' | 'skip' | 'snooze' | 'reassign'>('complete');
  const [reasonKey, setReasonKey] = useState(skipReasons[0]?.key ?? 'other');
  const [disposition, setDisposition] = useState(dispositions[0]?.key ?? '');
  const [toDate, setToDate] = useState(nextWorkingDay);
  const [foUserId, setFoUserId] = useState(fos[0]?.id ?? '');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const pendingRows = rows.filter((r) => r.state === 'PENDING');
  const allSelected = pendingRows.length > 0 && pendingRows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(pendingRows.map((r) => r.id)));
  const toggleOne = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectedHasCalls = [...selected].some((id) => rows.find((r) => r.id === id)?.action === 'CALL');

  const runBulk = () =>
    start(async () => {
      const fd = new FormData();
      fd.set('taskIds', [...selected].join(','));
      fd.set('op', op);
      if (op === 'skip') fd.set('reasonKey', reasonKey);
      if (op === 'snooze') fd.set('toDate', canPickSnoozeDate ? toDate : 'next');
      if (op === 'reassign') fd.set('foUserId', foUserId);
      if (op === 'complete' && selectedHasCalls) fd.set('disposition', disposition);
      const r = await bulkTasksAction(fd);
      setResult(r);
      if (r.ok) {
        setSelected(new Set());
        router.refresh();
      }
    });

  return (
    <div>
      {bulkEnabled ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs">
          <label className="inline-flex items-center gap-1.5 font-normal text-slate-600">
            <input type="checkbox" className="h-3.5 w-3.5 rounded" checked={allSelected} onChange={toggleAll} disabled={!pendingRows.length} /> {selected.size ? `${selected.size} selected` : 'Select all'}
          </label>
          {selected.size ? (
            <>
              <select value={op} onChange={(e) => setOp(e.target.value as typeof op)} className="py-1 text-xs">
                <option value="complete">Mark done</option>
                <option value="skip">Skip</option>
                <option value="snooze">Snooze</option>
                {fos.length > 1 ? <option value="reassign">Reassign</option> : null}
              </select>
              {op === 'complete' && selectedHasCalls ? (
                <select value={disposition} onChange={(e) => setDisposition(e.target.value)} className="py-1 text-xs" title="Call outcome for the selected calls">
                  {dispositions.map((d) => (
                    <option key={d.key} value={d.key}>
                      Calls: {d.label}
                    </option>
                  ))}
                </select>
              ) : null}
              {op === 'skip' ? (
                <select value={reasonKey} onChange={(e) => setReasonKey(e.target.value)} className="py-1 text-xs">
                  {skipReasons.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              ) : null}
              {op === 'snooze' && canPickSnoozeDate ? <input type="date" value={toDate} min={nextWorkingDay} onChange={(e) => setToDate(e.target.value)} className="py-1 text-xs" /> : null}
              {op === 'reassign' ? (
                <select value={foUserId} onChange={(e) => setFoUserId(e.target.value)} className="py-1 text-xs">
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
      <ul className="divide-y divide-slate-100">
        {rows.map((t) => {
          const overdue = t.state === 'PENDING' && t.due < today;
          const isSelected = t.id === selectedId;
          return (
            <li key={t.id} className={clsx('flex items-stretch', isSelected && 'bg-brand-50/60')}>
              {bulkEnabled ? (
                <label className="flex items-center pl-3">
                  <input type="checkbox" className="h-3.5 w-3.5 rounded" checked={selected.has(t.id)} onChange={() => toggleOne(t.id)} disabled={t.state !== 'PENDING'} aria-label={`Select ${t.personName}`} />
                </label>
              ) : null}
              <Link href={hrefFor(t.id)} className="flex flex-1 items-start gap-3 px-3 py-3 text-sm transition-colors hover:bg-slate-50">
                <span className={clsx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full', overdue ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-600')}>
                  <ActionIcon action={t.action} size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium text-slate-900">{t.personName}</span>
                    <span className={clsx('shrink-0 text-xs', overdue ? 'font-medium text-red-600' : 'text-slate-500')} title={formatLocalDate(t.due, 'long')}>
                      {t.state === 'PENDING' ? relativeDays(t.due, today) : t.state.toLowerCase()}
                    </span>
                  </span>
                  <span className="block truncate text-slate-600">
                    {t.label}
                    {t.altAction ? ' (either/or)' : ''} · {t.companyName ?? 'no company'}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                    <span>
                      Step {t.stepIndex + 1} · Day {t.stepDay}
                    </span>
                    {t.snoozed ? <Badge tone="sky">snoozed</Badge> : null}
                    {showFo ? <span>· {t.foName}</span> : null}
                    {t.campaignName ? <span className="truncate">· {t.campaignName}</span> : null}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
