'use client';

import { WorkingDayHint } from '@/components/tasks/working-day-hint';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { addCallContactAction, chooseCallContactAction, discardCallAction, loadCallFormAction, searchCallContactsAction, submitCallFormAction } from '@/lib/actions/call-forms';
import type { CallContactOption, CallFormContext, FormOutcomeView } from '@/lib/calls/form-context';
import { Modal } from '@/components/modal';
import { ConfirmDialog, useConfirm } from '@/components/confirm-dialog';
import { Notice } from '@/components/ui';
import { OPEN_FORM_EVENT } from '@/lib/calls/words';

/** A call waiting for its form, as the waiting notice lists it. */
export type PendingCall = { id: string; name: string; at: string; incoming: boolean };

const GROUPS: { key: FormOutcomeView['group']; label: string }[] = [
  { key: 'reached', label: 'Reached them' },
  { key: 'not_reached', label: 'Didn\'t reach them' },
  { key: 'stop', label: 'Stop' },
];
const DATED = new Set(['call_again', 'email', 'linkedin', 'meeting']);
const STEP_LABELS: Record<string, string> = { call_again: 'Call again', email: 'Email', linkedin: 'LinkedIn', meeting: 'Meeting', keep: 'Keep the current next step', campaign: 'The campaign continues', none: 'No further action' };
const draftKey = (callId: string) => `cadence.callForm.${callId}`;

type Draft = { outcome: string; notes: string; rating: number | null; step: string; date: string; time: string; what: string; interest: string; decisionMaker: string; products: string[] };

export function readDraft(callId: string): Partial<Draft> | null {
  try { const raw = window.localStorage.getItem(draftKey(callId)); return raw ? JSON.parse(raw) as Partial<Draft> : null; } catch { return null; }
}
export function writeDraft(callId: string, d: Draft) {
  try { window.localStorage.setItem(draftKey(callId), JSON.stringify(d)); } catch { /* storage off: the form still works */ }
}
export function dropDraft(callId: string) {
  try { window.localStorage.removeItem(draftKey(callId)); } catch { /* ignore */ }
}

/** Where the form starts: a draft kept from before (B087), else the outcome the call's status suggests and the step that fits it. */
export function startingValues(c: CallFormContext, draft: Partial<Draft> | null) {
  const first = draft?.outcome ?? c.prefill ?? '';
  const o = c.outcomes.find((x) => x.key === first && !x.disabled);
  return {
    outcome: o?.key ?? '', rating: draft?.rating ?? null, notes: draft?.notes ?? '', step: draft?.step || defaultStep(o, c), stepTouched: Boolean(draft?.step), date: draft?.date ?? c.defaultDate, time: draft?.time ?? '',
    what: draft?.what ?? '', whatTouched: Boolean(draft?.what), interest: draft?.interest ?? '', decisionMaker: draft?.decisionMaker ?? '', products: draft?.products ?? [],
    closes: c.closes.linked?.key ?? (c.closes.choices.length ? '' : 'none'),
  };
}

/** B028: the next step that fits the outcome, worked out again each time it changes unless the rep picked one. */
export function defaultStep(outcome: FormOutcomeView | undefined, ctx: Pick<CallFormContext, 'campaign' | 'open' | 'incoming' | 'who'>): string {
  if (!ctx.who || !ctx.who.active) return 'none';
  if (!outcome) return ctx.incoming && ctx.open ? 'keep' : ctx.campaign ? 'campaign' : 'call_again';
  if (outcome.key === 'meeting_booked') return 'meeting';
  if (outcome.group === 'stop') return 'none';
  // B093: a call they made to us leaves the step we had planned alone unless the rep changes it.
  // N054: so does a call on a repeating next step: the series rolls on unless the rep replaces it.
  if (ctx.open && (ctx.incoming || ctx.open.repeats)) return 'keep';
  if (outcome.group === 'reached') return 'call_again';
  if (ctx.campaign) return 'campaign';
  return ctx.open ? 'keep' : 'call_again';
}

