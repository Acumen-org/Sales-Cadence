'use client';
import { useEffect, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { syncNowAction } from '@/lib/actions/admin';
import type { ActionResult } from '@/lib/actions/users';
import { IconRefresh } from '@/components/icons';

/**
 * Every "Run now" (cold outreach PLAN 4.7): the CRM sync by default, or any job's server action, with
 * what it did in a toast. The action revalidates its page, so the card behind the button shows the run.
 */
export function SyncNowButton({ className = 'btn-ghost btn-sm', action = syncNowAction, label = 'Sync now', failed = 'Sync failed. Please try again.' }: {
  className?: string;
  action?: () => Promise<ActionResult>;
  label?: string;
  /** Said when the action itself throws. */
  failed?: string;
}) {
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.error ? 10000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  return <>
    <button type="button" className={className} disabled={pending} aria-busy={pending} onClick={() => start(async () => {
      setNotice(null);
      try {
        const result = await action();
        setNotice({ text: result.ok ? result.message || 'Done.' : result.error, error: !result.ok });
      } catch { setNotice({ text: failed, error: true }); }
    })}><IconRefresh size={14} className={pending ? 'animate-spin' : undefined} /> {label}</button>
    {notice ? createPortal(<div role={notice.error ? 'alert' : 'status'} className={`toast-in fixed bottom-6 right-6 z-50 flex max-w-sm items-center gap-3 rounded-xl px-4 py-3 text-sm shadow-lg ${notice.error ? 'border border-red-200 bg-red-50 text-red-800' : 'bg-ink-900 text-white'}`}>
      <IconRefresh size={15} className={notice.error ? 'text-red-600' : 'text-[#d5e9ad]'} />
      <span>{notice.text}</span><button type="button" aria-label={action === syncNowAction ? 'Dismiss sync notification' : 'Dismiss notification'} onClick={() => setNotice(null)}>&times;</button>
    </div>, document.body) : null}
  </>;
}
