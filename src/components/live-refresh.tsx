'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible' && !document.querySelector('dialog[open]') && !document.activeElement?.closest('input,textarea,select,[contenteditable="true"]')) router.refresh(); };
    const timer = setInterval(refresh, 30000); window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [router]);
  return null;
}