/** What a Stop outcome does, named before it is chosen (N042). */
export function stopEffects(outcome: FormOutcomeView, ctx: CallFormContext): string[] {
  const who = ctx.who?.firstName ?? 'This person';
  const campaign = ctx.campaign ? [`${ctx.campaign.name} ends.`] : [];
  const open = ctx.open ? [`The next step (${ctx.open.words}) is cancelled.`] : [];
  if (outcome.key === 'do_not_contact') return [`${who} is opted out for good: do not email, call or message them again. Cadence blocks calls and campaigns.`, ...campaign.map((c) => c.replace('ends.', 'ends as Opted out.')), ...open, ...(ctx.who?.kind === 'person' ? ['The CRM marks them Do not contact and clears their Next Action.'] : ['Bellwether shows them as Do not contact.']), 'An admin can lift it if it was a mistake.'];
  if (outcome.key === 'not_interested') return [`${who} is closed: no next step.`, ...campaign, ...open];
  return [`The number is marked wrong: nobody is asked to call it again.`, 'Only an Email, a LinkedIn message or nothing can follow.'];
}

/**
 * The post-call form (PLAN 4.6), read from the server when it opens. Top to bottom: what the call
 * closes, who it was with, what happened (three labelled groups, the red Stop group asks first),
 * the conversation, and what happens next, worked out from the outcome. Save names what is still
 * missing; the result names the next step. Notes are kept as a draft until it is in (B087).
 */
