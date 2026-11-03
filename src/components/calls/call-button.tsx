'use client';

import clsx from 'clsx';
import { callHref, opensDialpad } from '@/lib/calls';
import { recordCallIntentAction } from '@/lib/actions/call-forms';
import { IconPhone } from '@/components/icons';

type Props = {
  phone: string;
  /** The dialpad address with {phone}; blank means tel:. */
  template: string | null;
  taskId?: string | null;
  nextActionId?: string | null;
  personId?: string | null;
  sandboxContactId?: string | null;
  /** Why Cadence will not open the dialpad now (a form waiting, an opt-out, calling hours). */
  blocked?: string | null;
  /** Calling hours set to warn: asked once before the dialpad opens. */
  warning?: string | null;
  className?: string;
  label?: string;
};

/**
 * The one Call button: it opens the hosted dialpad with the number, as Call always has, and tells
 * Cadence which task or contact the call is for, so the call read back from Twilio lands there.
 */
export function CallButton({ phone, template, taskId, nextActionId, personId, sandboxContactId, blocked, warning, className = 'btn-primary', label = 'Call' }: Props) {
  if (blocked) return <button type="button" className={clsx(className, 'cursor-not-allowed opacity-60')} disabled title={blocked} aria-label={`${label}: ${blocked}`}><IconPhone size={15} />{label}</button>;
  const dialpad = opensDialpad(template);
  return <a
    href={callHref(phone, template)}
    target={dialpad ? '_blank' : undefined}
    rel={dialpad ? 'noreferrer' : undefined}
    className={className}
    onClick={(event) => {
      if (warning && !window.confirm(`${warning} Call anyway?`)) { event.preventDefault(); return; }
      void recordCallIntentAction({ phone, taskId, nextActionId, personId, sandboxContactId }).catch(() => undefined);
    }}
  ><IconPhone size={15} />{label}</a>;
}
