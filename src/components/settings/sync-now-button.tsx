'use client';

import { syncNowAction } from '@/lib/actions/admin';
import { ActionButton } from '@/components/action-form';
import { IconRefresh } from '@/components/icons';

/** Run the continuous sync this instant. The worker runs it every minute regardless. */
export function SyncNowButton({ className = 'btn-ghost btn-sm' }: { className?: string }) {
  return (
    <ActionButton action={() => syncNowAction()} payload={{}} className={className}>
      <IconRefresh size={14} /> Sync now
    </ActionButton>
  );
}