export function PostCallForm({ callId, onClose, initial }: { callId: string; onClose: () => void; /** Already read: the form starts at once (and renders on the server, for the tests). */ initial?: CallFormContext }) {
  const [loaded, setLoaded] = useState<{ ok: true; context: CallFormContext } | { ok: false; error: string } | null>(initial ? { ok: true, context: initial } : null);
  const start0 = initial ? startingValues(initial, null) : null;
  const [outcome, setOutcome] = useState(start0?.outcome ?? '');
  const [rating, setRating] = useState<number | null>(start0?.rating ?? null);
  const [notes, setNotes] = useState(start0?.notes ?? '');
  const [step, setStep] = useState(start0?.step ?? '');
  const [stepTouched, setStepTouched] = useState(false);
  const [date, setDate] = useState(start0?.date ?? '');
  const [time, setTime] = useState('');
  const [what, setWhat] = useState('');
  const [whatTouched, setWhatTouched] = useState(false);
  const [closes, setCloses] = useState<string | null>(start0?.closes ?? null);
  const [claim, setClaim] = useState(true);
  // Owner, 10 Nov 2026: the form can give an owned cold contact to someone in its pod; '' keeps the owner.
  const [newOwner, setNewOwner] = useState('');
  const [interest, setInterest] = useState('');
  const [decisionMaker, setDecisionMaker] = useState('');
  const [products, setProducts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ message: string; followUp: { addMeeting: string | null; moveToCrm: string | null } | null } | null>(null);
  const [pending, start] = useTransition();
  const [ask, dialog] = useConfirm();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);

  const load = useCallback(async () => {
    const r = await loadCallFormAction(callId);
    setLoaded(r);
    if (!r.ok) return;
    const v = startingValues(r.context, readDraft(callId));
    setOutcome(v.outcome); setRating(v.rating); setNotes(v.notes); setStep(v.step); setStepTouched(v.stepTouched); setDate(v.date); setTime(v.time);
    setWhat(v.what); setWhatTouched(v.whatTouched); setInterest(v.interest); setDecisionMaker(v.decisionMaker); setProducts(v.products); setCloses(v.closes);
  }, [callId]);
  useEffect(() => { void load(); }, [load]);

  const ctx = loaded?.ok ? loaded.context : null;
  // N045: focus starts on the outcome already chosen, else on the first one.
  useEffect(() => {
    if (!ctx) return;
    const el = formRef.current?.querySelector<HTMLInputElement>('input[name="outcome"]:checked') ?? formRef.current?.querySelector<HTMLInputElement>('input[name="outcome"]:not(:disabled)');
    el?.focus();
  }, [ctx]);
  // B087: what is typed survives closing the form and a refresh, until the form is in.
  useEffect(() => {
    if (ctx && !saved) writeDraft(callId, { outcome, notes, rating, step: stepTouched ? step : '', date, time, what: whatTouched ? what : '', interest, decisionMaker, products });
  }, [callId, ctx, saved, outcome, notes, rating, step, stepTouched, date, time, what, whatTouched, interest, decisionMaker, products]);

  if (!loaded) return <p className="text-[13px] text-ink-500" role="status">Opening the form</p>;
  if (!loaded.ok || !ctx) {
    // B184: saved in another tab: say so, and keep what was typed here so it can be copied.
    const draft = readDraft(callId);
    return <div className="space-y-3">
      <Notice tone="warn">{loaded.ok ? 'This form could not be opened.' : loaded.error}</Notice>
      {draft?.notes ? <label className="block text-xs text-ink-500">What you typed here<textarea readOnly rows={4} value={draft.notes} className="mt-1 w-full" /></label> : null}
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => { dropDraft(callId); onClose(); router.refresh(); }}>Close</button></div>
    </div>;
  }

  if (saved) {
    return <div className="space-y-4" role="status">
      <Notice tone="success">{saved.message}</Notice>
      {saved.followUp ? <div className="flex flex-wrap gap-2">
        {saved.followUp.addMeeting ? <Link href={saved.followUp.addMeeting} className="btn-primary btn-sm" onClick={onClose}>Add meeting</Link> : null}
        {saved.followUp.moveToCrm ? <Link href={saved.followUp.moveToCrm} className="btn-primary btn-sm" onClick={onClose}>Move to CRM</Link> : null}
      </div> : null}
      <div className="flex justify-end"><button type="button" className="btn-secondary" onClick={onClose}>Close</button></div>
    </div>;
  }

  const chosen = ctx.outcomes.find((o) => o.key === outcome);
  const reached = chosen?.answered ?? false;
  const first = ctx.who?.firstName ?? 'them';
  const steps = !ctx.who || !ctx.who.active ? ['none'] : chosen?.key === 'do_not_contact' || chosen?.key === 'not_interested' ? ['none'] : chosen?.group === 'stop' ? ['email', 'linkedin', 'none'] : [...(ctx.open ? ['keep'] : []), ...(ctx.campaign && !reached ? ['campaign'] : []), 'call_again', 'email', 'linkedin', 'meeting', ...(reached ? [] : ['none'])];
  const stepWords = (key: string) => key === 'keep' && ctx.open ? `Keep: ${ctx.open.words}${ctx.open.repeats ? ' (repeats)' : ''}` : key === 'campaign' && ctx.campaign ? `The campaign continues${ctx.campaign.next ? `: next is ${ctx.campaign.next}` : ''}` : ctx.campaign && !reached && DATED.has(key) && key !== 'meeting' ? `Take ${first} out: ${STEP_LABELS[key].toLowerCase()}` : STEP_LABELS[key];
  // N043 (PLAN 4.6): "What" starts as "Follow up: <first line of the notes>", for the rep to edit.
  const firstLine = notes.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const whatShown = whatTouched ? what : DATED.has(step) && firstLine ? `Follow up: ${firstLine}`.slice(0, 200) : '';
  const needsReason = outcome === 'no_conversation';
  const missing = !outcome ? 'Pick what happened.' : reached && !rating ? 'Rate the call.' : (reached || needsReason) && !notes.trim() ? needsReason ? 'Say why there was no conversation.' : 'Write what was said.' : !steps.includes(step) ? 'Pick the next step.' : DATED.has(step) && !date ? 'Pick the day of the next step.' : closes === '' ? 'Say which step this call closes, or none.' : null;

  const pick = async (o: FormOutcomeView) => {
    if (o.group === 'stop' && o.key !== outcome) {
      // N042: an outcome that stops the outreach asks first, naming every effect.
      const yes = await ask({ title: `${o.label}?`, effects: stopEffects(o, ctx), confirmLabel: o.label, tone: 'danger' });
      if (!yes) return;
    }
    setOutcome(o.key);
    if (!stepTouched) setStep(defaultStep(o, ctx));
  };

  const submit = () => {
    if (!formRef.current || missing) return;
    const fd = new FormData(formRef.current);
    fd.set('callId', callId);
    if (rating) fd.set('rating', String(rating));
    fd.set('what', whatShown);
    if (closes !== null) fd.set('closes', closes);
    if (ctx.claim) { fd.set('claimShown', '1'); fd.set('claim', claim ? '1' : '0'); }
    if (ctx.owner && newOwner && newOwner !== ctx.owner.currentId) fd.set('newOwnerId', newOwner);
    start(async () => {
      const r = await submitCallFormAction(fd);
      if (!r.ok) { setError(r.error); return; }
      dropDraft(callId);
      setSaved({ message: r.message ?? 'Saved.', followUp: (r.data as { followUp?: { addMeeting: string | null; moveToCrm: string | null } | null } | undefined)?.followUp ?? null });
      router.refresh();
    });
  };

  return <form ref={formRef} aria-label={`Form for your ${ctx.incoming ? 'call from' : 'call with'} ${ctx.name ?? 'an unknown number'}`} className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
    {dialog}
    <div className="space-y-1.5">
      <p className="text-[13px] text-ink-600">Required before your next call · {ctx.who ? <Link href={ctx.who.href} className="text-ink-900 hover:underline">{ctx.name}</Link> : ctx.number ?? 'Unknown number'}{ctx.incoming ? ' (incoming)' : ''} · {ctx.at}{ctx.talk ? ` · ${ctx.talk}` : ''}</p>
      <ClosesLine ctx={ctx} closes={closes} setCloses={setCloses} />
    </div>
    {ctx.who?.standing ? <Notice tone="warn">{ctx.who.standing}</Notice> : null}
    {!ctx.who ? <WhoWasIt ctx={ctx} onChosen={() => { setLoaded(null); void load(); }} /> : null}
    {ctx.colleague && !(newOwner && newOwner !== ctx.owner?.currentId) ? <Notice tone="info">{ctx.colleague}</Notice> : null}

    <div className="space-y-3">
      <h3 className="text-[13px] font-semibold text-ink-900">What happened</h3>
      {GROUPS.map((g) => {
        const list = ctx.outcomes.filter((o) => o.group === g.key);
        if (!list.length) return null;
        return <fieldset key={g.key} className={clsx(g.key === 'stop' && 'rounded-xl border border-red-200 bg-red-50/40 p-2.5')}>
          <legend className={clsx('mb-1.5 text-xs', g.key === 'stop' ? 'px-1 font-medium text-red-700' : 'text-ink-500')}>{g.label}</legend>
          <div className="flex flex-wrap gap-1.5">{list.map((o) => <label key={o.key} title={o.disabled ?? undefined} className={clsx('rounded-lg border px-2.5 py-1.5 text-[13px] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500', o.disabled ? 'cursor-not-allowed border-line text-ink-400' : 'cursor-pointer', outcome === o.key ? (g.key === 'stop' ? 'border-red-600 bg-red-50 text-red-800' : 'border-brand-600 bg-brand-50 text-brand-800') : !o.disabled && 'border-line text-ink-700 hover:bg-canvas')}>
            <input type="radio" name="outcome" value={o.key} checked={outcome === o.key} disabled={Boolean(o.disabled)} className="sr-only" onChange={() => { void pick(o); }} />{o.label}
          </label>)}</div>
        </fieldset>;
      })}
      {ctx.outcomes.some((o) => o.disabled) ? <p className="text-[12px] text-ink-500">{ctx.outcomes.find((o) => o.disabled)!.disabled}, so No answer and Busy are off.</p> : null}
    </div>

    {reached ? <div className="space-y-3">
      <fieldset>
        <legend className="mb-1.5 text-xs text-ink-500">Rating <span className="text-red-700">*</span></legend>
        <div className="flex gap-1.5">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" aria-pressed={rating === n} onClick={() => setRating(n)} className={clsx('h-9 w-9 rounded-lg border text-sm tabular-nums', rating === n ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line text-ink-700 hover:bg-canvas')}>{n}</button>)}</div>
      </fieldset>
      <label className="block text-xs text-ink-500">What was said <span className="text-red-700">*</span><textarea name="notes" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 w-full" /></label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block text-xs text-ink-500">Interest<select name="interest" className="mt-1 w-full" value={interest} onChange={(e) => setInterest(e.target.value)}><option value="">Not said</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option></select></label>
        <label className="block text-xs text-ink-500">Decision maker<select name="decisionMaker" className="mt-1 w-full" value={decisionMaker} onChange={(e) => setDecisionMaker(e.target.value)}><option value="">Not said</option><option value="yes">Yes</option><option value="no">No</option><option value="unknown">Unknown</option></select></label>
        <fieldset className="text-xs text-ink-500"><legend>Products discussed</legend><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{ctx.products.map((p) => <label key={p.key} className="inline-flex items-center gap-1 text-[13px] text-ink-700"><input type="checkbox" name="productsDiscussed" value={p.key} checked={products.includes(p.key)} onChange={(e) => setProducts(e.target.checked ? [...products, p.key] : products.filter((x) => x !== p.key))} />{p.label}</label>)}</div></fieldset>
      </div>
    </div> : <label className="block text-xs text-ink-500">{needsReason ? <>Why there was no conversation <span className="text-red-700">*</span></> : 'Notes (optional)'}<textarea name="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 w-full" /></label>}

    <fieldset className="space-y-2">
      <legend className="mb-1 text-[13px] font-semibold text-ink-900">What happens next</legend>
      {chosen?.key === 'do_not_contact' ? <Notice tone="error"><span className="block font-medium">This ends:</span><ul className="mt-1 list-disc pl-5">{stopEffects(chosen, ctx).map((e) => <li key={e}>{e}</li>)}</ul></Notice> : null}
      {reached && chosen?.group === 'reached' && ctx.campaign ? <p className="text-[12.5px] text-ink-600">{first} answered, so {ctx.campaign.name} ends. Set a dated next step.</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block text-xs text-ink-500">Next step<select name="nextStep" value={steps.includes(step) ? step : ''} onChange={(e) => { setStep(e.target.value); setStepTouched(true); }} className="mt-1 max-w-full">{!steps.includes(step) ? <option value="" disabled>Pick one</option> : null}{steps.map((s) => <option key={s} value={s}>{stepWords(s)}</option>)}</select></label>
        {DATED.has(step) ? <label className="block text-xs text-ink-500">Day<input type="date" name="nextStepDate" value={date} min={ctx.today} onChange={(e) => setDate(e.target.value)} className="mt-1" /></label> : null}
        {DATED.has(step) ? <WorkingDayHint date={date} workingDays={ctx.workingDays ?? []} onMove={setDate} /> : null}
        {step === 'meeting' ? <label className="block text-xs text-ink-500">Time (optional)<input type="time" name="meetingTime" value={time} onChange={(e) => setTime(e.target.value)} className="mt-1" /></label> : null}
      </div>
      {DATED.has(step) ? <label className="block text-xs text-ink-500">What<input value={whatShown} maxLength={200} placeholder={STEP_LABELS[step]} onChange={(e) => { setWhat(e.target.value); setWhatTouched(true); }} className="mt-1 w-full" /></label> : null}
      {step === 'none' && ctx.open ? <p className="text-[12.5px] text-ink-600">No further action cancels the open next step ({ctx.open.words}).</p> : null}
      {step === 'keep' && ctx.open?.repeats ? <p className="text-[12.5px] text-ink-600">This call counts as done for the repeating step; it rolls on to its next date.</p> : null}
      {DATED.has(step) && ctx.open?.repeats ? <p className="text-[12.5px] text-amber-800">{ctx.open.words} repeats. This one-off step replaces it, and it stops repeating. Pick Keep to keep it.</p> : null}
      {ctx.owner ? <label className="block text-xs text-ink-500">Owner after this call<select name="newOwnerChoice" value={newOwner || ctx.owner.currentId} onChange={(e) => setNewOwner(e.target.value === ctx.owner!.currentId ? '' : e.target.value)} className="mt-1 max-w-full">{ctx.owner.choices.map((c) => <option key={c.id} value={c.id}>{c.id === ctx.owner!.currentId ? `${c.name} (keeps it)` : c.name}</option>)}</select></label> : null}
      {ctx.owner && newOwner && newOwner !== ctx.owner.currentId ? <p className="text-[12.5px] text-ink-600">{first} goes to {ctx.owner.choices.find((c) => c.id === newOwner)?.name ?? 'them'} with their open work, and the next step is theirs.</p> : null}
      {ctx.claim && DATED.has(step) ? <label className="flex items-center gap-2 text-[13px] text-ink-800"><input type="checkbox" checked={claim} onChange={(e) => setClaim(e.target.checked)} />{ctx.claim}</label> : null}
    </fieldset>

    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    <div className="sticky bottom-0 -mx-5 -mb-5 flex flex-wrap items-center justify-between gap-2 border-t border-line bg-white px-5 py-3">
      <DiscardLink ctx={ctx} onDiscarded={() => { dropDraft(callId); onClose(); router.refresh(); }} />
      <span className="flex items-center gap-2">
        {missing ? <span className="text-[12px] text-ink-500">{missing}</span> : null}
        <button type="submit" className="btn-primary" disabled={pending || Boolean(missing)}>{pending ? 'Saving' : 'Save'}</button>
      </span>
    </div>
  </form>;
}

