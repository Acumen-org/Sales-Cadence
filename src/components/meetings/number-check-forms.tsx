'use client';

import { useState } from 'react';
import { closeNumberCheckAction, reopenNumberCheckAction, setMeetingNumberAction } from '@/lib/actions/number-checks';
import { ActionButton, ActionForm } from '@/components/action-form';

/** Set which meeting with this prospect a meeting is; later ones count on from it. */
export function SetNumberForm({ attendeeId, current, setTo, label }: { attendeeId: string; current: number | null; setTo: number | null; label: string }) {
  const [value, setValue] = useState(String(setTo ?? current ?? ''));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ActionForm action={setMeetingNumberAction} className="flex items-center gap-2">
        <input type="hidden" name="attendeeId" value={attendeeId} />
        <input name="number" type="number" min={1} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Number for ${label}`} className="!h-8 !w-20 !text-[13px]" />
        <button type="submit" className="btn-secondary btn-sm" disabled={!value.trim() || Number(value) === (setTo ?? current)}>Set</button>
      </ActionForm>
      {setTo !== null ? <ActionButton action={setMeetingNumberAction} payload={{ attendeeId, number: '' }} className="btn-ghost btn-sm" refresh>Count it again</ActionButton> : null}
    </div>
  );
}

/** What Biz Ops found, and the check closed. */
export function CloseCheckForm({ ticketId }: { ticketId: string }) {
  return (
    <ActionForm action={closeNumberCheckAction} className="space-y-3 p-4" onSuccess={(r) => { if (r.redirectTo) window.location.assign(r.redirectTo); }}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <div className="space-y-1.5">
        <label htmlFor="check-resolution">What you found</label>
        <textarea id="check-resolution" name="resolution" rows={3} maxLength={1000} />
      </div>
      <button type="submit" className="btn-primary">Close check</button>
    </ActionForm>
  );
}

export function ReopenCheckButton({ ticketId }: { ticketId: string }) {
  return <ActionButton action={reopenNumberCheckAction} payload={{ ticketId }} className="btn-secondary btn-sm" refresh>Open again</ActionButton>;
}
