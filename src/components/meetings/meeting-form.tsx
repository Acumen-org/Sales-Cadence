'use client';

import { useRouter } from 'next/navigation';
import { TranscriptInput } from './transcript-input';
import { optionLabel } from '@/lib/twenty/labels';
import { PRODUCTS, WORKSPACE_TIMEZONE, WORKSPACE_TIMEZONE_LABEL } from '@/lib/workspace';
import { useState } from 'react';
import { createMeetingAction, updateMeetingAction, type AttendeeSelection } from '@/lib/actions/meetings';
import { parseMeetingLink } from '@/lib/meetings/providers';
import { ActionForm } from '@/components/action-form';
import { Field, Badge } from '@/components/ui';
import { AttendeePicker } from './attendee-picker';

export type MeetingFormValues = {
  id?: string;
  title: string;
  sourceUrl: string;
  occurredAt: string; // datetime-local value
  durationMin: number | '';
  companyId: string;
  products?: string[];
  attendees: AttendeeSelection[];
  transcript: string;
};

/** Add or edit a meeting. Shows what Cadence can do with the pasted link as you type. */
export function MeetingForm({ companies, initial, mode, timezone }: { companies: { id: string; name: string }[]; initial: MeetingFormValues; mode: 'create' | 'edit'; timezone: string }) {
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
          <input name="title" required defaultValue={initial.title} placeholder="Meeting title" />
        </Field>

        <Field
          label="Recording or meeting link"
          className="md:col-span-2"
        >
          <input name="sourceUrl" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
        </Field>

        {parsed ? <div className="space-y-2 md:col-span-2">
          <div className="flex flex-wrap gap-2"><Badge tone="blue">{parsed.label}</Badge><Badge tone={parsed.mediaUrl || parsed.embedUrl ? 'green' : 'gray'}>{parsed.mediaUrl || parsed.embedUrl ? 'Inline playback' : 'Opens externally'}</Badge></div>
          {parsed.note ? <p className="text-sm text-ink-600">{parsed.note}</p> : null}
        </div> : null}

        <Field label="Date and time" info={timezone === WORKSPACE_TIMEZONE ? WORKSPACE_TIMEZONE_LABEL : timezone}>
          <input name="occurredAt" type="datetime-local" required defaultValue={initial.occurredAt} />
        </Field>
        <Field label="Duration (minutes)">
          <input name="durationMin" type="number" min={0} max={1440} defaultValue={initial.durationMin} />
        </Field>

        <Field label="Account" className="md:col-span-2">
          <select name="companyId" defaultValue={initial.companyId}>
            <option value="">No account</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="space-y-2 md:col-span-2"><div className="text-[12px] font-medium text-ink-500">Attendees</div><AttendeePicker initial={initial.attendees} /></div>

        <Field label="Products" className="md:col-span-2">
          <div className="flex flex-wrap gap-2">
            {PRODUCTS.map((product) => (
              <label key={product} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] font-medium text-ink-800">
                <input type="checkbox" name="products" value={product} defaultChecked={initial.products?.includes(product)} />
                {optionLabel(product)}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Transcript (optional)" className="md:col-span-2" info="WebVTT, SRT, Teams grouped text, a JSON export or plain text; the format is detected. Only the dialogue is kept.">
          <TranscriptInput name="transcript" label="Transcript (optional)" defaultValue={initial.transcript} />
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
