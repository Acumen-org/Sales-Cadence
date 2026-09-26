'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-reads one record from Twenty once the page has painted, and refreshes the page once when the
 * record changed there. It asks from the browser, outside the page's render: an action on the
 * record never waits for Twenty, and a gateway that is down shows nothing.
 */
export function RecordSync({ kind, id }: { kind: 'person' | 'company'; id: string }) {
  const router = useRouter();
  useEffect(() => {
    let live = true;
    fetch(`/api/record-sync?kind=${kind}&id=${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<{ changed?: boolean }>) : null))
      .then((r) => { if (live && r?.changed) router.refresh(); })
      .catch(() => { /* the next visit asks again */ });
    return () => { live = false; };
  }, [kind, id, router]);
  return null;
}
