'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

const STEPS = ['Open the recording in SharePoint or Stream', 'Choose Share', 'Embed code, then Copy', 'Paste it here'];

/**
 * How to get a recording's embed code, played as a short loop: the recording opens, Share,
 * Embed code, Copy, and the code pasted into the link field plays here. Teams recordings live in
 * SharePoint, and its sharing links refuse to play inside another site; its embed code does not.
 */
export function EmbedGuide({ open: initiallyOpen = false }: { open?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(initiallyOpen), [initiallyOpen]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <span ref={box} className="relative inline-flex">
      <button type="button" aria-label="How to get the embed link" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={clsx('grid h-5 w-5 place-items-center rounded-full border text-[11px] font-semibold leading-none transition', open ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-300 text-ink-500 hover:border-brand-600 hover:text-brand-700')}>i</button>
      {open ? (
        <div role="dialog" aria-label="How to get the embed link" className="absolute left-0 top-7 z-30 w-[400px] rounded-xl border border-line bg-white p-4 shadow-lg">
          <div className="mb-3 text-[13px] font-medium text-ink-900">Getting the embed link</div>
          <div className="eg-stage" aria-hidden>
            <div className="eg-window">
              <div className="eg-bar"><span /><span /><span /><em>Recording.mp4 - SharePoint</em></div>
              <div className="eg-video"><div className="eg-play" /></div>
              <div className="eg-tools"><span className="eg-share">Share</span><span className="eg-more">···</span></div>
              <div className="eg-menu"><span>Copy link</span><span className="eg-embed">Embed code</span></div>
              <div className="eg-dialog"><b>Embed code</b><code>&lt;iframe src=&quot;https://…/embed.aspx?UniqueId=…&quot;&gt;</code><span className="eg-copy">Copy</span></div>
            </div>
            <div className="eg-cadence"><span className="eg-label">Recording or meeting link</span><span className="eg-field">&lt;iframe src=&quot;https://…/embed.aspx…</span><span className="eg-badge">Plays here</span></div>
            <div className="eg-cursor"><svg width="16" height="20" viewBox="0 0 16 20"><path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" fill="#1f2a26" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" /></svg></div>
          </div>
          <ol className="mt-3 grid gap-1.5">
            {STEPS.map((s, i) => <li key={s} className={`eg-step eg-step-${i + 1} flex items-center gap-2 text-[12.5px] text-ink-600`}><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-canvas text-[11px] tabular-nums">{i + 1}</span>{s}</li>)}
          </ol>
          <p className="mt-3 border-t border-line pt-2.5 text-[12px] text-ink-500">Google Drive, YouTube, Vimeo, Loom and Fathom links play here as they are.</p>
        </div>
      ) : null}
    </span>
  );
}
