'use client';

import { discardTwentyWriteAction, retryTwentyWriteAction } from '@/lib/actions/admin';
import { ActionButton } from '@/components/action-form';

/** Replay one failed write now, or (with no id) everything waiting in the outbox. */
export function RetryWriteButton({ writeId, children = 'Retry now' }: { writeId?: string; children?: React.ReactNode }) {
  return (
    <ActionButton action={retryTwentyWriteAction} payload={{ writeId: writeId ?? '' }} className="btn-secondary btn-sm">
      {children}
    </ActionButton>
  );
}

export function DiscardWriteButton({ writeId }: { writeId: string }) {
  return (
    <ActionButton action={discardTwentyWriteAction} payload={{ writeId }} className="btn-ghost btn-sm text-red-700">
      Discard
    </ActionButton>
  );
}
