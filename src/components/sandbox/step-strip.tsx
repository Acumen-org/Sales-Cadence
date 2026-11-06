import Link from 'next/link';
import clsx from 'clsx';
import type { PathStepKey, RepPath } from '@/lib/sandbox/path';

/**
 * The rep's path as a strip (PLAN 4): five steps in order, each with the reader's count and a link to
 * where that work is. The step the reader is most behind on is highlighted; on a contact's page the
 * contact's own step is marked instead. With nothing waiting every step is grey and the strip says so.
 */
export function StepStrip({ path, current, className }: { path: RepPath; /** A contact's own step, on its page. */ current?: PathStepKey | null; className?: string }) {
  const marked = current === undefined ? path.behind : current;
  const idle = current === undefined && !path.steps.some((s) => s.count > 0);
  return <nav aria-label="The rep's path" className={clsx('border-t border-line px-3 py-2.5 sm:px-5', className)}>
    <ol className="flex flex-wrap items-stretch gap-1">
      {path.steps.map((s, i) => {
        const on = s.key === marked;
        const grey = idle || (current === undefined && !s.count);
        return <li key={s.key} className="flex min-w-0 items-center gap-1.5">
          {i > 0 ? <span aria-hidden className="self-center text-ink-300">›</span> : null}
          <Link href={s.href} aria-current={on ? 'step' : undefined} className={clsx('flex min-w-0 flex-col rounded-lg border px-2.5 py-1 text-[12.5px] leading-5 transition-colors', on ? 'border-brand-300 bg-brand-50 text-brand-900' : grey ? 'border-transparent text-ink-400 hover:text-ink-600' : 'border-line text-ink-700 hover:border-ink-300')}>
            <span className="flex items-baseline gap-1.5 whitespace-nowrap"><span className={clsx('tabular-nums', on ? 'text-brand-700' : 'text-ink-400')}>{i + 1}</span><span className="font-medium">{s.label}</span></span>
            {current === undefined ? <span className={clsx('whitespace-nowrap text-[11.5px] tabular-nums', grey ? 'text-ink-400' : on ? 'text-brand-800' : 'text-ink-500')}>{s.words}</span> : on ? <span className="whitespace-nowrap text-[11.5px] text-brand-800">This contact is here</span> : null}
          </Link>
        </li>;
      })}
    </ol>
    {idle ? <p className="mt-1.5 px-1 text-[12.5px] text-ink-500">Nothing waiting. New contacts arrive from Bellwether.</p> : null}
  </nav>;
}
