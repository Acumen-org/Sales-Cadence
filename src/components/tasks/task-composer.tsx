'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { saveTaskDraftAction } from '@/lib/actions/tasks';
import { RichTextEditor } from '@/components/rich-text-editor';
import { ActionIcon, IconCheck, IconCopy } from '@/components/icons';
import { registerDraftWriter } from './draft-registry';
import { CallButton } from '@/components/calls/call-button';

type Props = { taskId: string; subject: string | null; body: string; html?: string; label: string; channel: 'EMAIL' | 'CALL' | 'LINKEDIN'; revision?: number; readOnly?: boolean; phone?: string | null; /** The dialpad address with {phone}; blank means tel:. */ callTemplate?: string | null; personId?: string | null; sandboxContactId?: string | null; /** Why Call is off now (a form waiting, an opt-out), or a warning asked first. */ callBlocked?: string | null; callWarning?: string | null; /** On an email: "Closes itself when you send from Outlook" or "Click Done after sending" (N088, graph-mail.ts emailCloseWords). */ closeWords?: string | null; /** Who it goes to (N057): the "To" line with Copy and an Outlook link, or why there is nobody to send to (N056). */ recipient?: { name: string; firstName: string; email: string | null } | null; /** The LinkedIn profile, as a link inside a LinkedIn module. */ profileUrl?: string | null; /** Where a missing email or profile is added. */ addDetailsHref?: string | null };

/** The message as plain text: paragraphs and line breaks kept, for LinkedIn and anything without formatting. */
function plainOf(html: string, fallback: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.body.querySelectorAll('li').forEach((li) => li.prepend('- '));
  doc.body.querySelectorAll('p, div, li, h1, h2, h3, blockquote').forEach((block) => block.append('\n'));
  return (doc.body.textContent ?? fallback).replace(/\n{3,}/g, '\n\n').trim();
}

/** An Outlook on the web draft to this address, with this subject and message. */
export const outlookComposeHref = (to: string, subject: string, body: string) => `https://outlook.office.com/mail/deeplink/compose?${new URLSearchParams({ to, subject, body }).toString()}`;

