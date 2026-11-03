'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { submitCallFormAction } from '@/lib/actions/call-forms';
import { Modal } from '@/components/modal';

export type FormOutcome = { key: string; label: string; answered: boolean };
export type PendingCall = { id: string; name: string; at: string; number: string | null; twilioStatus: string | null; talk: string | null };

const STEPS = [
  { key: 'call_again', label: 'Call again' },
  { key: 'email', label: 'Email' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'meeting', label: 'Meeting' },
  { key: 'none', label: 'No further action' },
];
const ENDING = new Set(['not_interested', 'do_not_contact', 'wrong_number']);
const PREFILL: Record<string, string> = { busy: 'busy', 'no-answer': 'no_answer', failed: 'no_answer', canceled: 'no_answer' };

/**
 * The post-call form (plan section 10). Outcome first; rating and notes when the person answered;
 * then the next step together with its day, which is one field (decision 6).
 */
export function PostCallForm({ call, outcomes, products, defaultDate, today, onDone }: { call: PendingCall; outcomes: FormOutcome[]; products: string[]; defaultDate: string; today: string; onDone: () => void }) {
  const [outcome, setOutcome] = useState(PREFILL[call.twilioStatus ?? ''] && outcomes.some((o) => o.key === PREFILL[call.twilioStatus ?? '']) ? PREFILL[call.twilioStatus ?? ''] : '');
  const [rating, setRating] = useState<number | null>(null);
  const [step, setStep] = useState('call_again');
  const [date, setDate] = useState(defaultDate);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const answered = outcomes.find((o) => o.key === outcome)?.answered ?? false;

  return <form
    aria-label={`Form for your call with ${call.name}`}
    className="space-y-4"
    onSubmit={(e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      fd.set('callId', call.id);
      if (rating) fd.set('rating', String(rating));
      start(async () => {
        const r = await submitCallFormAction(fd);
        if (!r.ok) { setError(r.error); return; }
        onDone();
        router.refresh();
      });
    }}
  >
    <div className="text-sm text-ink-600">{call.name}{call.number ? ` · ${call.number}` : ''} · {call.at}{call.talk ? ` · ${call.talk}` : ''}</div>
    <fieldset>
      <legend className="mb-2 text-xs text-ink-500">Outcome</legend>
      <div className="flex flex-wrap gap-1.5">{outcomes.map((o) => <label key={o.key} className={clsx('cursor-pointer rounded-lg border px-2.5 py-1.5 text-[13px]', outcome === o.key ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line text-ink-700 hover:bg-canvas')}>
        <input type="radio" name="outcome" value={o.key} checked={outcome === o.key} className="sr-only" onChange={() => { setOutcome(o.key); if (ENDING.has(o.key)) setStep('none'); }} />{o.label}
      </label>)}</div>
    </fieldset>
    {answered ? <>
      <fieldset>
        <legend className="mb-2 text-xs text-ink-500">Rating</legend>
        <div className="flex gap-1.5">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" aria-pressed={rating === n} onClick={() => setRating(n)} className={clsx('h-9 w-9 rounded-lg border text-sm tabular-nums', rating === n ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line text-ink-700 hover:bg-canvas')}>{n}</button>)}</div>
      </fieldset>
      <label className="block text-xs text-ink-500">Notes<textarea name="notes" rows={4} className="mt-1 w-full" required /></label>
    </> : <label className="block text-xs text-ink-500">Notes<textarea name="notes" rows={2} className="mt-1 w-full" /></label>}
    <fieldset>
      <legend className="mb-2 text-xs text-ink-500">Next step</legend>
      <div className="flex flex-wrap items-center gap-2">
        <select name="nextStep" aria-label="Next step" value={step} onChange={(e) => setStep(e.target.value)}>{STEPS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        {step !== 'none' ? <input type="date" name="nextStepDate" aria-label="Next step day" value={date} min={today} required onChange={(e) => setDate(e.target.value)} /> : null}
      </div>
    </fieldset>
    <div className="grid grid-cols-3 gap-3">
      <label className="block text-xs text-ink-500">Interest<select name="interest" className="mt-1 w-full" defaultValue=""><option value="">Not said</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option></select></label>
      <label className="block text-xs text-ink-500">Decision maker<select name="decisionMaker" className="mt-1 w-full" defaultValue=""><option value="">Not said</option><option value="yes">Yes</option><option value="no">No</option><option value="unknown">Unknown</option></select></label>
      <fieldset className="text-xs text-ink-500"><legend>Products discussed</legend><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{products.map((p) => <label key={p} className="inline-flex items-center gap-1 text-[13px] text-ink-700"><input type="checkbox" name="productsDiscussed" value={p} />{p}</label>)}</div></fieldset>
    </div>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    <div className="flex justify-end gap-2"><button type="submit" className="btn-primary" disabled={pending || !outcome}>{pending ? 'Saving' : 'Save'}</button></div>
  </form>;
}

/** The bar above the page while a call of yours waits for its form; each opens the form. */
export function PendingCalls({ calls, outcomes, products, defaultDate, today }: { calls: PendingCall[]; outcomes: FormOutcome[]; products: string[]; defaultDate: string; today: string }) {
  const [open, setOpen] = useState<PendingCall | null>(null);
  if (!calls.length) return null;
  return <div role="region" aria-label="Calls waiting for their form" className="border-b border-amber-200 bg-amber-50 px-6 py-2">
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-amber-900">
      {calls.map((c) => <button key={c.id} type="button" onClick={() => setOpen(c)} className="rounded-md border border-amber-300 bg-white px-2.5 py-1 hover:bg-amber-100">Your call with {c.name}, {c.at}</button>)}
    </div>
    {open ? <Modal label={`Your call with ${open.name}`} onClose={() => setOpen(null)} className="max-w-xl">
      <div className="p-5"><h2 className="mb-3 text-base font-semibold text-ink-900">Your call with {open.name}</h2><PostCallForm call={open} outcomes={outcomes} products={products} defaultDate={defaultDate} today={today} onDone={() => setOpen(null)} /></div>
    </Modal> : null}
  </div>;
}
