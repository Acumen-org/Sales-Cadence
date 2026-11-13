'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { IconAlert, IconCheck, IconClose } from '@/components/icons';

/**
 * A result that survives the refresh (cold outreach B148, B203; PLAN 4.0): the action's words travel
 * in the address as `?flash=`, the way Tasks carries them (TaskFlash), so a button that unmounts when
 * the page re-reads (Claim, Opt out, Pause) never takes its message with it. A refusal stays until it
 * is dismissed; a success fades. Dismissing takes it out of the address, so a reload does not bring
 * it back.
 */

export type FlashTone = 'ok' | 'error';

/** Put a message in the address of this page (or of `to`), with its tone, and re-read the page. */
export function useFlash() {
  const router = useRouter();
  return useCallback((message: string, tone: FlashTone = 'ok', to?: string) => {
    const url = new URL(to ?? window.location.href, window.location.href);
    url.searchParams.set('flash', message.slice(0, 300));
    if (tone === 'error') url.searchParams.set('flashTone', 'error');
    else url.searchParams.delete('flashTone');
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
  }, [router]);
}

/**
 * R09: a toast that fades also leaves the address, so a reload or Back does not show it again. The
 * page is not re-read for it: the address is rewritten in place (Next keeps its router in step).
 */
export function dropFlashFromAddress(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('flash') && !url.searchParams.has('flashTone')) return;
    url.searchParams.delete('flash');
    url.searchParams.delete('flashTone');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch { /* no window or history: nothing to clean */ }
}

/** The toast: bottom centre, green and fading for a result, red and staying for a refusal. */
export function Flash({ message, tone = 'ok' }: { message: string; tone?: FlashTone }) {
  const router = useRouter();
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setVisible(true);
    if (tone === 'error') return;
    const t = setTimeout(() => { setVisible(false); dropFlashFromAddress(); }, 6000);
    return () => clearTimeout(t);
  }, [message, tone]);
  const clear = () => {
    setVisible(false);
    const url = new URL(window.location.href);
    url.searchParams.delete('flash');
    url.searchParams.delete('flashTone');
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
  };
  if (!visible) return null;
  const error = tone === 'error';
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'} className={clsx('pointer-events-auto flex max-w-[min(92vw,40rem)] items-start gap-2.5 rounded-2xl border bg-white/95 py-2 pl-3 pr-2 shadow-pop backdrop-blur', error ? 'border-red-200' : 'border-emerald-200')}>
        <span className={clsx('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white', error ? 'bg-red-600' : 'bg-emerald-500')}>
          {error ? <IconAlert size={14} /> : <IconCheck size={14} />}
        </span>
        <span className="min-w-0 flex-1 py-0.5 text-[13px] font-medium leading-5 text-ink-800">{message}</span>
        <button type="button" onClick={clear} className="btn-icon-ghost h-6 w-6 shrink-0" title="Dismiss" aria-label="Dismiss">
          <IconClose size={13} />
        </button>
      </div>
    </div>
  );
}
