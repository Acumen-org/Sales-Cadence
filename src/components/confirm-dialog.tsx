'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { Modal } from '@/components/modal';

/**
 * The one confirm (cold outreach PLAN 4.0): a Modal that names the person and every effect, and,
 * where the act needs one, asks for a reason. Every browser confirm box is this now, so a question
 * looks the same wherever it is asked, and a reason travels with the act to the server.
 */

export type ConfirmReason = {
  label: string;
  /** Required: the confirm button stays off until something is written. */
  required?: boolean;
  placeholder?: string;
};

export type ConfirmOptions = {
  /** The question, naming who it is about: "Opt Jane Doe out?". */
  title: string;
  /** What happens, one line each: "Q4 Harbor ends", "Bellwether marks her Do not contact". */
  effects?: ReactNode[];
  /** Anything more to say, under the effects. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger for an act that cannot be taken back (opt out, remove, erase). */
  tone?: 'danger' | 'primary';
  reason?: ConfirmReason;
};

export type ConfirmAnswer = { reason: string };

type Props = ConfirmOptions & {
  onConfirm: (answer: ConfirmAnswer) => void;
  onCancel: () => void;
  pending?: boolean;
  error?: string | null;
  /** Extra controls between the effects and the buttons (a checkbox, a choice). */
  children?: ReactNode;
  confirmDisabled?: boolean;
};

export function ConfirmDialog({ title, effects = [], body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'primary', reason, onConfirm, onCancel, pending = false, error = null, children, confirmDisabled = false }: Props) {
  const [text, setText] = useState('');
  const missing = Boolean(reason?.required && !text.trim());
  // Focus starts on the reason when there is one, else on Cancel (the first control), never on the act itself.
  return <Modal label={title} onClose={() => { if (!pending) onCancel(); }} className="max-w-md">
    <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); if (!missing && !confirmDisabled && !pending) onConfirm({ reason: text.trim() }); }}>
      <h2 className="text-base font-semibold text-ink-900">{title}</h2>
      {effects.length ? <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-700">{effects.map((e, i) => <li key={i}>{e}</li>)}</ul> : null}
      {body ? <div className="text-[13px] text-ink-700">{body}</div> : null}
      {children}
      {reason ? <label className="block text-xs text-ink-500">{reason.label}{reason.required ? <span className="text-red-700"> (required)</span> : null}
        <textarea data-autofocus rows={2} maxLength={500} value={text} placeholder={reason.placeholder} onChange={(e) => setText(e.target.value)} className="mt-1 w-full" />
      </label> : null}
      {error ? <p role="alert" className="text-[13px] text-red-700">{error}</p> : null}
      {missing ? <p className="text-[12px] text-ink-500">Write the reason to go on.</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" disabled={pending} onClick={onCancel}>{cancelLabel}</button>
        <button type="submit" className={tone === 'danger' ? 'btn-danger' : 'btn-primary'} disabled={pending || missing || confirmDisabled}>{pending ? 'Working' : confirmLabel}</button>
      </div>
    </form>
  </Modal>;
}

/**
 * The confirm asked from code, where a browser confirm box used to be: `const [ask, dialog] = useConfirm()`,
 * render `dialog`, then `const answer = await ask({...})`: null when cancelled, else the reason typed.
 */
export function useConfirm() {
  const [open, setOpen] = useState<{ opts: ConfirmOptions; resolve: (answer: ConfirmAnswer | null) => void } | null>(null);
  const ask = useCallback((opts: ConfirmOptions | string) => new Promise<ConfirmAnswer | null>((resolve) => setOpen({ opts: typeof opts === 'string' ? { title: opts } : opts, resolve })), []);
  const dialog = open ? <ConfirmDialog {...open.opts} onConfirm={(answer) => { open.resolve(answer); setOpen(null); }} onCancel={() => { open.resolve(null); setOpen(null); }} /> : null;
  return [ask, dialog] as const;
}
