'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { TranscriptInput } from './transcript-input';
import { optionLabel } from '@/lib/twenty/labels';
import { PRODUCTS } from '@/lib/workspace';
import { createMeetingAction, inspectMeetingLinkAction, linkTranscriptAction, peopleFromTranscriptAction, updateMeetingAction, type LinkSuggestion, type ProspectOption, type TeamOption } from '@/lib/actions/meetings';
import { extractRecordingUrl, parseMeetingLink } from '@/lib/meetings/providers';
import { parseTranscript } from '@/lib/meetings/transcript';
import { ActionForm } from '@/components/action-form';
import { Badge } from '@/components/ui';
import { IconCheck, IconClose, IconExternal } from '@/components/icons';
import { EmbedGuide } from './embed-guide';
import { MeetingPeople, type PeopleValue } from './meeting-people';

export type MeetingFormValues = {
  id?: string;
  title: string;
  sourceUrl: string;
  /** The player the saved link plays through, when Cadence found one. */
  embedUrl?: string | null;
  mediaUrl?: string | null;
  /** The FO who booked it, credited with it. */
  bookedById: string;
  /** The meeting's day, YYYY-MM-DD. */
  occurredAt: string;
  products?: string[];
  team: TeamOption[];
  prospects: ProspectOption[];
  transcript: string;
};

type Filled = { title?: string; occurredAt?: string; transcript?: string };
type TranscriptFrom = 'teams' | 'recording' | null;

/** Where a link that cannot play here opens. */
const OPENS_IN: Record<string, string> = { TEAMS: 'Teams', ZOOM: 'Zoom', GOOGLE_MEET: 'Google Meet', SHAREPOINT: 'SharePoint', DRIVE: 'Google Drive' };

const looksLikeUrl = (v: string) => /^https?:\/\/[^\s/]+\.[^\s/]+\S*$/i.test(v.trim());

/** The recording as it will play: the player itself when Cadence can frame it. */
function Preview({ embedUrl, mediaUrl, title }: { embedUrl: string | null; mediaUrl: string | null; title: string }) {
  return (
    <div className="aspect-video w-[300px] shrink-0 overflow-hidden rounded-lg bg-ink-900">
      {mediaUrl
        ? <video src={mediaUrl} controls preload="metadata" className="h-full w-full" aria-label={`Preview of ${title || 'the recording'}`} />
        : embedUrl ? <iframe src={embedUrl} title={`Preview of ${title || 'the recording'}`} allow="autoplay; fullscreen; encrypted-media" allowFullScreen className="h-full w-full border-0" /> : null}
    </div>
  );
}

/**
 * Add or edit a meeting (owner, 29 October 2026: "super easy to do, and it does not look like a lot
 * of work"). Paste the recording and it is read at once: whether it plays here (shown by playing it),
 * the title and the day from the file or the page, and a Teams recording's transcript from
 * Microsoft, whose speakers fill in who was there where they are known. Then three things only a
 * person knows: who booked it, who was on the call from our side, and which prospects, each with
 * which meeting with us this is. Products last. Everything filled in stays editable.
 */
