'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { COLD_OUTREACH_BASE } from '@/lib/cold-outreach-paths';

/*
 * The way back to the contacts list keeps its view and filters (B192). The list remembers its own
 * address for this browser tab; the contact page's crumb and anything that returns to the list read it.
 */

const KEY = 'cold-outreach:list';

/** The list's address worth coming back to: its view and filters, never a flash message. */
export function keptListUrl(pathname: string, query: string): string {
  const p = new URLSearchParams(query);
  p.delete('flash');
  p.delete('flashTone');
  const q = p.toString();
  return q ? `${pathname}?${q}` : pathname;
}

/** Put on the list: remembers where the reader is in it. */
export function RememberList() {
  const pathname = usePathname();
  const params = useSearchParams();
  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, keptListUrl(pathname, params.toString()));
    } catch {
      // Storage switched off: the way back opens the list as it first opens.
    }
  }, [pathname, params]);
  return null;
}

/** Where the reader left the list, or the list itself. */
export function lastListHref(): string {
  try {
    const v = sessionStorage.getItem(KEY);
    if (v && (v === COLD_OUTREACH_BASE || v.startsWith(`${COLD_OUTREACH_BASE}?`))) return v;
  } catch {
    // Storage switched off.
  }
  return COLD_OUTREACH_BASE;
}

/** A link back to the contacts list as the reader left it: the contact page's "Cold outreach" crumb. */
export function ColdListLink({ children, className }: { children: ReactNode; className?: string }) {
  const [href, setHref] = useState(COLD_OUTREACH_BASE);
  useEffect(() => setHref(lastListHref()), []);
  return <Link href={href} className={className}>{children}</Link>;
}
