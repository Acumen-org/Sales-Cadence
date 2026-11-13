'use client';

import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

/**
 * R21: a Reports link built before the breakdown switched in place still names the old table. The
 * corrected address, or null when the link is not a Reports page link carrying another table.
 */
export function withOpenTab(href: string, current: string, here: string): string | null {
  const url = new URL(href, here);
  if (url.origin !== new URL(here).origin || url.pathname !== '/reports' || !url.searchParams.has('tab') || url.searchParams.get('tab') === current) return null;
  url.searchParams.set('tab', current);
  return url.pathname + url.search;
}

/**
 * The breakdown tabs switch in place: every table is already on the page, so a click shows it
 * without asking the server to rebuild both periods' reports. Each tab is still a real link, so
 * the address follows and a shared or reloaded page opens on the same table.
 */
export function BreakdownSwitch({ initial, panels }: { initial: string; panels: { key: string; label: string; href: string; node: ReactNode }[] }) {
  const [current, setCurrent] = useState(initial);
  const router = useRouter();
  // R21: once switched, every other Reports link on the page (Outreach / Calls, the pager) keeps the table now open.
  useEffect(() => {
    if (current === initial) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!a || a.target === '_blank' || a.dataset.breakdownTab) return;
      const next = withOpenTab(a.href, current, window.location.href);
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      router.push(next);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [current, initial, router]);
  return (
    <>
      <div className="flex gap-3 overflow-x-auto border-b border-line px-3 scroll-thin sm:gap-5 sm:px-5">
        {panels.map((t) => {
          const active = t.key === current;
          return (
            <a
              key={t.key}
              href={t.href}
              data-breakdown-tab={t.key}
              aria-current={active ? 'page' : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                setCurrent(t.key);
                window.history.replaceState(window.history.state, '', t.href);
              }}
              className={clsx(
                'flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 py-3 text-[13px] font-medium transition-colors',
                active ? 'border-brand-600 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-700',
              )}
            >
              {t.label}
            </a>
          );
        })}
      </div>
      {panels.map((t) => (
        <div key={t.key} hidden={t.key !== current} className="p-4">{t.node}</div>
      ))}
    </>
  );
}
