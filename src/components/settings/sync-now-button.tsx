'use client';
import { useEffect, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { syncNowAction } from '@/lib/actions/admin';
import { IconRefresh } from '@/components/icons';

export function SyncNowButton({ className = 'btn-ghost btn-sm' }: { className?: string }) {
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
        const result = await syncNowAction();
        setNotice({ text: result.ok ? result.message || 'Synced.' : result.error, error: !result.ok });
      } catch { setNotice({ text: 'Sync failed. Please try again.', error: true }); }
    })}><IconRefresh size={14} className={pending ? 'animate-spin' : undefined} /> Sync now</button>
    {notice ? createPortal(<div role={notice.error ? 'alert' : 'status'} className={`toast-in fixed bottom-6 right-6 z-50 flex max-w-sm items-center gap-3 rounded-xl px-4 py-3 text-sm shadow-lg ${notice.error ? 'border border-red-200 bg-red-50 text-red-800' : 'bg-ink-900 text-white'}`}>
      <IconRefresh size={15} className={notice.error ? 'text-red-600' : 'text-[#d5e9ad]'} />
      <span>{notice.text}</span><button type="button" aria-label="Dismiss sync notification" onClick={() => setNotice(null)}>&times;</button>
    </div>, document.body) : null}
  </>;
}
