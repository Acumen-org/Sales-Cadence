'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createMeetingAction, updateMeetingAction } from '@/lib/actions/meetings';
import { parseMeetingLink } from '@/lib/meetings/providers';
import { ActionForm } from '@/components/action-form';
import { Field, Notice } from '@/components/ui';

export type MeetingFormValues = {
  id?: string;
  title: string;
  sourceUrl: string;
  occurredAt: string; // datetime-local value
  durationMin: number | '';
  companyId: string;
  attendees: string;
  notes: string;
  transcript: string;
};

/** Add or edit a meeting. Shows what Cadence can do with the pasted link as you type. */
export function MeetingForm({ companies, initial, mode }: { companies: { id: string; name: string }[]; initial: MeetingFormValues; mode: 'create' | 'edit' }) {
  const router = useRouter();
  const [url, setUrl] = useState(initial.sourceUrl);
  const parsed = url.trim() ? parseMeetingLink(url) : null;

  return (
    <ActionForm
      action={mode === 'create' ? createMeetingAction : updateMeetingAction}
      className="space-y-4"
      onSuccess={(r) => {
        if (r.redirectTo) router.push(r.redirectTo);
        else router.refresh();
      }}
    >
      {initial.id ? <input type="hidden" name="meetingId" value={initial.id} /> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Title" className="md:col-span-2">
          <input name="title" required defaultValue={initial.title} placeholder="Discovery call - Dummy Company A" />
        </Field>

        <Field
          label="Recording or meeting link"
          className="md:col-span-2"
          hint="Teams recordings live in SharePoint or OneDrive; Meet recordings live in Google Drive. Paste that link (or a direct .mp4) to play it inside Cadence."
        >
          <input name="sourceUrl" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://contoso.sharepoint.com/.../Recording.mp4?web=1" />
        </Field>

        {parsed ? (
          <div className="md:col-span-2">
            <Notice tone={parsed.embedUrl || parsed.mediaUrl ? 'success' : 'warn'}>
              <span className="font-medium">{parsed.label}.</span>{' '}
              {parsed.mediaUrl ? 'Plays inline with a native player, so transcript timestamps can seek.' : parsed.embedUrl ? 'Plays inline in an embedded player.' : 'Cannot be embedded; Cadence will link out.'}
              {parsed.note ? ` ${parsed.note}` : ''}
            </Notice>
          </div>
        ) : null}

        <Field label="When">
          <input name="occurredAt" type="datetime-local" required defaultValue={initial.occurredAt} />
        </Field>
        <Field label="Duration (minutes)">
          <input name="durationMin" type="number" min={0} max={1440} defaultValue={initial.durationMin} />
        </Field>

        <Field label="Account" className="md:col-span-2" hint="Links the meeting to the account timeline.">
          <select name="companyId" defaultValue={initial.companyId}>
            <option value="">No account</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Attendees"
          className="md:col-span-2"
          hint="One per line: “Dummy One <dummy.one@dummy-a.example>” or just the address. Addresses outside your own domains count as external, which is how a prospect meeting is recognised."
        >
          <textarea name="attendees" rows={3} defaultValue={initial.attendees} placeholder={'Dummy One <dummy.one@dummy-a.example>\nalisa@acumen-strategy.com'} />
        </Field>

        <Field label="Notes" className="md:col-span-2">
          <textarea name="notes" rows={3} defaultValue={initial.notes} />
        </Field>

        <Field label="Transcript (optional)" className="md:col-span-2" hint="Paste the WebVTT or SRT export, or plain text. Format is detected automatically.">
          <textarea name="transcript" rows={6} defaultValue={initial.transcript} className="font-mono !text-[12px]" placeholder={'WEBVTT\n\n00:00:03.000 --> 00:00:07.500\n<v Alisa>Thanks for making the time today.'} />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <button type="submit" className="btn-primary">
          {mode === 'create' ? 'Add meeting' : 'Save changes'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}
