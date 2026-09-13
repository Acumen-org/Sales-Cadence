'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useRef } from 'react';

/** Merge rapid changes with the latest requested URL, including a pending search debounce. */
export function useFilterNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams().toString();
  const state = useRef({ pathname, observed: params, pending: params, sent: new Set<string>() });
  if (state.current.pathname !== pathname) state.current = { pathname, observed: params, pending: params, sent: new Set() };
  if (state.current.observed !== params) {
    state.current.observed = params;
    if (!state.current.sent.has(params) || params === state.current.pending) {
      state.current.pending = params;
      state.current.sent.clear();
    }
  }
  return useCallback((mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(state.current.pending);
    mutate(next);
    state.current.pending = next.toString();
    state.current.sent.add(state.current.pending);
    router.push(`${pathname}?${state.current.pending}`, { scroll: false });
  }, [pathname, router]);
}
