'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Recent wins fills its card exactly (owner, 23 Nov 2026: "should not have empty space at the
 * bottom"). Beside the other cards (three columns), the list takes the height they give the row and
 * shows as many whole rows as fit, never half of one; stacked on a phone it shows the first `stacked`.
 */
export function FitList({ children, stacked, label }: { children: ReactNode; stacked: number; label: string }) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const ul = list.current;
    if (!ul) return;
    const wide = window.matchMedia('(min-width: 1024px)');
    const fit = () => {
      const rows = Array.from(ul.children) as HTMLElement[];
      for (const row of rows) row.style.display = '';
      // display, not the hidden attribute: each row is a flex row, and .flex outranks [hidden].
      if (!wide.matches) { rows.forEach((row, i) => { row.style.display = i >= stacked ? 'none' : ''; }); return; }
      const bottom = ul.clientHeight;
      let full = false;
      for (const row of rows) {
        if (full || row.offsetTop + row.offsetHeight > bottom) { row.style.display = 'none'; full = true; }
      }
    };
    fit();
    // Rows change height after this first fit (the cheer buttons load, the font arrives, a name
    // wraps differently), so any change in the list or in a row fits it again.
    const seen = new ResizeObserver(() => fit());
    seen.observe(ul);
    for (const row of Array.from(ul.children)) seen.observe(row);
    void document.fonts?.ready.then(fit);
    wide.addEventListener('change', fit);
    return () => { seen.disconnect(); wide.removeEventListener('change', fit); };
  }, [stacked]);
  return (
    <div className="relative min-h-0 flex-1 lg:min-h-[180px]">
      <ul ref={list} aria-label={label} className="space-y-2.5 lg:absolute lg:inset-0 lg:overflow-hidden">{children}</ul>
    </div>
  );
}
