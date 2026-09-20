'use client';

import { useRouter } from 'next/navigation';
import { TranscriptInput } from './transcript-input';
import { optionLabel } from '@/lib/twenty/labels';
import { PRODUCTS, timezoneLabel } from '@/lib/workspace';
import { useState, useTransition } from 'react';
import { attendeesFromTranscriptAction, createMeetingAction, inspectMeetingLinkAction, updateMeetingAction, type AttendeeSelection, type LinkSuggestion } from '@/lib/actions/meetings';
import { extractRecordingUrl, parseMeetingLink } from '@/lib/meetings/providers';
import { ActionForm } from '@/components/action-form';
import { Field, Badge } from '@/components/ui';
import { AttendeePicker } from './attendee-picker';

export type MeetingFormValues = {
  id?: string;
  title: string;
  sourceUrl: string;
  /** The FO who booked it. */
  bookedById: string;
  occurredAt: string; // datetime-local value
  durationMin: number | '';
  companyId: string;
  products?: string[];
  attendees: AttendeeSelection[];
  transcript: string;
};

/**
 * Add or edit a meeting. Paste the link first: Cadence reads what the page says about itself and
 * fills the title, the date and the account it names, and says whether the recording will play
 * here. Paste a transcript and the speakers become attendees. Everything filled in stays editable.
 */
export function MeetingForm({ companies, fos, initial, mode, timezone }: { companies: { id: string; name: string }[]; fos: { id: string; name: string }[]; initial: MeetingFormValues; mode: 'create' | 'edit'; timezone: string }) {
  const router = useRouter();
  const [url, setUrl] = useState(initial.sourceUrl);
  const [title, setTitle] = useState(initial.title);
  const [occurredAt, setOccurredAt] = useState(initial.occurredAt);
  const [durationMin, setDurationMin] = useState<number | ''>(initial.durationMin);
  const [companyId, setCompanyId] = useState(initial.companyId);
  const [bookedById, setBookedById] = useState(initial.bookedById);
  const [suggestion, setSuggestion] = useState<LinkSuggestion | null>(null);
  const [additions, setAdditions] = useState<AttendeeSelection[] | null>(null);
  const [transcript, setTranscript] = useState(initial.transcript);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const parsed = url.trim() ? parseMeetingLink(url) : null;

  const fillFromLink = () =>
    start(async () => {
      setNote(null);
      const r = await inspectMeetingLinkAction(url);
      if (!r.ok) { setNote(r.error); return; }
      setSuggestion(r.data);
      const filled: string[] = [];
      if (r.data.title && !title.trim()) { setTitle(r.data.title); filled.push('title'); }
      if (r.data.date) { setOccurredAt((current) => `${r.data.date}T${(current.split('T')[1] ?? '09:00').slice(0, 5)}`); filled.push('date'); }
      if (r.data.companyId && !companyId) { setCompanyId(r.data.companyId); filled.push('account'); }
      if (r.data.transcript && !transcript.trim()) {
        setTranscript(r.data.transcript); filled.push('transcript');
        const people = await attendeesFromTranscriptAction(r.data.transcript);
        if (people.ok) {
          if (people.attendees.length) { setAdditions(people.attendees); filled.push('attendees'); }
          if (people.durationSec && durationMin === '') setDurationMin(Math.max(1, Math.round(people.durationSec / 60)));
        }
      }
      setNote(filled.length ? `Filled ${filled.join(', ')} from the link.` : 'The link gave nothing to fill.');
    });

  const attendeesFromTranscript = () =>
    start(async () => {
      setNote(null);
      const r = await attendeesFromTranscriptAction(transcript);
      if (!r.ok) { setNote(r.error); return; }
      setAdditions(r.attendees);
      if (r.durationSec && durationMin === '') setDurationMin(Math.max(1, Math.round(r.durationSec / 60)));
      setNote(r.attendees.length ? `${r.attendees.length} ${r.attendees.length === 1 ? 'speaker' : 'speakers'} added as attendees.` : 'No speakers found in the transcript.');
    });

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
        <Field label="Recording or meeting link" className="md:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            <input name="sourceUrl" aria-label="Recording or meeting link" value={url} onChange={(e) => setUrl(extractRecordingUrl(e.target.value))} placeholder="https://" className="!w-auto min-w-0 flex-1" />
            <button type="button" className="btn-secondary" disabled={pending || !parsed || Boolean(parsed.note?.includes('does not look like a URL'))} onClick={fillFromLink}>{pending ? 'Reading…' : 'Fill from link'}</button>
          </div>
        </Field>

        {parsed ? <div className="flex flex-wrap items-center gap-2 md:col-span-2">
          <Badge tone="blue">{parsed.label}</Badge>
          <Badge tone={suggestion?.mediaUrl || parsed.mediaUrl ? 'green' : parsed.embedUrl ? 'blue' : 'gray'}>{suggestion?.mediaUrl || parsed.mediaUrl ? 'Plays here, transcript follows' : parsed.embedUrl ? 'Plays here' : 'Opens in a new tab'}</Badge>
          {parsed.note ? <span className="text-[12.5px] text-ink-500">{parsed.note}</span> : null}
        </div> : null}

        <Field label="Title" required className="md:col-span-2">
          <input name="title" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Meeting title" />
        </Field>

        <Field label="Date and time" required hint={timezoneLabel(timezone)}>
          <input name="occurredAt" type="datetime-local" required value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </Field>
        <Field label="Duration (minutes)">
          <input name="durationMin" type="number" min={0} max={1440} value={durationMin} onChange={(e) => setDurationMin(e.target.value === '' ? '' : Number(e.target.value))} />
        </Field>

        <Field label="Booked by" required>
          <select name="bookedById" required value={bookedById} onChange={(e) => setBookedById(e.target.value)}>
            <option value="">Choose the FO</option>
            {fos.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>
        <Field label="Account">
          <select name="companyId" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">No account</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <div className="space-y-2 md:col-span-2"><div className="text-[12px] font-medium text-ink-500">Attendees</div><AttendeePicker initial={initial.attendees} additions={additions} /></div>

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
        <Field label="Transcript" className="md:col-span-2" hint={<span className="flex flex-wrap items-center gap-2">WebVTT, SRT, a JSON export or plain text<button type="button" className="btn-ghost btn-sm" disabled={pending || !transcript.trim()} onClick={attendeesFromTranscript}>Attendees from the speakers</button></span>}>
          <TranscriptInput name="transcript" label="Transcript" defaultValue={initial.transcript} value={transcript} onChange={setTranscript} />
        </Field>
      </div>

      {note ? <p role="status" className="text-[12.5px] text-ink-600">{note}</p> : null}

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