export function MeetingForm({ fos, initial, mode }: { fos: { id: string; name: string }[]; initial: MeetingFormValues; mode: 'create' | 'edit' }) {
  const router = useRouter();
  const [url, setUrl] = useState(initial.sourceUrl);
  const [title, setTitle] = useState(initial.title);
  const [occurredAt, setOccurredAt] = useState(initial.occurredAt);
  const [people, setPeople] = useState<PeopleValue>({ bookedById: initial.bookedById, team: initial.team, prospects: initial.prospects });
  const [products, setProducts] = useState<string[]>(initial.products ?? []);
  const [transcript, setTranscript] = useState(initial.transcript);
  const [transcriptFrom, setTranscriptFrom] = useState<TranscriptFrom>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<LinkSuggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [filledNote, setFilledNote] = useState<string[]>([]);
  const [fetchingTranscript, setFetchingTranscript] = useState(false);
  // What the last link put in the form, so a later link can take back exactly that and nothing typed.
  const filled = useRef<Filled>({});
  const lastRead = useRef(initial.sourceUrl.trim());
  const latest = useRef(0);
  const [reading, start] = useTransition();
  // Kept current for the async steps below, which outlive the render that started them.
  const state = useRef({ title, occurredAt, transcript, people });
  state.current = { title, occurredAt, transcript, people };

  const parsed = url.trim() ? parseMeetingLink(url) : null;
  const invalid = Boolean(parsed?.note?.includes('does not look like a URL'));
  const saved = Boolean(initial.sourceUrl && url.trim() === initial.sourceUrl);
  const embedUrl = suggestion?.embedUrl ?? parsed?.embedUrl ?? (saved ? initial.embedUrl ?? null : null);
  const mediaUrl = suggestion?.mediaUrl ?? parsed?.mediaUrl ?? (saved ? initial.mediaUrl ?? null : null);
  const plays = Boolean(embedUrl || mediaUrl);
  const sharePointWithoutPlayer = Boolean(parsed && parsed.provider === 'SHAREPOINT' && !plays && !reading);

  /** Fill the form from what speakers a transcript names: added to the lists, never removing anyone. */
  const addSpeakers = async (text: string) => {
    const found = await peopleFromTranscriptAction(text).catch(() => null);
    if (!found?.ok || (!found.team.length && !found.prospects.length)) return [];
    const { team, prospects } = state.current.people;
    const newTeam = found.team.filter((t) => !team.some((x) => x.userId === t.userId));
    const newProspects = found.prospects.filter((p) => !prospects.some((x) => x.personId === p.personId));
    if (newTeam.length || newProspects.length) setPeople({ ...state.current.people, team: [...team, ...newTeam], prospects: [...prospects, ...newProspects] });
    return [...newTeam, ...newProspects].map((x) => x.name);
  };

  const read = (link: string) => {
    const target = link.trim();
    if (!target || !looksLikeUrl(target)) return;
    lastRead.current = target;
    const ticket = ++latest.current;
    setError(null);
    setExisting(null);
    start(async () => {
      const r = await inspectMeetingLinkAction(target, initial.id ?? null).catch(() => null);
      if (ticket !== latest.current) return;
      if (!r) { setError('The link could not be read. Check it and paste it again.'); return; }
      if (!r.ok) { setError(r.error); return; }
      const now = state.current;
      // What the previous link filled and nobody changed since goes back first.
      const was = filled.current;
      if (was.title !== undefined && now.title === was.title) setTitle(initial.title);
      if (was.occurredAt !== undefined && now.occurredAt === was.occurredAt) setOccurredAt(initial.occurredAt);
      if (was.transcript !== undefined && now.transcript === was.transcript) { setTranscript(initial.transcript); setTranscriptFrom(null); }
      filled.current = {};
      if (r.data.existingMeetingId) { setExisting(r.data.existingMeetingId); setSuggestion(null); setFilledNote([]); return; }
      setSuggestion(r.data);
      const put: Filled = {};
      const note: string[] = [];
      const titleNow = was.title !== undefined && now.title === was.title ? initial.title : now.title;
      if (r.data.title && !titleNow.trim()) { setTitle(put.title = r.data.title); note.push('title'); }
      if (r.data.date) { setOccurredAt(put.occurredAt = r.data.date); note.push('date'); }
      const transcriptNow = was.transcript !== undefined && now.transcript === was.transcript ? initial.transcript : now.transcript;
      if (r.data.transcript && !transcriptNow.trim()) { setTranscript(put.transcript = r.data.transcript); setTranscriptFrom('recording'); note.push('transcript'); }
      filled.current = put;
      setFilledNote(note);
      if (put.transcript) { const names = await addSpeakers(put.transcript); if (names.length && ticket === latest.current) setFilledNote((n) => [...n, ...names]); }
      if (r.data.transcriptFromTeams && !transcriptNow.trim()) {
        setFetchingTranscript(true);
        const t = await linkTranscriptAction(target, state.current.people.team.map((x) => x.userId)).catch(() => null);
        if (ticket !== latest.current) return;
        setFetchingTranscript(false);
        if (t?.ok && t.transcript && !state.current.transcript.trim()) {
          setTranscript(t.transcript);
          setTranscriptFrom('teams');
          filled.current = { ...filled.current, transcript: t.transcript };
          setFilledNote((n) => [...n, 'transcript']);
          const names = await addSpeakers(t.transcript);
          if (names.length && ticket === latest.current) setFilledNote((n) => [...n, ...names]);
        }
      }
    });
  };

  // Typing or editing the link reads it once it settles; pasting reads it straight away.
  useEffect(() => {
    const target = url.trim();
    if (!target || target === lastRead.current || !looksLikeUrl(target)) return;
    const timer = window.setTimeout(() => read(target), 700);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const pasted = (text: string) => {
    const next = extractRecordingUrl(text);
    setUrl(next);
    if (looksLikeUrl(next)) read(next);
  };
  const clearLink = () => { setUrl(''); setSuggestion(null); setError(null); setExisting(null); setFilledNote([]); lastRead.current = ''; latest.current++; };

  const lines = transcript.trim() ? parseTranscript(transcript).cues.length : 0;
  const missing = [
    !title.trim() && 'title',
    !occurredAt && 'date',
    !people.bookedById && 'booked by',
    !people.team.length && 'our team on the call',
    !people.prospects.length && 'prospects',
    !products.length && 'products',
  ].filter(Boolean) as string[];

  return (
    <ActionForm
      action={mode === 'create' ? createMeetingAction : updateMeetingAction}
      className="divide-y divide-line"
      onSuccess={(r) => {
        if (r.redirectTo) router.push(r.redirectTo);
        else router.refresh();
      }}
    >
      {initial.id ? <input type="hidden" name="meetingId" value={initial.id} /> : null}

      <section className="space-y-3 pb-6">
        <h2 id="recording-heading" className="text-[14px] font-medium text-ink-900">Recording</h2>
        <div className="relative">
          <input
            id="meeting-link"
            name="sourceUrl"
            aria-label="Recording or meeting link"
            value={url}
            onChange={(e) => setUrl(extractRecordingUrl(e.target.value))}
            onPaste={(e) => { e.preventDefault(); pasted(e.clipboardData.getData('text')); }}
            onBlur={() => { if (url.trim() !== lastRead.current) read(url); }}
            placeholder="Paste the recording link or its embed code"
            className="!h-11 !pr-10 !text-[14px]"
            autoFocus={mode === 'create' && !initial.sourceUrl}
          />
          {url ? <button type="button" aria-label="Clear the link" onClick={clearLink} className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-ink-400 hover:bg-canvas hover:text-ink-700"><IconClose size={14} /></button> : null}
        </div>

        {error ? <p role="alert" className="text-[13px] text-red-700">{error}</p> : null}
        {invalid ? <p role="alert" className="text-[13px] text-red-700">{parsed?.note}</p> : null}

        {existing ? (
          <div role="status" className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
            <span className="flex-1">This meeting is already in Cadence.</span>
            <Link href={`/meetings/${existing}`} className="btn-secondary btn-sm">Open it</Link>
          </div>
        ) : parsed && !invalid ? (
          <div className={clsx('flex items-center gap-5 rounded-xl border p-3', plays ? 'border-emerald-200 bg-emerald-50/40' : 'border-line bg-canvas/50')} aria-live="polite" aria-busy={reading}>
            {reading && !plays ? (
              <div className="aspect-video w-[300px] shrink-0 animate-pulse rounded-lg bg-ink-100" />
            ) : plays ? (
              <Preview embedUrl={embedUrl} mediaUrl={mediaUrl} title={title} />
            ) : (
              <div className="grid aspect-video w-[300px] shrink-0 place-items-center rounded-lg border border-dashed border-ink-200 bg-white text-ink-400"><IconExternal size={22} /></div>
            )}
            <div className="min-w-0 flex-1 space-y-2">
              {reading && !plays ? (
                <div className="text-[15px] text-ink-600">Reading the link…</div>
              ) : plays ? (
                <div className="flex items-center gap-2 text-[15px] font-medium text-emerald-800"><span className="grid h-6 w-6 place-items-center rounded-full bg-emerald-600 text-white"><IconCheck size={13} /></span>Plays in Cadence</div>
              ) : (
                <div className="flex items-center gap-2 text-[15px] font-medium text-ink-800">{parsed.isJoinLink ? 'Meeting link, no recording' : `Opens in ${OPENS_IN[parsed.provider] ?? 'a new tab'}`}{sharePointWithoutPlayer ? <EmbedGuide /> : null}</div>
              )}
              <div className="text-[13px] text-ink-500">{parsed.label}</div>
              {sharePointWithoutPlayer ? <div className="text-[13px] text-ink-600">Paste its embed code to play it here</div> : null}
              {filledNote.length ? <div className="text-[13px] text-ink-600">Filled in: {filledNote.join(', ')}</div> : null}
              {fetchingTranscript ? <div className="text-[13px] text-ink-600">Finding the transcript in Teams…</div> : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className="grid gap-4 py-6 md:grid-cols-[1fr_200px]">
        <div className="space-y-1.5">
          <div className="flex items-center"><label htmlFor="meeting-title">Title</label><span className="ml-0.5 text-[12px] leading-4 text-red-600" aria-hidden>*</span></div>
          <input id="meeting-title" name="title" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Meeting title" />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center"><label htmlFor="meeting-date">Date</label><span className="ml-0.5 text-[12px] leading-4 text-red-600" aria-hidden>*</span></div>
          <input id="meeting-date" name="occurredAt" type="date" required value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </div>
      </section>

      <section className="space-y-4 py-6">
        <h2 id="people-heading" className="text-[14px] font-medium text-ink-900">Who was there</h2>
        <MeetingPeople fos={fos} value={people} onChange={setPeople} day={occurredAt} meetingId={initial.id ?? null} />
      </section>

      <section className="space-y-3 py-6">
        <div className="flex items-center"><h2 id="products-heading" className="text-[14px] font-medium text-ink-900">Products</h2><span className="ml-0.5 text-[12px] leading-4 text-red-600" aria-hidden>*</span></div>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="products-heading">
          {PRODUCTS.map((product) => {
            const on = products.includes(product);
            return (
              <label key={product} className={clsx('flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] transition', on ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-line bg-white text-ink-700 hover:border-ink-300')}>
                <input type="checkbox" name="products" value={product} checked={on} onChange={() => setProducts((list) => (on ? list.filter((p) => p !== product) : PRODUCTS.filter((p) => p === product || list.includes(p))))} className="sr-only" />
                <span className={clsx('grid h-4 w-4 place-items-center rounded-full border', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-300')}>{on ? <IconCheck size={10} /> : null}</span>
                {optionLabel(product)}
              </label>
            );
          })}
        </div>
      </section>

      <section className="space-y-3 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="transcript-heading" className="text-[14px] font-medium text-ink-900">Transcript</h2>
          {lines ? <Badge tone="blue">{transcriptFrom === 'teams' ? 'From Teams' : transcriptFrom === 'recording' ? 'From the recording' : 'Added'}</Badge> : null}
          {lines ? <span className="text-[13px] text-ink-500">{lines} {lines === 1 ? 'line' : 'lines'}</span> : null}
          {fetchingTranscript ? <span className="text-[13px] text-ink-500">Finding it in Teams…</span> : null}
          <span className="ml-auto flex gap-2">
            {lines && !transcriptOpen ? <button type="button" className="btn-ghost btn-sm" onClick={() => setTranscriptOpen(true)}>Show</button> : null}
            {!lines && !transcriptOpen ? <button type="button" className="btn-secondary btn-sm" onClick={() => setTranscriptOpen(true)}>Add a transcript</button> : null}
            {lines ? <button type="button" className="btn-ghost btn-sm" onClick={() => void addSpeakers(transcript).then((names) => { if (names.length) setFilledNote((n) => [...n, ...names]); })}>Add the speakers</button> : null}
          </span>
        </div>
        {transcriptOpen
          ? <TranscriptInput name="transcript" label="Transcript" value={transcript} onChange={(v) => { setTranscript(v); setTranscriptFrom(null); }} rows={8} />
          : <input type="hidden" name="transcript" value={transcript} />}
      </section>

      <div className="flex flex-wrap items-center gap-3 pt-6">
        <button type="submit" className="btn-primary" disabled={(mode === 'create' && Boolean(existing)) || missing.length > 0 || invalid}>
          {mode === 'create' ? 'Add meeting' : 'Save changes'}
        </button>
        <Link href={initial.id ? `/meetings/${initial.id}` : '/meetings'} className="btn-secondary">
          Cancel
        </Link>
        {missing.length ? <span className="text-[13px] text-ink-500">Still needed: {missing.join(', ')}</span> : null}
      </div>
    </ActionForm>
  );
}
