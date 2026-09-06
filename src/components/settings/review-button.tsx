'use client';

import { resolveReviewAction } from '@/lib/actions/admin';
import { ActionButton } from '@/components/action-form';

export function ReviewButton({ eventId }: { eventId: string }) {
  return (
    <ActionButton action={resolveReviewAction} payload={{ eventId, note: 'reviewed' }} className="btn-ghost btn-sm">
      Mark reviewed
    </ActionButton>
  );
}
