'use client';

import clsx from 'clsx';
import { useState, type ReactNode } from 'react';

/**
 * The breakdown tabs switch in place: every table is already on the page, so a click shows it
 * without asking the server to rebuild both periods' reports. Each tab is still a real link, so
 * the address follows and a shared or reloaded page opens on the same table.
 */
export function BreakdownSwitch({ initial, panels }: { initial: string; panels: { key: string; label: string; href: string; node: ReactNode }[] }) {
  const [current, setCurrent] = useState(initial);
  return (
    <>
      <div className="flex gap-3 overflow-x-auto border-b border-line px-3 scroll-thin sm:gap-5 sm:px-5">
        {panels.map((t) => {
          const active = t.key === current;
          return (
            <a
              key={t.key}
              href={t.href}
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
