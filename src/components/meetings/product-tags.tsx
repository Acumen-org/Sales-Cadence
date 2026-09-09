'use client';

import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { toggleMeetingProductAction } from '@/lib/actions/meetings';
import { optionLabel } from '@/lib/twenty/labels';
import { PRODUCTS } from '@/lib/workspace';
import { IconCheck } from '@/components/icons';

/**
 * Which products a meeting was about. A conversation can cover more than one, so these are tags
 * rather than a choice, and they are toggled here rather than through the edit form: tagging is
 * something you do while reading the notes.
 *
 * Read-only for anyone who cannot manage the meeting, which is the same rule the rest of the
 * record follows - they still see what it was about.
 */
export function ProductTags({ meetingId, products, canEdit }: { meetingId: string; products: string[]; canEdit: boolean }) {
  const [pending, start] = useTransition();
  const [current, setCurrent] = useState(products);
  const [error, setError] = useState('');

  if (!canEdit) {
    return current.length ? (
      <div className="flex flex-wrap gap-1.5">
        {current.map((p) => (
          <span key={p} className="rounded-lg bg-brand-50 px-2.5 py-1 text-[12px] font-medium text-brand-800">{optionLabel(p)}</span>
        ))}
      </div>
    ) : (
      <span className="text-[13px] text-ink-500">No product tagged</span>
    );
  }

  const toggle = (product: string) => {
    const on = current.includes(product);
    setCurrent((list) => (on ? list.filter((p) => p !== product) : PRODUCTS.filter((p) => p === product || list.includes(p))));
    setError('');
    start(async () => {
      const fd = new FormData();
      fd.set('meetingId', meetingId);
      fd.set('product', product);
      fd.set('on', String(!on));
      const result = await toggleMeetingProductAction(fd);
      // Whatever the server stored is the truth, whether it agreed with us or not.
      if (result.ok) setCurrent((result.data as { products: string[] }).products);
      else {
        setCurrent((list) => (on ? PRODUCTS.filter((p) => p === product || list.includes(p)) : list.filter((p) => p !== product)));
        setError(result.error);
      }
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {PRODUCTS.map((product) => {
          const on = current.includes(product);
          return (
            <button
              key={product}
              type="button"
              disabled={pending}
              aria-pressed={on}
              onClick={() => toggle(product)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium transition disabled:opacity-60',
                on ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-line bg-white text-ink-600 hover:border-ink-300',
              )}
            >
              {on ? <IconCheck size={12} /> : null}
              {optionLabel(product)}
            </button>
          );
        })}
      </div>
      {error ? <p role="alert" className="text-[12px] font-medium text-red-700">{error}</p> : null}
    </div>
  );
}
