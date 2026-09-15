'use client';

import { useId, useState } from 'react';

/**
 * A row of tags that never becomes a paragraph: the first few, then "+N" to see the rest in
 * place. One row height whatever the data holds, and the whole set is one click away, by
 * pointer, touch or keyboard.
 */
export function PillList({ items, max = 2, noun = 'tags' }: { items: { label: string; node: React.ReactNode }[]; max?: number; noun?: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const unique = items.filter((item, index) => items.findIndex((other) => other.label.toLowerCase() === item.label.toLowerCase()) === index);
  const shown = expanded ? unique : unique.slice(0, max);
  const remaining = unique.length - max;
  return (
    <div id={id} className={`flex min-w-0 max-w-full items-center gap-1.5 ${expanded ? 'flex-wrap' : 'flex-nowrap'}`}>
      {shown.map((item) => <span className="min-w-0 max-w-full" key={item.label}>{item.node}</span>)}
      {remaining > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={expanded ? `Show fewer ${noun}` : `Show ${remaining} more ${noun}`}
          title={expanded ? undefined : unique.slice(max).map((item) => item.label).join(', ')}
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 rounded-md px-1 py-1 text-[11.5px] font-semibold text-ink-600 hover:bg-brand-50 hover:text-brand-800 focus-visible:ring-2 focus-visible:ring-brand-300"
        >
          {expanded ? 'Less' : `+${remaining}`}
        </button>
      ) : null}
    </div>
  );
}
