'use client';
import { startTransition, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/**
 * Keeps a screen current without a reload: every minute, when something actually changed, and
 * whenever the person comes back to the tab.
 *
 * Two rules matter. It only refreshes after the window has actually been away, because the browser
 * fires `focus` on arrival too - and a refresh landing while React is still hydrating tears down
 * the tree it is attaching to, which surfaced as an intermittent hydration error on the heaviest
 * page in the app. And it never interrupts someone mid-sentence: an open dialog or a focused input
 * means the refresh waits for the next tick.
 */
export function LiveRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    let away = false;
    let version: number | null = null;
    const navigatedAt = Date.now();
    const busy = () =>
      document.visibilityState !== 'visible' ||
      Boolean(document.querySelector('dialog[open]')) ||
      Boolean(document.activeElement?.closest('input,textarea,select,[contenteditable="true"]'));
    const refresh = () => {
      if (busy()) return false;
      startTransition(() => router.refresh());
      return true;
    };
    // Ask whether anything changed before re-rendering anything: a refresh that lands on top of a
    // click is what "laggy" felt like, so the timer now only refreshes when the data moved, and
    // never within two seconds of a navigation.
    const check = async () => {
      if (busy()) return;
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const { version: latest } = (await res.json()) as { version: number | null };
        if (latest === null) return;
        if (version !== null && latest !== version) {
          if (Date.now() - navigatedAt < 2000 || !refresh()) return;
        }
        version = latest;
      } catch {
        // Offline or a hiccup: the next tick asks again.
      }
    };
    const onBlur = () => { away = true; };
    const onFocus = () => { if (!away) return; away = false; refresh(); };
    const timer = setInterval(() => void check(), 60000);
    void check();
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
    // A new pathname restarts the effect, which is what resets `navigatedAt`.
  }, [router, pathname]);
  return null;
}
