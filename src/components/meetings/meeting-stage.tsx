'use client';

import { useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { MeetingProvider } from '@prisma/client';
import { formatCueTime, parseTranscript, type TranscriptCue } from '@/lib/meetings/transcript';
import { IconExternal, IconSearch } from '@/components/icons';

type Props = {
  title: string;
  provider: MeetingProvider;
  sourceUrl: string;
  embedUrl: string | null;
  mediaUrl: string | null;
  providerLabel: string;
  providerNote: string | null;
  isJoinLink: boolean;
  transcript: string | null;
  transcriptFormat: string | null;
};

/**
 * The recording surface: a native player for media files, an iframe for providers that allow
 * framing (SharePoint/OneDrive for Teams, Google Drive for Meet), and a link-out card otherwise.
 * The transcript sits underneath and, when we own the player, clicking a line seeks to it.
 */
export function MeetingStage(p: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [open, setOpen] = useState(true);
  const [q, setQ] = useState('');
  const [active, setActive] = useState<number | null>(null);
  // A recording link that no longer resolves left a black rectangle and a spinner that never
  // finished, with nothing to click. Losing the media falls back to the same panel an
  // un-framable provider gets, which at least offers the source.
  const [mediaFailed, setMediaFailed] = useState(false);

  const { cues, format } = useMemo(() => {
    if (!p.transcript) return { cues: [] as TranscriptCue[], format: null as string | null };
    const parsed = parseTranscript(p.transcript, (p.transcriptFormat as 'vtt' | 'srt' | 'text' | null) ?? undefined);
    return { cues: parsed.cues, format: parsed.format };
  }, [p.transcript, p.transcriptFormat]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return cues;
    return cues.filter((c) => c.text.toLowerCase().includes(needle) || (c.speaker ?? '').toLowerCase().includes(needle));
  }, [cues, q]);

  const canSeek = Boolean(p.mediaUrl) && !mediaFailed;

  const seek = (seconds: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seconds;
    void v.play().catch(() => {});
  };

  return (
    <div className="space-y-3">
      {mediaFailed ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <span className="text-[13px] font-medium text-amber-900">Recording unavailable</span>
          <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm ml-auto"><IconExternal size={13} />Open the source</a>
        </div>
      ) : (
      <div className="overflow-hidden rounded-xl border border-line bg-ink-900">
        {p.mediaUrl ? (
          <video
            ref={videoRef}
            src={p.mediaUrl}
            controls
            preload="metadata"
            onError={() => setMediaFailed(true)}
            className="aspect-video w-full bg-black"
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              const i = cues.findIndex((c) => t >= c.start && (c.end === null || t < c.end));
              if (i !== active) setActive(i >= 0 ? i : null);
            }}
          />
        ) : p.embedUrl ? (
          <iframe
            src={p.embedUrl}
            title={p.title}
            className="aspect-video w-full border-0 bg-black"
            allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-ink-900 px-6 text-center">
            <span className="text-[13px] font-medium text-white/90">{p.isJoinLink ? 'This is a join link, not a recording' : `${p.providerLabel} cannot be played inside Cadence`}</span>
            {p.providerNote ? <span className="max-w-md text-[12.5px] leading-relaxed text-white/60">{p.providerNote}</span> : null}
            <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="btn-primary btn-sm">
              <IconExternal size={14} /> Open in {p.providerLabel}
            </a>
          </div>
        )}
      </div>
      )}
      {p.embedUrl && !mediaFailed ? (
        <div className="flex items-center justify-between gap-3 px-1">
          <span className="text-[12px] text-ink-500">{p.providerLabel}</span>
          <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm" title={p.providerNote ?? undefined}><IconExternal size={13} /> Open in {p.providerLabel}</a>
        </div>
      ) : null}

      <div className="surface overflow-hidden">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
          <span className="text-[13px] font-medium text-ink-900">
            Transcript
            {cues.length ? <span className="ml-2 font-normal text-ink-600"><span className="font-medium text-ink-900">{cues.length}</span> segments{format ? ` · ${format.toUpperCase()}` : ''}</span> : null}
          </span>
          <span className="text-[12px] text-ink-500">{open ? 'Hide' : 'Show'}</span>
        </button>

        {open ? (
          cues.length === 0 ? (
            <p className="border-t border-line px-4 py-6 text-center text-[13px] text-ink-400">
              No transcript yet. Export the VTT or SRT from Teams, Zoom or Meet and paste it in Edit, or paste plain text.
            </p>
          ) : (
            <div className="border-t border-line">
              <div className="relative border-b border-line px-3 py-2">
                <IconSearch size={14} className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-ink-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the transcript" aria-label="Search the transcript" className="!pl-8 !py-1.5 !text-[12.5px]" />
              </div>
              <ol className="max-h-[420px] divide-y divide-line overflow-y-auto scroll-thin">
                {filtered.map((c, i) => {
                  const isActive = active !== null && cues[active] === c;
                  return (
                    <li key={`${c.start}-${i}`} className={clsx('flex gap-3 px-4 py-2.5 text-[13px]', isActive && 'bg-brand-50/70')}>
                      {c.end !== null || c.start > 0 ? (
                        canSeek ? (
                          <button type="button" onClick={() => seek(c.start)} className="shrink-0 font-mono text-[11.5px] text-brand-700 hover:underline" title="Jump to this moment">
                            {formatCueTime(c.start)}
                          </button>
                        ) : (
                          <span className="shrink-0 font-mono text-[11.5px] text-ink-500">{formatCueTime(c.start)}</span>
                        )
                      ) : null}
                      <span className="min-w-0">
                        {c.speaker ? <span className="mr-1.5 font-medium text-ink-900">{c.speaker}:</span> : null}
                        <span className="text-ink-700">{c.text}</span>
                      </span>
                    </li>
                  );
                })}
                {filtered.length === 0 ? <li className="px-4 py-6 text-center text-[13px] text-ink-400">Nothing matches “{q}”.</li> : null}
              </ol>
              {!canSeek && cues.some((c) => c.start > 0) ? (
                <p className="border-t border-line px-4 py-2 text-[11.5px] text-ink-600">Timestamps are for reference. Seeking needs a recording that plays here.</p>
              ) : null}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
