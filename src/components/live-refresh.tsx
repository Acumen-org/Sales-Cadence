'use client';
import { startTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keeps a screen current without a reload: every 30 seconds, and whenever the person comes back
 * to the tab.
 *
 * Two rules matter. It only refreshes after the window has actually been away, because the browser
 * fires `focus` on arrival too - and a refresh landing while React is still hydrating tears down
 * the tree it is attaching to, which surfaced as an intermittent hydration error on the heaviest
 * page in the app. And it never interrupts someone mid-sentence: an open dialog or a focused input
 * means the refresh waits for the next tick.
 */
export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    let away = false;
    const busy = () =>
      document.visibilityState !== 'visible' ||
      Boolean(document.querySelector('dialog[open]')) ||
      Boolean(document.activeElement?.closest('input,textarea,select,[contenteditable="true"]'));
    const refresh = () => {
      if (busy()) return;
      startTransition(() => router.refresh());
    };
    const onBlur = () => { away = true; };
    const onFocus = () => { if (!away) return; away = false; refresh(); };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [router]);
  return null;
}
