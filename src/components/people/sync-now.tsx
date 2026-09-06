'use client';

import { refreshCacheAction } from '@/lib/actions/admin';
import { ActionButton } from '@/components/action-form';

/** Pull people and pods changed in Twenty in the last 36 hours, right now. */
export function SyncNow() {
  return (
    <ActionButton action={refreshCacheAction} payload={{ full: 'false' }} className="btn-secondary" title="Refresh people and pods from Twenty now (webhooks do this automatically as changes happen)">
      Sync from Twenty
    </ActionButton>
  );
}
