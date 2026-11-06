'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * A page that belongs to another section than its address says marks it here, and the sidebar
 * highlights that section: a cold campaign lives at /campaigns/<id> but is part of Cold outreach
 * (cold outreach PLAN 3, 4.4). Pages that say nothing keep the sidebar's own reading of the path.
 */
let current: string | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useActiveSection(): string | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

export function ActiveSection({ href }: { href: string }) {
  useEffect(() => {
    current = href;
    emit();
    return () => { if (current === href) { current = null; emit(); } };
  }, [href]);
  return null;
}
