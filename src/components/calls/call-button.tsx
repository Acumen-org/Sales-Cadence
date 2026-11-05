'use client';

import { useState } from 'react';
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
 * What was true when the page was drawn may not be at the click (a form came due, the contact was
 * opted out, calling hours ended), so the server checks again first (N008). The dialpad's tab opens
 * at the click, to keep the browser's permission, and closes again when the server says no.
 */
export function CallButton({ phone, template, taskId, nextActionId, personId, sandboxContactId, blocked, warning, className = 'btn-primary', label = 'Call' }: Props) {
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (blocked) return <button type="button" className={clsx(className, 'cursor-not-allowed opacity-60')} disabled title={blocked} aria-label={`${label}: ${blocked}`}><IconPhone size={15} />{label}</button>;
  const dialpad = opensDialpad(template);
  const href = callHref(phone, template);
  const open = (tab: Window | null) => { if (tab) tab.location.href = href; else window.location.href = href; };
  return <span className="inline-flex flex-col items-start gap-1">
    <a
      href={href}
      target={dialpad ? '_blank' : undefined}
      rel={dialpad ? 'noreferrer' : undefined}
      className={clsx(className, busy && 'pointer-events-none opacity-70')}
      aria-busy={busy}
      onClick={(event) => {
        event.preventDefault();
        if (warning && !window.confirm(`${warning} Call anyway?`)) return;
        const tab = dialpad ? window.open('about:blank', '_blank') : null;
        setBusy(true);
        setRefused(null);
        const input = { phone, taskId, nextActionId, personId, sandboxContactId };
        void (async () => {
          try {
            // A warning the page already asked about is not asked twice.
            let r = await recordCallIntentAction({ ...input, confirmed: Boolean(warning) });
            // A question asked once (a number marked wrong, calling hours set to warn).
            if (r.ok && (r.data as { confirm?: boolean } | undefined)?.confirm) {
              if (!window.confirm(r.message ?? 'Call anyway?')) { tab?.close(); return; }
              r = await recordCallIntentAction({ ...input, confirmed: true });
            }
            if (!r.ok) { tab?.close(); setRefused(r.error); return; }
            open(tab);
          } catch {
            tab?.close();
            setRefused('Cadence could not check this call. Try again.');
          } finally {
            setBusy(false);
          }
        })();
      }}
    ><IconPhone size={15} />{label}</a>
    {refused ? <span role="alert" className="max-w-xs text-[12px] text-red-700">{refused}</span> : null}
  </span>;
}
