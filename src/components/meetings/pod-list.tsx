'use client';

import { useState, type ReactNode } from 'react';

/**
 * The pod race once there are more pods than fit (owner, 25 Nov 2026: "should be able to accommodate
 * many pods in the future"): the top five, the reader's own pod pinned under them when it is further
 * down, and the whole race a click away. The rows are drawn on the server and handed in.
 */
export function PodList({ count, shown, top, pinned, rest }: { count: number; shown: number; top: ReactNode; pinned: ReactNode; rest: ReactNode }) {
  const [all, setAll] = useState(false);
  return (
    <>
      <ol className="space-y-0.5">
        {top}
        {all ? rest : pinned}
      </ol>
      {count > shown ? (
        <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className="mt-auto self-start py-0.5 text-[12.5px] font-medium text-brand-700 hover:underline">
          {all ? `Show the top ${shown}` : `Show all ${count} pods`}
        </button>
      ) : null}
    </>
  );
}