export function TaskComposer({ taskId, subject, body, html, label, channel, revision = 0, readOnly = false, phone, callTemplate = null, personId = null, sandboxContactId = null, callBlocked = null, callWarning = null, closeWords = null, recipient = null, profileUrl = null, addDetailsHref = null }: Props) {
  const initialHtml = html ?? '<p>' + body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>';
  const [draft, setDraft] = useState({ subject: subject ?? '', html: initialHtml, text: body });
  const [state, setState] = useState('Saved');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [phoneCopied, setPhoneCopied] = useState(false);
  const [copiedWhat, setCopiedWhat] = useState<string | null>(null);
  const latest = useRef(draft);
  const saved = useRef({ subject: draft.subject, html: draft.html });
  const rev = useRef(revision);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // The editor normalises the HTML it is handed and reports that back as a change before anybody
  // has typed. Without this, opening a task marked its draft unsaved and then persisted a copy
  // nobody edited - which froze that task's message against later edits to the sequence step.
  const touched = useRef(false);
  const flush = useCallback((): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    queue.current = queue.current.then(async () => {
      const next = latest.current;
      if (readOnly || (saved.current.subject === next.subject && saved.current.html === next.html)) { if (alive.current && !readOnly) setState('Saved'); return true; }
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
    const next = { ...latest.current, ...patch }; latest.current = next; setDraft(next);
    if (!touched.current) { saved.current = { subject: next.subject, html: next.html }; return; }
    setState('Unsaved');
    try { localStorage.setItem('cadence:recovery:' + taskId, JSON.stringify(next)); } catch {}
    if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void flush(); }, 650);
  };
  const copyText = async (what: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopiedWhat(what); setTimeout(() => setCopiedWhat(null), 1800); } catch { setError('Clipboard unavailable. Select the text to copy it.'); }
  };
  const copy = async () => {
    try {
      const plain = plainOf(draft.html, draft.text);
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([draft.html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
      else await navigator.clipboard.writeText(plain);
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch { setError('Clipboard unavailable. Select the message to copy it.'); }
  };
  return <section className="space-y-3" onFocusCapture={() => { touched.current = true; }}>
    <header className="flex flex-wrap items-center gap-2"><span className="rounded-lg bg-brand-50 p-2 text-brand-700"><ActionIcon action={channel} size={19} /></span><h3 className="text-base font-semibold">{channel === 'CALL' ? 'Call preparation' : label}</h3><span className="ml-auto flex items-center gap-2">{!readOnly && <button type="button" onClick={() => { void flush(); }} aria-live="polite" className={state === 'Saved' ? 'btn-ghost btn-sm' : state === 'Saving' ? 'btn-ghost btn-sm' : 'btn-sm rounded-lg border border-amber-300 bg-amber-50 px-2.5 font-medium text-amber-800 hover:bg-amber-100'} disabled={state === 'Saved' || state === 'Saving'}>{state === 'Saved' ? <IconCheck size={12} /> : null}<strong>{state === 'Unsaved' ? 'Unsaved - save now' : state}</strong></button>}<button type="button" className="btn-secondary btn-sm" onClick={copy}><IconCopy size={13} />{copied ? 'Copied' : channel === 'CALL' ? 'Copy script' : 'Copy message'}</button></span></header>
    {channel === 'CALL' && <div className="space-y-3 rounded-xl border border-brand-200 bg-brand-50/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="text-xs text-ink-500">Phone</div><strong className="mt-1 block text-lg text-ink-900">{phone || 'No phone number'}</strong></div>
        {phone ? <div className="flex flex-wrap items-center gap-2">
          <CallButton phone={phone} template={callTemplate} taskId={taskId} personId={personId} sandboxContactId={sandboxContactId} blocked={callBlocked} warning={callWarning} ariaLabel={recipient ? `Call ${recipient.name}` : undefined} />
          <button type="button" className="btn-secondary" onClick={async () => { try { await navigator.clipboard.writeText(phone); setPhoneCopied(true); setTimeout(() => setPhoneCopied(false), 1800); } catch { setError('Clipboard unavailable. Select the phone number to copy.'); } }}>{phoneCopied ? 'Copied' : 'Copy number'}</button>
        </div> : null}
      </div>
    </div>}
    {channel === 'EMAIL' && recipient ? (recipient.email
      ? <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas/60 px-3 py-2 text-[13px]">
          <span className="min-w-0 flex-1 truncate text-ink-700">To: <span className="font-medium text-ink-900">{recipient.name}</span> &lt;{recipient.email}&gt;</span>
          <button type="button" className="btn-ghost btn-sm" onClick={() => copyText('address', recipient.email!)}>{copiedWhat === 'address' ? 'Copied' : 'Copy address'}</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => copyText('subject', draft.subject)}>{copiedWhat === 'subject' ? 'Copied' : 'Copy subject'}</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => copyText('all', `${draft.subject}\n\n${plainOf(draft.html, draft.text)}`)}>{copiedWhat === 'all' ? 'Copied' : 'Copy all'}</button>
          <a className="btn-secondary btn-sm" target="_blank" rel="noreferrer" href={outlookComposeHref(recipient.email, draft.subject, draft.text)}>Open in Outlook</a>
        </div>
      : <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">No email for {recipient.firstName || recipient.name}: add one or skip this step.{addDetailsHref ? <> <a href={addDetailsHref} className="font-medium underline">Add email</a></> : null}</p>) : null}
    {channel === 'LINKEDIN' && recipient ? (profileUrl
      ? <div className="flex flex-wrap items-center gap-2"><a href={profileUrl} target="_blank" rel="noreferrer" className="btn-secondary btn-sm"><ActionIcon action="LINKEDIN_MESSAGE" size={13} />Open {recipient.firstName || recipient.name}&apos;s LinkedIn profile</a></div>
      : <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">No LinkedIn profile for {recipient.firstName || recipient.name}: add one or skip this step.{addDetailsHref ? <> <a href={addDetailsHref} className="font-medium underline">Add profile</a></> : null}</p>) : null}
    {channel === 'EMAIL' && <label className="block text-xs text-ink-500">Subject<input aria-label="Email subject" value={draft.subject} readOnly={readOnly} maxLength={300} className="mt-1 w-full !font-medium !text-ink-900" onChange={e => change({ subject: e.target.value })} onBlur={() => { void flush(); }} /></label>}
    {channel === 'EMAIL' && closeWords ? <p className="text-[12px] text-ink-500">{closeWords}</p> : null}
    <RichTextEditor value={draft.html} label={channel === 'CALL' ? 'Call script' : label + ' message'} disabled={readOnly} onChange={(nextHtml, text) => change({ html: nextHtml, text })} />
    {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
  </section>;
}
