'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { saveTaskDraftAction } from '@/lib/actions/tasks';
import { startCallAction } from '@/lib/actions/calls';
import { RichTextEditor } from '@/components/rich-text-editor';
import { ActionIcon, IconCheck, IconCopy, IconPhone } from '@/components/icons';
import { registerDraftWriter } from './draft-registry';

type Props = { taskId: string; subject: string | null; body: string; html?: string; label: string; channel: 'EMAIL' | 'CALL' | 'LINKEDIN'; revision?: number; readOnly?: boolean; phone?: string | null; clickToCall?: boolean };
export function TaskComposer({ taskId, subject, body, html, label, channel, revision = 0, readOnly = false, phone, clickToCall = false }: Props) {
  const initialHtml = html ?? '<p>' + body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>';
  const [draft, setDraft] = useState({ subject: subject ?? '', html: initialHtml, text: body });
  const [state, setState] = useState('Saved');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [phoneCopied, setPhoneCopied] = useState(false);
  const [calling, setCalling] = useState(false);
  const [callNote, setCallNote] = useState('');
  const latest = useRef(draft);
  const saved = useRef({ subject: draft.subject, html: draft.html });
  const rev = useRef(revision);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const flush = useCallback((): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    queue.current = queue.current.then(async () => {
      const next = latest.current;
      if (readOnly || (saved.current.subject === next.subject && saved.current.html === next.html)) return true;
      if (alive.current) setState('Saving');
      try {
        const result = await saveTaskDraftAction({ taskId, subject: next.subject, html: next.html, revision: rev.current });
        if (!result.ok) { if (alive.current) { setState('Unsaved'); setError(result.error); } return false; }
        rev.current = result.revision; saved.current = { subject: next.subject, html: next.html };
        if (alive.current) { setState(latest.current.html === next.html && latest.current.subject === next.subject ? 'Saved' : 'Unsaved'); setError(''); }
        try { localStorage.removeItem('cadence:recovery:' + taskId); } catch {}
        return true;
      } catch { if (alive.current) { setState('Unsaved'); setError('Draft could not be saved. Retry or copy your work.'); } return false; }
    });
    return queue.current;
  }, [taskId, readOnly]);
  useEffect(() => {
    alive.current = true;
    const unregister = registerDraftWriter(flush);
    const unload = (event: BeforeUnloadEvent) => { if (latest.current.html !== saved.current.html || latest.current.subject !== saved.current.subject) { event.preventDefault(); void flush(); } };
    window.addEventListener('beforeunload', unload);
    return () => { alive.current = false; unregister(); window.removeEventListener('beforeunload', unload); void flush(); };
  }, [flush]);
  const change = (patch: Partial<typeof draft>) => {
    const next = { ...latest.current, ...patch }; latest.current = next; setDraft(next); setState('Unsaved');
    try { localStorage.setItem('cadence:recovery:' + taskId, JSON.stringify(next)); } catch {}
    if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flush(); }, 650);
  };
  const copy = async () => {
    try {
      const doc = new DOMParser().parseFromString(draft.html, 'text/html');
      const plain = doc.body.textContent ?? draft.text;
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([draft.html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
      else await navigator.clipboard.writeText(plain);
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch { setError('Clipboard unavailable. Select the message to copy it.'); }
  };
  return <section className="space-y-3">
    <header className="flex flex-wrap items-center gap-2"><span className="rounded-lg bg-brand-50 p-2 text-brand-700"><ActionIcon action={channel} size={19} /></span><h3 className="text-base font-semibold">{channel === 'CALL' ? 'Call preparation' : label}</h3><span className="ml-auto flex items-center gap-2">{!readOnly && <button type="button" onClick={() => { void flush(); }} className="btn-ghost btn-sm" disabled={state === 'Saved' || state === 'Saving'}>{state === 'Saved' ? <IconCheck size={12} /> : null}<strong>{state}</strong></button>}<button type="button" className="btn-secondary btn-sm" onClick={copy}><IconCopy size={13} />{copied ? 'Copied' : 'Copy message'}</button></span></header>
    {channel === 'CALL' && <div className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="text-xs text-ink-500">Phone</div><strong className="mt-1 block text-lg text-ink-900">{phone || 'No number in Twenty'}</strong></div>
        {phone ? <div className="flex flex-wrap items-center gap-2">
          {clickToCall
            ? <button type="button" disabled={calling || readOnly} className="btn-primary" onClick={async () => {
                setCalling(true); setError(''); setCallNote('');
                const result = await startCallAction({ taskId });
                setCalling(false);
                if (result.ok) setCallNote(result.message); else setError(result.error);
              }}><IconPhone size={15} />{calling ? 'Connecting' : 'Call'}</button>
            : <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className="btn-primary"><IconPhone size={15} />Call</a>}
          <button type="button" className="btn-secondary" onClick={async () => { try { await navigator.clipboard.writeText(phone); setPhoneCopied(true); setTimeout(() => setPhoneCopied(false), 1800); } catch { setError('Clipboard unavailable. Select the phone number to copy.'); } }}>{phoneCopied ? 'Copied' : 'Copy number'}</button>
        </div> : null}
      </div>
      {callNote ? <p role="status" className="text-sm font-semibold text-brand-800">{callNote}</p> : null}
    </div>}
    {channel === 'EMAIL' && <label className="block text-xs text-ink-500">Subject<input aria-label="Email subject" value={draft.subject} readOnly={readOnly} className="mt-1 w-full !font-semibold !text-ink-900" onChange={e => change({ subject: e.target.value })} onBlur={() => { void flush(); }} /></label>}
    <RichTextEditor value={draft.html} label={channel === 'CALL' ? 'Call script' : label + ' message'} disabled={readOnly} onChange={(nextHtml, text) => change({ html: nextHtml, text })} />
    {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
  </section>;
}
