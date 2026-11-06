'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { IconAlert, IconCheck, IconClose } from '@/components/icons';

/** How a flash reads: done, done with some left out, or refused (`?flashTone=warn|error`). */
export type FlashTone = 'ok' | 'warn' | 'error';

/**
 * The confirmation after an action ("Done.", "Moved to step 3.").
 *
 * It used to be a banner that pushed the page down and stayed until dismissed. This is a toast
 * pinned to the bottom centre, where the eye already is after clicking a button in the action
 * row: it appears, it is readable, and it takes itself away after a few seconds. The message
 * arrives in the URL so it survives the navigation to the next task; dismissing removes it from
 * the URL so a reload does not bring it back. A refusal, or a result that left some out, stays
 * until dismissed and wraps instead of being cut off, so the reason can be read (B148).
 */
export function TaskFlash({ message, tone = 'ok' }: { message: string; tone?: FlashTone }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [visible, setVisible] = useState(true);

  const clear = () => {
    setVisible(false);
    const next = new URLSearchParams(params.toString());
    next.delete('flash');
    next.delete('flashTone');
    router.replace(next.size ? `${pathname}?${next.toString()}` : pathname, { scroll: false });
  };

  useEffect(() => {
    setVisible(true);
    if (tone !== 'ok') return;
    const t = setTimeout(() => setVisible(false), 4500);
    return () => clearTimeout(t);
  }, [message, tone]);

  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-6">
      <div
        role={tone === 'error' ? 'alert' : 'status'}
        aria-live="polite"
        className={clsx('pointer-events-auto flex max-w-[min(90vw,34rem)] items-center gap-2.5 border bg-white/95 py-2 pl-3 pr-2 shadow-pop backdrop-blur', tone === 'ok' ? 'rounded-full border-emerald-200' : tone === 'warn' ? 'rounded-2xl border-amber-200' : 'rounded-2xl border-red-200')}
      >
        <span className={clsx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white', tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-red-600')}>
          {tone === 'ok' ? <IconCheck size={14} /> : <IconAlert size={14} />}
        </span>
        <span className={clsx('min-w-0 flex-1 text-[13px] font-medium text-ink-800', tone === 'ok' && 'truncate')}>{message}</span>
        <button type="button" onClick={clear} className="btn-icon-ghost h-6 w-6 shrink-0" title="Dismiss" aria-label="Dismiss">
          <IconClose size={13} />
        </button>
      </div>
    </div>
  );
}
