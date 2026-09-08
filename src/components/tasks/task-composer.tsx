'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { IconCheck, IconCopy, IconRefresh } from '@/components/icons';

type Props = {
  taskId: string;
  /** Rendered from the sequence template, with the person's details filled in. */
  subject: string | null;
  body: string;
  /** "Email 2", "LinkedIn message"... shown as the panel's label. */
  label: string;
  variantLabel?: string | null;
  channel: 'EMAIL' | 'CALL' | 'LINKEDIN';
};

const key = (taskId: string) => `cadence:draft:${taskId}`;

/**
 * The message for this step, editable in place.
 *
 * The template is a starting point, not the thing you send: an FO reads the person's history on
 * the right and personalises the copy here before sending it from their own mailbox. Edits are
 * kept in this browser against the task id, so switching tasks or reloading does not lose them,
 * and "Reset" puts the template back. Nothing is written to Twenty from here.
 */
export function TaskComposer({ taskId, subject, body, label, variantLabel, channel }: Props) {
  const [draftSubject, setDraftSubject] = useState(subject ?? '');
  const [draftBody, setDraftBody] = useState(body);
  const [edited, setEdited] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Load any draft for this task, then keep the textarea sized to its content.
  useEffect(() => {
    let s = subject ?? '';
    let b = body;
    let isEdited = false;
    try {
      const raw = window.localStorage.getItem(key(taskId));
      if (raw) {
        const saved = JSON.parse(raw) as { subject?: string; body?: string };
        if (typeof saved.subject === 'string') s = saved.subject;
        if (typeof saved.body === 'string') b = saved.body;
        isEdited = s !== (subject ?? '') || b !== body;
      }
    } catch {
      /* private window, or storage blocked: the template is still fine */
    }
    setDraftSubject(s);
    setDraftBody(b);
    setEdited(isEdited);
  }, [taskId, subject, body]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 520)}px`;
  }, [draftBody]);

  const save = (next: { subject?: string; body?: string }) => {
    const s = next.subject ?? draftSubject;
    const b = next.body ?? draftBody;
    setEdited(s !== (subject ?? '') || b !== body);
    try {
      if (s === (subject ?? '') && b === body) window.localStorage.removeItem(key(taskId));
      else window.localStorage.setItem(key(taskId), JSON.stringify({ subject: s, body: b }));
    } catch {
      /* not fatal: the edit still applies for this view */
    }
  };

  const reset = () => {
    setDraftSubject(subject ?? '');
    setDraftBody(body);
    setEdited(false);
    try {
      window.localStorage.removeItem(key(taskId));
    } catch {
      /* ignore */
    }
  };

  const copy = async () => {
    const text = [draftSubject ? `Subject: ${draftSubject}` : null, draftBody].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: the text is selectable in the field */
    }
  };

  const words = draftBody.trim() ? draftBody.trim().split(/\s+/).length : 0;

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-canvas/60 px-3.5 py-2">
        <h3 className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">{label}</h3>
        {variantLabel ? <span className="rounded bg-purple-50 px-1.5 text-[10.5px] font-medium text-purple-700">Variant {variantLabel}</span> : null}
        {edited ? <span className="rounded bg-brand-50 px-1.5 text-[10.5px] font-medium text-brand-700">personalised</span> : null}
        <span className="ml-auto flex items-center gap-1">
          {edited ? (
            <button type="button" onClick={reset} className="btn-ghost btn-sm" title="Put the template back">
              <IconRefresh size={13} /> Reset
            </button>
          ) : null}
          <button type="button" onClick={copy} className={clsx('btn-secondary btn-sm', copied && 'border-emerald-300 text-emerald-700')}>
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </header>

      <div className="px-3.5 py-3">
        {channel === 'EMAIL' && subject !== null ? (
          <div className="mb-2.5 flex items-baseline gap-2 border-b border-line pb-2.5">
            <label htmlFor={`subject-${taskId}`} className="shrink-0 text-[12px] font-medium text-ink-400">
              Subject
            </label>
            <input
              id={`subject-${taskId}`}
              value={draftSubject}
              onChange={(e) => {
                setDraftSubject(e.target.value);
                save({ subject: e.target.value });
              }}
              className="!border-0 !bg-transparent !px-0 !py-0 !text-[14px] !font-semibold !text-ink-900 !ring-0"
              placeholder="Subject line"
            />
          </div>
        ) : null}

        <textarea
          ref={bodyRef}
          id={`body-${taskId}`}
          aria-label={`${label} message`}
          value={draftBody}
          onChange={(e) => {
            setDraftBody(e.target.value);
            save({ body: e.target.value });
          }}
          rows={6}
          className="w-full resize-none !border-0 !bg-transparent !px-0 !py-0 !text-[13.5px] !leading-relaxed !text-ink-800 !ring-0"
          placeholder={channel === 'CALL' ? 'Notes to work from on the call...' : 'Write the message...'}
        />

        <p className="mt-2 border-t border-line pt-2 text-[11px] text-ink-400">
          {words} word{words === 1 ? '' : 's'} · edit freely, then copy into your mailbox. Cadence never sends it for you.
        </p>
      </div>
    </section>
  );
}
