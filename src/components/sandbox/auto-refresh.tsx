'use client';

import { startTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** A page whose state the worker is still changing (a move in progress) reads itself again every few seconds. */
export function AutoRefresh({ everyMs = 4000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => { if (!document.querySelector('dialog[open]')) startTransition(() => router.refresh()); }, everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return null;
}
