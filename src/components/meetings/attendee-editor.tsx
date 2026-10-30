'use client';

import { useState } from 'react';
import { updateMeetingAttendeesAction, type ProspectOption, type TeamOption } from '@/lib/actions/meetings';
import { ActionForm } from '@/components/action-form';
import { MeetingPeople, type PeopleValue } from './meeting-people';

/** Change who was there from the meeting's own page: the team on the call and the prospects. */
export function AttendeeEditor({ meetingId, day, team, prospects }: { meetingId: string; day: string; team: TeamOption[]; prospects: ProspectOption[] }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<PeopleValue>({ bookedById: '', team, prospects });
  if (!open) return <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen(true)}>Edit who was there</button>;
  return <ActionForm action={updateMeetingAttendeesAction} onSuccess={() => setOpen(false)} className="space-y-4">
    <input name="meetingId" type="hidden" value={meetingId} />
    <MeetingPeople fos={[]} value={value} onChange={setValue} day={day} meetingId={meetingId} showBookedBy={false} />
    <div className="flex gap-2">
      <button type="submit" className="btn-primary btn-sm" disabled={!value.team.length || !value.prospects.length}>Save</button>
      <button type="button" className="btn-secondary btn-sm" onClick={() => { setValue({ bookedById: '', team, prospects }); setOpen(false); }}>Cancel</button>
    </div>
  </ActionForm>;
}
