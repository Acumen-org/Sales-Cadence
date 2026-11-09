import Link from 'next/link';
import clsx from 'clsx';
import type { ListView } from '@/lib/sandbox/list-view';
import { OtherViews } from './other-views';

type Tab = { view: ListView; label: string; count: number; href: string };

/**
 * The views a rep acts on, as pills with their counts (owner, 9 Nov 2026): My contacts (All for
 * admins and Biz Ops, who own none), To claim, Needs a next step and Ready to move, plus Forms due or
 * Search results while open. Every other view is one choice in "Other views", so the row stays short.
 */
const PILL_ORDER: ListView[] = ['any', 'mine', 'all', 'form_due', 'unclaimed', 'no_next_step', 'ready'];

export function splitViews(tabs: Tab[]): { pills: Tab[]; other: Tab[] } {
  const hasMine = tabs.some((t) => t.view === 'mine');
  const isPill = (v: ListView) => v !== 'all' ? PILL_ORDER.includes(v) : !hasMine;
  const pills = tabs.filter((t) => isPill(t.view)).sort((a, b) => PILL_ORDER.indexOf(a.view) - PILL_ORDER.indexOf(b.view));
  return { pills, other: tabs.filter((t) => !isPill(t.view)) };
}

export function QuickViews({ tabs, current }: { tabs: Tab[]; current: ListView }) {
  const { pills, other } = splitViews(tabs);
  return <nav aria-label="Quick views" className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5 sm:px-5">
    {pills.map((t) => {
      const on = t.view === current;
      return <Link key={t.view} href={t.href} scroll={false} aria-current={on ? 'page' : undefined} className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-medium transition-colors', on ? 'border-brand-300 bg-brand-50 text-brand-900' : 'border-line text-ink-600 hover:border-ink-300 hover:text-ink-800')}>
        {t.label}
        <span className={clsx('rounded-full px-1.5 text-[11.5px] tabular-nums leading-[18px]', on ? 'bg-brand-100 text-brand-800' : 'bg-canvas text-ink-700')}>{t.count}</span>
      </Link>;
    })}
    {other.length ? <OtherViews options={other.map((t) => ({ view: t.view, label: `${t.label} (${t.count})`, href: t.href }))} current={other.some((t) => t.view === current) ? current : null} /> : null}
  </nav>;
}
