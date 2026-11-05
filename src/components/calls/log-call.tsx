'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { logManualCallAction } from '@/lib/actions/call-forms';
import { Modal } from '@/components/modal';
import { CallFormDialog } from './post-call-form';

type Props = {
  personId?: string | null;
  sandboxContactId?: string | null;
  name: string;
  /** The call steps the call could close: "Call 2 of Q4 Harbor". */
  steps: { key: string; words: string }[];
  /** Now, in Cadence's time, as a datetime-local value. */
  now: string;
  /** Why a call cannot be logged now (a form waiting), shown under the button (B089). */
  blocked?: string | null;
  className?: string;
  label?: string;
};

/**
 * Log a call made off Cadence's dialpad (a mobile, another phone). Nothing is saved until Save (B024):
 * it asks when, how long, which way and which step, then the call's form opens. One path: when Twilio
 * reads the same call back, it joins this record, with no second form (N014).
 */
export function LogCallButton({ personId = null, sandboxContactId = null, name, steps, now, blocked = null, className = 'btn-secondary btn-sm', label = 'Log a call' }: Props) {
  const [open, setOpen] = useState(false);
  const [callId, setCallId] = useState<string | null>(null);
  const [direction, setDirection] = useState('OUTBOUND');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  if (blocked) return <span className="inline-flex flex-col items-start gap-1"><button type="button" className={className} disabled>{label}</button><span className="max-w-xs text-[12px] text-ink-600">{blocked}</span></span>;
  return <>
    <button type="button" className={className} onClick={() => { setError(null); setOpen(true); }}>{label}</button>
    {open ? <Modal label={`Log a call with ${name}`} onClose={() => setOpen(false)} className="max-w-md">
      <form className="space-y-4 p-5" onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        if (personId) fd.set('personId', personId);
        if (sandboxContactId) fd.set('sandboxContactId', sandboxContactId);
        start(async () => {
          const r = await logManualCallAction(fd);
          if (!r.ok) { setError(r.error); return; }
          setOpen(false);
          setCallId((r.data as { callId: string }).callId);
          router.refresh();
        });
      }}>
        <h2 className="text-base font-semibold text-ink-900">Log a call with {name}</h2>
        <p className="text-[13px] text-ink-600">For a call made from another phone. Nothing is saved until you press Save; then its form opens.</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-ink-500">When<input type="datetime-local" name="startedAt" defaultValue={now} max={now} required className="mt-1 w-full" /></label>
          <label className="block text-xs text-ink-500">How long (minutes)<input type="number" name="minutes" min={0} max={600} step={0.5} defaultValue="" className="mt-1 w-full" /></label>
          <label className="block text-xs text-ink-500">Which way<select name="direction" value={direction} onChange={(e) => setDirection(e.target.value)} className="mt-1 w-full"><option value="OUTBOUND">I called them</option><option value="INBOUND">They called me</option></select></label>
          {direction === 'OUTBOUND' && steps.length ? <label className="block text-xs text-ink-500">Which step it was for<select name="closes" defaultValue={steps.length === 1 ? steps[0].key : ''} className="mt-1 w-full"><option value="">None: an extra call</option>{steps.map((s) => <option key={s.key} value={s.key}>{s.words}</option>)}</select></label> : null}
        </div>
        {error ? <p role="alert" className="text-[13px] text-red-700">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Saving' : 'Save'}</button>
        </div>
      </form>
    </Modal> : null}
    {callId ? <CallFormDialog callId={callId} title={`Your call with ${name}`} onClose={() => setCallId(null)} /> : null}
  </>;
}
