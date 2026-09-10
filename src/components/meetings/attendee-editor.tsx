'use client';

import { useState } from 'react';
import { updateMeetingAttendeesAction, type AttendeeSelection } from '@/lib/actions/meetings';
import { ActionForm } from '@/components/action-form';
import { AttendeePicker } from './attendee-picker';

export function AttendeeEditor({ meetingId, attendees }: { meetingId: string; attendees: AttendeeSelection[] }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen(true)}>Edit attendees</button>;
  return <ActionForm action={updateMeetingAttendeesAction} onSuccess={() => setOpen(false)} className="space-y-3">
    <input name="meetingId" type="hidden" value={meetingId} />
    <AttendeePicker initial={attendees} />
    <div className="flex gap-2"><button type="submit" className="btn-primary btn-sm">Save attendees</button><button type="button" className="btn-secondary btn-sm" onClick={() => setOpen(false)}>Cancel</button></div>
  </ActionForm>;
}
