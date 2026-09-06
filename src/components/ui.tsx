import Link from 'next/link';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-white px-6 py-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle ? <div className="mt-0.5 text-sm text-slate-500">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('p-6', className)}>{children}</div>;
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={clsx('card', className)}>
      {title || actions ? (
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}

const BADGE_TONES: Record<string, string> = {
  gray: 'bg-slate-100 text-slate-700',
  blue: 'bg-brand-50 text-brand-700',
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  purple: 'bg-violet-50 text-violet-700',
  sky: 'bg-sky-50 text-sky-700',
};

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({ children, tone = 'gray', className }: { children: ReactNode; tone?: BadgeTone; className?: string }) {
  return <span className={clsx('badge', BADGE_TONES[tone], className)}>{children}</span>;
}

export const ENROLLMENT_TONE: Record<string, BadgeTone> = {
  ACTIVE: 'blue',
  PAUSED: 'amber',
  REPLIED: 'green',
  MEETING: 'purple',
  COMPLETED: 'gray',
  EXITED: 'red',
};

export const TASK_TONE: Record<string, BadgeTone> = {
  PENDING: 'blue',
  DONE: 'green',
  SKIPPED: 'amber',
  CANCELLED: 'gray',
};

export const CAMPAIGN_TONE: Record<string, BadgeTone> = {
  DRAFT: 'gray',
  ACTIVE: 'blue',
  PAUSED: 'amber',
  STOPPED: 'red',
  COMPLETED: 'green',
};

export function EmptyState({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="text-sm font-medium text-slate-700">{title}</div>
      {hint ? <div className="max-w-md text-sm text-slate-500">{hint}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Tabs({ tabs, current }: { tabs: { key: string; label: ReactNode; href: string; count?: number }[]; current: string }) {
  return (
    <div className="flex gap-1 border-b border-slate-200 px-6">
      {tabs.map((t) => {
        const active = t.key === current;
        return (
          <Link
            key={t.key}
            href={t.href}
            className={clsx(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium',
              active ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
            )}
          >
            {t.label}
            {typeof t.count === 'number' ? (
              <span className={clsx('rounded-full px-1.5 text-xs', active ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-600')}>{t.count}</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'warn' | 'good' }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold', tone === 'warn' ? 'text-amber-600' : tone === 'good' ? 'text-emerald-600' : 'text-slate-900')}>{value}</div>
      {hint ? <div className="text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode }) {
  const cls = {
    info: 'bg-sky-50 text-sky-800 border-sky-200',
    warn: 'bg-amber-50 text-amber-800 border-amber-200',
    error: 'bg-red-50 text-red-800 border-red-200',
    success: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  }[tone];
  return <div className={clsx('rounded-md border px-3 py-2 text-sm', cls)}>{children}</div>;
}

export function Field({ label, children, hint, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={clsx('space-y-1', className)}>
      <label className="block">{label}</label>
      {children}
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function KeyValue({ items }: { items: { k: string; v: ReactNode }[] }) {
  return (
    <dl className="kv grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
      {items.map((it) => (
        <div key={it.k} className="contents">
          <dt className="pt-0.5">{it.k}</dt>
          <dd className="min-w-0 break-words">{it.v ?? <span className="text-slate-400">-</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pill({ children }: { children: ReactNode }) {
  return <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">{children}</span>;
}
