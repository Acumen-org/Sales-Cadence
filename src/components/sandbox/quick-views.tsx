import Link from 'next/link';
import clsx from 'clsx';
import type { ListView } from '@/lib/sandbox/list-view';

/**
 * The contacts list's quick views, each with its count (PLAN 4.1). They wrap rather than scroll, so
 * every view and its count is in sight at 1024px (B153).
 */
export function QuickViews({ tabs, current }: { tabs: { view: ListView; label: string; count: number; href: string }[]; current: ListView }) {
  return <nav aria-label="Quick views" className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2.5 sm:px-5">
    {tabs.map((t) => {
      const on = t.view === current;
      return <Link key={t.view} href={t.href} scroll={false} aria-current={on ? 'page' : undefined} className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-medium transition-colors', on ? 'border-brand-300 bg-brand-50 text-brand-900' : 'border-line text-ink-600 hover:border-ink-300 hover:text-ink-800')}>
        {t.label}
        <span className={clsx('rounded-full px-1.5 text-[11.5px] tabular-nums leading-[18px]', on ? 'bg-brand-100 text-brand-800' : 'bg-canvas text-ink-700')}>{t.count}</span>
      </Link>;
    })}
  </nav>;
}