/** "Closes Call 2 of Q4 Harbor" with "Not for this step", a choice when the rule could not decide, or "Extra call: closes nothing" (N013). */
function ClosesLine({ ctx, closes, setCloses }: { ctx: CallFormContext; closes: string | null; setCloses: (v: string) => void }) {
  if (ctx.incoming) return <p className="text-[12.5px] text-ink-600">An incoming call closes no step.</p>;
  const { linked, choices } = ctx.closes;
  if (linked && closes === linked.key) return <p className="text-[12.5px] text-ink-700">Closes {linked.words} <button type="button" className="ml-1 text-brand-700 underline" onClick={() => setCloses('none')}>Not for this step</button></p>;
  if (!choices.length) return <p className="text-[12.5px] text-ink-600">Extra call: closes nothing.</p>;
  return <label className="block text-xs text-ink-500">Which step does this call close?<select value={closes ?? ''} onChange={(e) => setCloses(e.target.value)} className="mt-1"><option value="" disabled>Pick one</option>{choices.map((c) => <option key={c.key} value={c.key}>{c.words}</option>)}<option value="none">None: an extra call</option></select></label>;
}

/** B026: "Who did you speak to?": the people the line rings, a search of CRM people and cold contacts, or someone new. */
function WhoWasIt({ ctx, onChosen }: { ctx: CallFormContext; onChosen: () => void }) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<CallContactOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (query.trim().length < 2) { setFound([]); return; }
    let live = true;
    const t = setTimeout(async () => { const r = await searchCallContactsAction(query).catch(() => []); if (live) setFound(r); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query]);
  const choose = (key: string) => start(async () => {
    const fd = new FormData(); fd.set('callId', ctx.callId); fd.set('contact', key);
    const r = await chooseCallContactAction(fd);
    if (r.ok) onChosen(); else setError(r.error);
  });
  return <div className="space-y-2 rounded-xl border border-line p-3">
    <p className="text-[13px] font-medium text-ink-900">Who did you speak to?</p>
    <p className="text-[12.5px] text-ink-600">{ctx.candidates.length ? 'This number rings more than one person, or a firm\'s main line.' : 'Nobody in Cadence has this number.'} Until you say, the form can save no next step.</p>
    {ctx.candidates.length ? <div className="flex flex-wrap gap-1.5">{ctx.candidates.map((c) => <button key={c.key} type="button" disabled={pending} className="btn-secondary btn-sm" onClick={() => choose(c.key)}>{c.name}{c.cold ? ' (cold contact)' : ''}</button>)}</div> : null}
    <input type="search" aria-label="Find the person" placeholder="Find by name, email, phone or firm" value={query} onChange={(e) => setQuery(e.target.value)} className="w-full" />
    {found.length ? <ul className="divide-y divide-line rounded-lg border border-line">{found.map((f) => <li key={f.key}><button type="button" disabled={pending} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] hover:bg-canvas" onClick={() => choose(f.key)}><span><span className="text-ink-900">{f.name}</span>{f.sub ? <span className="text-ink-500"> · {f.sub}</span> : null}</span><span className="text-[12px] text-ink-500">{f.cold ? 'Cold contact' : 'CRM'}</span></button></li>)}</ul> : null}
    {adding ? <AddContact callId={ctx.callId} onAdded={onChosen} onCancel={() => setAdding(false)} /> : <button type="button" className="btn-ghost btn-sm" onClick={() => setAdding(true)}>Add someone new</button>}
    {error ? <p role="alert" className="text-[12.5px] text-red-700">{error}</p> : null}
  </div>;
}

function AddContact({ callId, onAdded, onCancel }: { callId: string; onAdded: () => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return <div className="space-y-2" role="group" aria-label="Add someone new">
    <p className="text-[12.5px] text-ink-600">They go into Cold outreach with this call&apos;s number, as yours.</p>
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" id={`add-${callId}`}>
      <input aria-label="First name" placeholder="First name" name="firstName" />
      <input aria-label="Last name" placeholder="Last name" name="lastName" />
      <input aria-label="Firm" placeholder="Firm" name="companyName" />
    </div>
    {error ? <p role="alert" className="text-[12.5px] text-red-700">{error}</p> : null}
    <div className="flex gap-2">
      <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => {
        const box = document.getElementById(`add-${callId}`);
        const fd = new FormData();
        fd.set('callId', callId);
        for (const el of Array.from(box?.querySelectorAll('input') ?? [])) fd.set(el.name, el.value);
        start(async () => { const r = await addCallContactAction(fd); if (r.ok) onAdded(); else setError(r.error); });
      }}>Add and continue</button>
      <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}

/** B024: "Logged by mistake?" before the form is in and within a day, with a reason leaders see. */
function DiscardLink({ ctx, onDiscarded }: { ctx: CallFormContext; onDiscarded: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (ctx.discard) return <span />;
  return <>
    <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>Not a real call? Discard</button>
    {open ? <ConfirmDialog
      title="Discard this call?"
      effects={['It counts nowhere: not in Reports, not as a touch.', 'Any step it was for stays open.', 'Leaders see that it was discarded, and why.']}
      confirmLabel="Discard"
      tone="danger"
      reason={{ label: 'Why', required: true, placeholder: 'Dialled the wrong number' }}
      pending={pending}
      error={error}
      onCancel={() => setOpen(false)}
      onConfirm={({ reason }) => start(async () => {
        const fd = new FormData(); fd.set('callId', ctx.callId); fd.set('reason', reason);
        const r = await discardCallAction(fd);
        if (r.ok) { setOpen(false); onDiscarded(); } else setError(r.error);
      })}
    /> : null}
  </>;
}

/** The form in its dialog: outside clicks do nothing, and Esc asks first (B087). */
export function CallFormDialog({ callId, title, onClose }: { callId: string; title: string; onClose: () => void }) {
  const [leaving, setLeaving] = useState(false);
  return <Modal label={title} onClose={() => setLeaving(true)} closeOnBackdrop={false} className="max-w-xl">
    <div className="p-5">
      <div className="mb-3 flex items-start justify-between gap-3"><h2 className="text-base font-semibold text-ink-900">{title}</h2><button type="button" className="btn-ghost btn-sm" onClick={() => setLeaving(true)}>Finish later</button></div>
      <PostCallForm callId={callId} onClose={onClose} />
    </div>
    {leaving ? <ConfirmDialog title="Finish later?" body="You can't call anyone until it's in. What you typed is kept on this computer." confirmLabel="Finish later" cancelLabel="Keep filling it in" onCancel={() => setLeaving(false)} onConfirm={() => { setLeaving(false); onClose(); }} /> : null}
  </Modal>;
}

/**
 * The calls waiting for their form, as a Notice inside the page (B088): the real total and every
 * call, incoming ones marked, each opening its form. Before the import has read a call back, the
 * notice says the form will open here (PLAN 4.6). The dialog stays open when its call leaves the
 * list, so a save in another tab never loses what was typed here (B184).
 */
/** B088: the notice names the oldest few and counts the rest, so a backlog never fills the screen. */
export const PENDING_SHOWN = 5;

export function PendingCalls({ calls, total, calling }: { calls: PendingCall[]; total: number; calling: string | null }) {
  const [open, setOpen] = useState<PendingCall | null>(null);
  useEffect(() => {
    const fill = () => { if (calls[0]) setOpen(calls[0]); };
    window.addEventListener(OPEN_FORM_EVENT, fill);
    return () => window.removeEventListener(OPEN_FORM_EVENT, fill);
  }, [calls]);
  const label = (c: PendingCall) => `${c.incoming ? 'Call from' : 'Call with'} ${c.name}${c.incoming ? ' (incoming)' : ''}`;
  return <>
    {total ? <div className="px-6 pt-3"><Notice tone="warn">
      <div className="flex flex-wrap items-center justify-between gap-2" role="region" aria-label="Calls waiting for their form">
        <span className="font-medium">{total === 1 ? '1 call needs its form' : `${total} calls need their form`} before you can call again.</span>
        <button type="button" className="btn-secondary btn-sm" onClick={() => calls[0] && setOpen(calls[0])}>Fill the first</button>
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">{calls.slice(0, PENDING_SHOWN).map((c) => <li key={c.id}><button type="button" className="underline-offset-2 hover:underline" onClick={() => setOpen(c)}>{label(c)} · {c.at}</button></li>)}{total > Math.min(calls.length, PENDING_SHOWN) ? <li>and {total - Math.min(calls.length, PENDING_SHOWN)} more</li> : null}</ul>
    </Notice></div> : calling ? <div className="px-6 pt-3"><Notice tone="info">Calling {calling}… when you hang up, the form opens here (within 2 minutes).</Notice></div> : null}
    {open ? <CallFormDialog callId={open.id} title={label(open)} onClose={() => setOpen(null)} /> : null}
  </>;
}
