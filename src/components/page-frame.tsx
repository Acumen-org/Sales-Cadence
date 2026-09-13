'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Authenticated page data and permissions still resolve on the server. Mount the page body
 * after the shell hydrates: this Next/React combination can re-enter an already claimed host
 * element when a streamed child suspends during hydration. Normal client rendering handles
 * those streamed children correctly. Keep the frame mounted across filter/action updates.
 */
export function PageFrame({ children, className }: { children: ReactNode; className?: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return <div className={className}>{ready ? children : <div role="status" className="surface flex min-h-48 items-center justify-center text-sm text-ink-600">Loading workspace…</div>}</div>;
}
