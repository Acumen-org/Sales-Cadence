'use client';

import { ActionButton } from '@/components/action-form';
import { acceptSuggestionAction, dismissSuggestionAction } from '@/lib/actions/call-forms';

/**
 * A colleague's suggested next step (B027), on the contact it is about: who suggested what, and
 * Accept as next step (through the same checks as setting one by hand) or Dismiss.
 */
export function SuggestionList({ items }: { items: { id: string; from: string; words: string }[] }) {
  if (!items.length) return null;
  return <ul className="space-y-2" aria-label="Suggested next steps">
    {items.map((s) => <li key={s.id} className="rounded-xl border border-sky-200 bg-sky-50/60 px-3 py-2 text-[13px]">
      <p className="text-ink-800"><span className="font-medium">{s.from}</span> suggests: {s.words}</p>
      <span className="mt-1.5 flex flex-wrap gap-2">
        <ActionButton action={acceptSuggestionAction} payload={{ id: s.id }} className="btn-secondary btn-sm" refresh>Accept as next step</ActionButton>
        <ActionButton action={dismissSuggestionAction} payload={{ id: s.id }} className="btn-ghost btn-sm" refresh>Dismiss</ActionButton>
      </span>
    </li>)}
  </ul>;
}
