'use client';

import { useEffect } from 'react';
import { saveEmailTimezoneAction } from '@/lib/actions/bell-email';

/**
 * Reads the time zone of this computer and saves it when it differs from the one on file (owner, 24
 * Nov 2026): it only decides when this person's Cadence emails arrive. No prompt, nothing shown.
 */
export function EmailTimezone({ saved }: { saved: string | null }) {
  useEffect(() => {
    let tz: string | undefined;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return; }
    if (tz && tz !== saved) saveEmailTimezoneAction(tz).catch(() => {});
  }, [saved]);
  return null;
}
