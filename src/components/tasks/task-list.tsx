import Link from 'next/link';
import clsx from 'clsx';
import { cachedPersonName } from '@/lib/person-cache';
import { effectiveDate, type TaskRow } from '@/lib/tasks-query';
import { formatLocalDate, relativeDays, type LocalDate } from '@/lib/dates';
import { ActionIcon } from '@/components/icons';
import { Badge } from '@/components/ui';

type Props = {
  rows: TaskRow[];
  selectedId: string | null;
  today: LocalDate;
  showFo: boolean;
  hrefFor: (taskId: string) => string;
};

export function TaskList({ rows, selectedId, today, showFo, hrefFor }: Props) {
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((t) => {
        const due = effectiveDate(t);
        const overdue = t.state === 'PENDING' && due < today;
        const selected = t.id === selectedId;
        return (
          <li key={t.id}>
            <Link
              href={hrefFor(t.id)}
              className={clsx('flex items-start gap-3 px-4 py-3 text-sm transition-colors hover:bg-slate-50', selected && 'bg-brand-50/60 hover:bg-brand-50/60')}
            >
              <span className={clsx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full', overdue ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-600')}>
                <ActionIcon action={t.chosenAction ?? t.action} size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium text-slate-900">{cachedPersonName(t.enrollment.person)}</span>
                  <span className={clsx('shrink-0 text-xs', overdue ? 'font-medium text-red-600' : 'text-slate-500')} title={formatLocalDate(due, 'long')}>
                    {t.state === 'PENDING' ? relativeDays(due, today) : t.state.toLowerCase()}
                  </span>
                </span>
                <span className="block truncate text-slate-600">
                  {t.label}
                  {t.altAction ? ' (either/or)' : ''} · {t.enrollment.person.companyName ?? 'no company'}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <span>
                    Step {t.stepIndex + 1} · Day {t.stepDay}
                  </span>
                  {t.snoozedTo ? <Badge tone="sky">snoozed</Badge> : null}
                  {showFo ? <span>· {t.fo.name}</span> : null}
                  {t.enrollment.campaign ? <span className="truncate">· {t.enrollment.campaign.name}</span> : null}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
