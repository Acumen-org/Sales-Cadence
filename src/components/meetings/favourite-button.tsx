'use client';

import { toggleMeetingFavouriteAction } from '@/lib/actions/meetings';
import { ActionButton } from '@/components/action-form';
import { IconStar } from '@/components/icons';

/** The star on a meeting: filled when this user has kept it, one click either way. */
export function FavouriteButton({ meetingId, favourite, compact = false }: { meetingId: string; favourite: boolean; compact?: boolean }) {
  return (
    <ActionButton
      action={toggleMeetingFavouriteAction}
      payload={{ meetingId }}
      title={favourite ? 'Remove from favourites' : 'Add to favourites'}
      className={compact ? `btn-icon-ghost ${favourite ? 'text-amber-500' : 'text-ink-300 hover:text-amber-500'}` : `btn-secondary btn-sm ${favourite ? 'text-amber-600' : ''}`}
    >
      <IconStar size={compact ? 16 : 14} filled={favourite} />
      {compact ? null : favourite ? 'Favourite' : 'Add to favourites'}
    </ActionButton>
  );
}
