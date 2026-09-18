'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/** Refreshes the page once when the server says the record moved since it was painted. */
export function RefreshWhenChanged({ changed }: { changed: boolean }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (!changed || done.current) return;
    done.current = true;
    router.refresh();
  }, [changed, router]);
  return null;
}
