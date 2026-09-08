'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { IconCheck, IconClose } from '@/components/icons';

/**
 * The confirmation after an action ("Done.", "Moved to step 3.").
 *
 * It used to be a banner that pushed the page down and stayed until dismissed. This is a toast
 * pinned to the bottom centre, where the eye already is after clicking a button in the action
 * row: it appears, it is readable, and it takes itself away after a few seconds. The message
 * arrives in the URL so it survives the navigation to the next task; dismissing removes it from
 * the URL so a reload does not bring it back.
 */
export function TaskFlash({ message }: { message: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [visible, setVisible] = useState(true);

  const clear = () => {
    setVisible(false);
    const next = new URLSearchParams(params.toString());
    next.delete('flash');
    router.replace(next.size ? `${pathname}?${next.toString()}` : pathname, { scroll: false });
  };

  useEffect(() => {
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 4500);
    return () => clearTimeout(t);
  }, [message]);

  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-6">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-[min(90vw,34rem)] items-center gap-2.5 rounded-full border border-emerald-200 bg-white/95 py-2 pl-3 pr-2 shadow-pop backdrop-blur"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
          <IconCheck size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-800">{message}</span>
        <button type="button" onClick={clear} className="btn-icon-ghost h-6 w-6 shrink-0" title="Dismiss" aria-label="Dismiss">
          <IconClose size={13} />
        </button>
      </div>
    </div>
  );
}
