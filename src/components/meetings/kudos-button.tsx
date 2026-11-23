'use client';

import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { toggleKudosAction } from '@/lib/actions/meeting-kudos';

/** A cheer on a colleague's meeting (owner, 21 Nov 2026; words, not emojis, since 23 Nov). Your own shows the count only. */
export function KudosButton({ meetingId, count, mine, own, who }: { meetingId: string; count: number; mine: boolean; own: boolean; who: string }) {
  const [state, setState] = useState({ count, mine });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const label = own ? `${state.count} ${state.count === 1 ? 'cheer' : 'cheers'} for your meeting` : state.mine ? `Take back your cheer for ${who}` : `Cheer ${who}'s meeting`;
  if (own) {
    return state.count ? <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-0.5 text-[12px] tabular-nums text-ink-600" title={label} aria-label={label}>{state.count} {state.count === 1 ? 'cheer' : 'cheers'}</span> : null;
  }
  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        aria-pressed={state.mine}
        aria-label={label}
        title={error ?? label}
        disabled={pending}
        onClick={() => start(async () => {
          // Shown at once, put right by the answer.
          setState((s) => ({ count: s.count + (s.mine ? -1 : 1), mine: !s.mine }));
          const r = await toggleKudosAction(meetingId);
          if (r.ok) { setState({ count: r.kudos, mine: r.mine }); setError(null); } else { setState({ count, mine }); setError(r.error); }
        })}
        className={clsx(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] tabular-nums transition-[transform,background-color] active:scale-95',
          state.mine ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-line bg-white text-ink-600 hover:border-amber-200 hover:bg-amber-50/60',
        )}
      >
        <span aria-hidden>{state.mine ? 'Cheered' : 'Cheer'}</span>{state.count ? <span aria-hidden className="font-semibold">{state.count}</span> : null}
      </button>
      {error ? <span role="status" className="mt-0.5 text-[11px] text-red-700">{error}</span> : null}
    </span>
  );
}
