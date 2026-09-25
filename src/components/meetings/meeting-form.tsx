'use client';

import Link from 'next/link';
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
  const [existing, setExisting] = useState<string | null>(null);
  // Changing it starts the attendee list again from the form's own people.
  const [attendeesKey, setAttendeesKey] = useState(0);
  // What the last link put in the form, so a later answer can take back exactly that and nothing typed.
  const [fromLink, setFromLink] = useState<{ title?: string; occurredAt?: string; durationMin?: number; companyId?: string; bookedById?: string; attendees?: boolean }>({});
  const [pending, start] = useTransition();
  const parsed = url.trim() ? parseMeetingLink(url) : null;

  const fillFromLink = () =>
    start(async () => {
      setNote(null);
      setExisting(null);
      setAdditions(null);
      const r = await inspectMeetingLinkAction(url);
      if (!r.ok) { setNote(r.error); return; }
      if (r.data.existingMeetingId) {
        setExisting(r.data.existingMeetingId);
        setNote('This meeting is already in Cadence.');
        // What another link filled does not stay under the answer; what the user typed does.
        if (fromLink.title !== undefined && title === fromLink.title) setTitle(initial.title);
        if (fromLink.occurredAt !== undefined && occurredAt === fromLink.occurredAt) setOccurredAt(initial.occurredAt);
        if (fromLink.durationMin !== undefined && durationMin === fromLink.durationMin) setDurationMin(initial.durationMin);
        if (fromLink.companyId !== undefined && companyId === fromLink.companyId) setCompanyId(initial.companyId);
        if (fromLink.bookedById !== undefined && bookedById === fromLink.bookedById) setBookedById(initial.bookedById);
        if (fromLink.attendees) { setAdditions(null); setAttendeesKey((k) => k + 1); }
        setFromLink({});
        setSuggestion(null);
        return;
      }
      setSuggestion(r.data);
      const filled: string[] = [];
      const put: typeof fromLink = {};
      if (r.data.title && !title.trim()) { setTitle(put.title = r.data.title); filled.push('title'); }
      if (r.data.date) { setOccurredAt(put.occurredAt = `${r.data.date}T${(r.data.time ?? occurredAt.split('T')[1] ?? '09:00').slice(0, 5)}`); filled.push(r.data.time ? 'date and time' : 'date'); }
      if (r.data.durationMin && durationMin === '') { setDurationMin(put.durationMin = r.data.durationMin); filled.push('duration'); }
      if (r.data.bookedById) { setBookedById(put.bookedById = r.data.bookedById); filled.push('booked by'); }
      const guests = r.data.attendees ?? [];
      if (guests.length) { setAdditions(guests); put.attendees = true; filled.push('attendees'); }
      if (r.data.companyId && !companyId) { setCompanyId(put.companyId = r.data.companyId); filled.push('account'); }
      if (r.data.transcript && !transcript.trim()) {
        setTranscript(r.data.transcript); filled.push('transcript');
        const people = await attendeesFromTranscriptAction(r.data.transcript);
        if (people.ok) {
          if (people.attendees.length) {
            const key = (a: AttendeeSelection) => a.userId ?? a.personId ?? a.email?.toLowerCase() ?? a.name ?? '';
            setAdditions([...guests, ...people.attendees.filter((a) => !guests.some((g) => key(g) === key(a)))]);
            put.attendees = true;
            if (!filled.includes('attendees')) filled.push('attendees');
          }
          if (people.durationSec && durationMin === '') setDurationMin(Math.max(1, Math.round(people.durationSec / 60)));
        }
      }
      setFromLink(put);
      setNote(filled.length ? `${r.data.fromCalendar ? 'From the calendar' : 'From the link'}: ${filled.join(', ')}.` : r.data.isJoinLink ? 'No calendar event has this link.' : 'The link gave nothing to fill.');
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

        {note ? <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-canvas/60 px-3 py-2 text-[13px] text-ink-700 md:col-span-2">{note}{existing ? <Link href={`/meetings/${existing}`} className="btn-secondary btn-sm">Open it</Link> : null}</div> : null}

        {parsed ? <div className="flex flex-wrap items-center gap-2 md:col-span-2">
          <Badge tone="blue">{parsed.label}</Badge>
          <Badge tone={suggestion?.mediaUrl || parsed.mediaUrl ? 'green' : parsed.embedUrl ? 'blue' : 'gray'}>{suggestion?.mediaUrl || parsed.mediaUrl ? 'Plays here, transcript follows' : parsed.embedUrl ? 'Plays here' : 'Opens in a new tab'}</Badge>
          {parsed.note?.includes('does not look like a URL') ? <span className="text-[12.5px] text-red-700">{parsed.note}</span> : null}
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

        <div className="space-y-2 md:col-span-2"><div className="text-[12px] font-medium text-ink-500">Attendees</div><AttendeePicker key={attendeesKey} initial={initial.attendees} additions={additions} /></div>

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
        <Field label="Transcript" className="md:col-span-2" hint={<span className="flex flex-wrap items-center gap-2"><button type="button" className="btn-ghost btn-sm" disabled={pending || !transcript.trim()} onClick={attendeesFromTranscript}>Attendees from the speakers</button></span>}>
          <TranscriptInput name="transcript" label="Transcript" defaultValue={initial.transcript} value={transcript} onChange={setTranscript} />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <button type="submit" className="btn-primary" disabled={mode === 'create' && Boolean(existing)}>
          {mode === 'create' ? 'Add meeting' : 'Save changes'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => router.back()}>
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}
