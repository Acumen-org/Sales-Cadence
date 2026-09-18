'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toggleMeetingFavouriteAction } from '@/lib/actions/meetings';
import { IconStar } from '@/components/icons';

/**
 * The star on a meeting: filled when this user has kept it. It answers by filling or emptying and
 * says nothing else - the star is the whole message. If the save fails it springs back.
 */
export function FavouriteButton({ meetingId, favourite, compact = false }: { meetingId: string; favourite: boolean; compact?: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(favourite);
  const [pending, start] = useTransition();
  const toggle = () => {
    const next = !on;
    setOn(next);
    start(async () => {
      const fd = new FormData();
      fd.set('meetingId', meetingId);
      const r = await toggleMeetingFavouriteAction(fd);
      if (!r.ok) setOn(!next);
      else router.refresh();
    });
  };
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={on}
      aria-label={compact ? (on ? 'Remove from favourites' : 'Add to favourites') : undefined}
      title={on ? 'Remove from favourites' : 'Add to favourites'}
      className={compact ? `btn-icon-ghost ${on ? 'text-amber-500' : 'text-ink-300 hover:text-amber-500'}` : `btn-secondary btn-sm ${on ? 'text-amber-600' : ''}`}
    >
      <IconStar size={compact ? 16 : 14} filled={on} />
      {compact ? null : on ? 'Favourite' : 'Add to favourites'}
    </button>
  );
}
