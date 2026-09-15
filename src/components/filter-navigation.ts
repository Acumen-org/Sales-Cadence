'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, createElement, useCallback, useContext, useRef, type ReactNode, type RefObject } from 'react';

type NavigationState = { pathname: string; observed: string; pending: string; sent: Set<string> };
const NavigationContext = createContext<RefObject<NavigationState | null> | null>(null);

/** All controls in the workspace share the same in-flight URL. */
export function FilterNavigationProvider({ children }: { children: ReactNode }) {
  const state = useRef<NavigationState | null>(null);
  return createElement(NavigationContext.Provider, { value: state }, children);
}

/** Merge rapid changes with the latest requested URL, including a pending search debounce. */
export function useFilterNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams().toString();
  const shared = useContext(NavigationContext);
  const local = useRef<NavigationState | null>(null);
  const state = shared ?? local;
  if (!state.current) state.current = { pathname, observed: params, pending: params, sent: new Set<string>() };
  if (state.current.pathname !== pathname) state.current = { pathname, observed: params, pending: params, sent: new Set() };
  if (state.current.observed !== params) {
    state.current.observed = params;
    if (!state.current.sent.has(params) || params === state.current.pending) {
      state.current!.pending = params;
      state.current.sent.clear();
    }
  }
  return useCallback((mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(state.current!.pending);
    mutate(next);
    state.current!.pending = next.toString();
    state.current!.sent.add(state.current!.pending);
    router.push(`${pathname}?${state.current!.pending}`, { scroll: false });
  }, [pathname, router, state]);
}
