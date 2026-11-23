'use client';

import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { toggleKudosAction } from '@/lib/actions/meeting-kudos';

/** Two sparkles: the cheer's mark, drawn, so it needs no emoji. */
function Sparkle({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden className="shrink-0" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M10 3.5l1.9 5.1 5.1 1.9-5.1 1.9L10 17.5l-1.9-5.1L3 10.5l5.1-1.9z" />
      <path d="M18 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
    </svg>
  );
}

/**
 * A cheer on a colleague's meeting (owner, 21 Nov 2026; drawn, not an emoji, since 23 Nov: "says
 * what it is for, but could look nicer"). Pressed, it fills in the brand green with a little pop
 * (still for reduced motion). Your own meeting shows how many cheers it has, when it has any.
 */
export function KudosButton({ meetingId, count, mine, own, who }: { meetingId: string; count: number; mine: boolean; own: boolean; who: string }) {
  const [state, setState] = useState({ count, mine });
  const [error, setError] = useState<string | null>(null);
  const [popped, setPopped] = useState(0);
  const [pending, start] = useTransition();
  const label = own ? `${state.count} ${state.count === 1 ? 'cheer' : 'cheers'} for your meeting` : state.mine ? `Take back your cheer for ${who}` : `Cheer ${who}'s meeting`;
  if (own) {
    return state.count ? (
      <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-brand-50 px-2.5 text-[12px] font-medium tabular-nums text-brand-800" title={label} aria-label={label}>
        <Sparkle filled />{state.count}
      </span>
    ) : null;
  }
  return (
    <span className="inline-flex shrink-0 flex-col items-end">
      <button
        type="button"
        aria-pressed={state.mine}
        aria-label={label}
        title={error ?? label}
        disabled={pending}
        onClick={() => start(async () => {
          // Shown at once, put right by the answer (or back to how it was).
          const before = state;
          if (!before.mine) setPopped((n) => n + 1);
          setState({ count: before.count + (before.mine ? -1 : 1), mine: !before.mine });
          const r = await toggleKudosAction(meetingId);
          if (r.ok) { setState({ count: r.kudos, mine: r.mine }); setError(null); } else { setState(before); setError(r.error); }
        })}
        className={clsx(
          'group inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium tabular-nums transition-[background-color,border-color,color,transform] duration-150 active:scale-95 disabled:cursor-wait',
          state.mine
            ? 'border-brand-600 bg-brand-600 text-white hover:bg-brand-700'
            : 'border-brand-200 bg-white text-brand-700 hover:border-brand-300 hover:bg-brand-50',
        )}
      >
        <span key={popped} className={clsx('inline-flex', popped && state.mine ? 'cheer-pop' : '')}><Sparkle filled={state.mine} /></span>
        <span aria-hidden>{state.mine ? 'Cheered' : 'Cheer'}</span>
        {state.count ? <span aria-hidden className={clsx('-mr-0.5 rounded-full px-1.5 text-[11px] leading-[18px]', state.mine ? 'bg-white/20' : 'bg-brand-50 group-hover:bg-white')}>{state.count}</span> : null}
      </button>
      {error ? <span role="status" className="mt-0.5 text-[11px] text-red-700">{error}</span> : null}
    </span>
  );
}
