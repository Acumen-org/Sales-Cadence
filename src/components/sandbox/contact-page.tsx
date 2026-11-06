'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Modal } from '@/components/modal';
import { ActionForm } from '@/components/action-form';
import { useFlash } from '@/components/flash';
import { IconClose } from '@/components/icons';
import { NextActionButton, type NextActionDraft } from '@/components/people/next-action-form';
import { AddToCampaign } from '@/components/campaigns/add-to-campaign';
import { addNoteAction, claimContactsAction, setNextActionAction, setPodAction, updateContactAction } from '@/lib/actions/sandbox';
import { OPEN_FORM_EVENT } from '@/lib/calls/words';
import { coldRef, subjectHref } from '@/lib/subject';

/*
 * The cold contact page's own controls (PLAN 4.2): the Edit dialog, the next step, notes, the pod
 * picker and the "Fill it in" fix. Every result goes to the page's `?flash=` toast, so it survives the
 * page re-reading itself (B148), and an old error goes as soon as the fields change (B203).
 */

/** What the Edit dialog shows and compares: each field as the page loaded it. */
export type EditableContact = {
  firstName: string; lastName: string; jobTitle: string; email: string; phone: string; phoneExtension: string; phoneType: string;
  linkedinUrl: string; city: string; state: string; country: string; companyName: string; companyWebsite: string; companyCrd: string;
  individualCrd: string; productInterest: string[];
};
type Field = Exclude<keyof EditableContact, 'productInterest'>;

const PHONE_TYPES = [['direct', 'Direct'], ['mobile', 'Mobile'], ['office', 'Office'], ['main', 'Main line'], ['toll_free', 'Toll free'], ['unknown', 'Unknown']] as const;

/**
 * Edit (B052, N024, B138, B051, B139): the details read-only on the page, changed here. Only the
 * fields that changed are sent, with the version the dialog loaded, so nobody's flags, verification,
 * extension or newer edit is undone by a save that did not touch them. Country is a list. The same
 * name at the same firm asks first, with a link to that contact.
 */
export function EditContactButton({ id, contact, version, countries, products, label = 'Edit', className = 'btn-secondary btn-sm', focus }: { id: string; contact: EditableContact; version: string; countries: { code: string; name: string }[]; products: { value: string; label: string }[]; label?: string; className?: string; /** The field to start on: a checklist item's fix. */ focus?: Field }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [twin, setTwin] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const say = useFlash();
  const submit = (form: HTMLFormElement, anyway: boolean) => {
    const fd = new FormData(form);
    const out = new FormData();
    out.set('id', id);
    out.set('version', version);
    if (anyway) out.set('saveAnyway', '1');
    let changed = 0;
    for (const k of Object.keys(contact) as (keyof EditableContact)[]) {
      if (k === 'productInterest') {
        const now = fd.getAll('productInterest').map(String).sort();
        if (JSON.stringify(now) !== JSON.stringify([...contact.productInterest].sort())) { for (const p of now) out.append('productInterest', p); if (!now.length) out.set('productInterest', ''); changed++; }
        continue;
      }
      const now = String(fd.get(k) ?? '').trim();
      if (now !== contact[k].trim()) { out.set(k, now); changed++; }
    }
    // A new number keeps the extension the box shows, rather than losing it (B052).
    if (out.has('phone') && !out.has('phoneExtension')) out.set('phoneExtension', String(fd.get('phoneExtension') ?? ''));
    if (!changed) { setOpen(false); say('Nothing had changed.'); return; }
    start(async () => {
      const r = await updateContactAction(out);
      if (r.ok) { setOpen(false); setError(null); setTwin(null); say(r.message ?? 'Saved.'); return; }
      setError(r.error);
      setTwin(((r as { data?: { possibleDuplicate?: string } }).data)?.possibleDuplicate ?? null);
    });
  };
  const input = (field: Field, text: string, type = 'text') => <label className="block space-y-1.5"><span className="text-[12px] font-medium text-ink-600">{text}</span><input name={field} type={type} defaultValue={contact[field]} data-autofocus={focus === field ? true : undefined} /></label>;
  return <>
    <button type="button" className={className} onClick={() => { setError(null); setTwin(null); setOpen(true); }}>{label}</button>
    {open ? <Modal label={`Edit ${contact.firstName} ${contact.lastName}`.trim()} onClose={() => { if (!pending) setOpen(false); }} className="max-w-2xl">
      <form className="flex max-h-[calc(100dvh-12vh-26px)] flex-col" onInput={() => { if (error) { setError(null); setTwin(null); } }} onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget, false); }}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <h2 className="text-lg font-semibold">Edit {`${contact.firstName} ${contact.lastName}`.trim() || 'contact'}</h2>
          <button type="button" aria-label="Close" className="btn-icon-ghost ml-auto" onClick={() => setOpen(false)}><IconClose size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <fieldset className="grid gap-3 sm:grid-cols-2"><legend className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-400">Person</legend>
            {input('firstName', 'First name')}{input('lastName', 'Last name')}
            {input('jobTitle', 'Job title')}{input('linkedinUrl', 'LinkedIn')}
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2"><legend className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-400">Reach</legend>
            <div className="sm:col-span-2">{input('email', 'Email', 'email')}</div>
            {input('phone', 'Phone', 'tel')}
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
              {input('phoneExtension', 'Ext')}
              <label className="block space-y-1.5"><span className="text-[12px] font-medium text-ink-600">Phone type</span><select name="phoneType" defaultValue={contact.phoneType || 'unknown'}>{PHONE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            </div>
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2"><legend className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-400">Firm and place</legend>
            {input('companyName', 'Firm')}{input('companyWebsite', 'Firm website')}
            {input('companyCrd', 'Firm CRD')}{input('individualCrd', 'Individual CRD')}
            {input('city', 'City')}{input('state', 'State')}
            <label className="block space-y-1.5"><span className="text-[12px] font-medium text-ink-600">Country</span><select name="country" defaultValue={contact.country || 'US'} data-autofocus={focus === 'country' ? true : undefined}>
              {contact.country && !countries.some((c) => c.code === contact.country) ? <option value={contact.country}>{contact.country} (pick a country)</option> : null}
              {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select></label>
          </fieldset>
          <fieldset><legend className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-400">Product interest</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">{products.map((p) => <label key={p.value} className="inline-flex items-center gap-1.5 text-[13px] text-ink-700"><input type="checkbox" name="productInterest" value={p.value} defaultChecked={contact.productInterest.includes(p.value)} />{p.label}</label>)}</div>
          </fieldset>
        </div>
        <div className="space-y-2 border-t border-line px-5 py-3">
          {error ? <p role="alert" className="text-[13px] text-red-700">{error}{twin ? <> <Link href={subjectHref(coldRef(twin))} className="underline">Open that contact</Link></> : null}</p> : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-[12px] text-ink-500">Only what you change is saved.</span>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            {twin ? <button type="button" className="btn-secondary" disabled={pending} onClick={(e) => submit(e.currentTarget.form!, true)}>Save anyway</button> : null}
            <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </form>
    </Modal> : null}
  </>;
}

/** Set next step (or Change): the CRM's task dialog, saving the cold contact's one next step. */
export function ColdNextStepButton({ id, today, workingDays, label = 'Set next step', className = 'btn-secondary btn-sm', initial, existing }: { id: string; today: string; workingDays: number[]; label?: string; className?: string; initial?: NextActionDraft; existing?: { label: string; dueDate: string } | null }) {
  const say = useFlash();
  return <NextActionButton personIds={[]} today={today} fos={[]} canAssign={false} label={label} className={className} icon={label === 'Change' ? 'refresh' : 'plus'} initial={initial} existing={existing} workingDays={workingDays}
    save={setNextActionAction} saveFields={{ id }} noun="next step" repeats={false} onDone={(message) => say(message)} />;
}

/** Add to campaign: cold campaigns the reader may change (S7), the result in the page's toast. */
export function AddToColdCampaign({ id, className = 'btn-secondary btn-sm' }: { id: string; className?: string }) {
  const say = useFlash();
  return <AddToCampaign personIds={[id]} audience="SANDBOX" className={className} onDone={(message) => say(message ?? 'Added.')} />;
}

/** The note composer, as on the CRM page. */
export function NoteComposer({ id }: { id: string }) {
  const say = useFlash();
  // B148, B203: a refusal goes to the page's toast like a result, so the next result replaces it and a
  // re-read page cannot take it away; what was typed stays in the box.
  return <ActionForm action={async (fd) => { const r = await addNoteAction(fd); if (r.ok) say(r.message ?? 'Note added.'); else say(r.error, 'error'); return r.ok ? { ok: true } : { ok: false, error: '' }; }} resetOnSuccess className="space-y-2 p-4">
    <input type="hidden" name="id" value={id} />
    <textarea name="body" rows={3} aria-label="Note" placeholder="What happened, what they said, what to remember" className="w-full" required />
    <div className="flex justify-end"><button type="submit" className="btn-secondary btn-sm">Add note</button></div>
  </ActionForm>;
}

/** B050: the pod picker, in the checklist, for a contact with no pod or an owner in several. */
export function PodPicker({ id, pods, current }: { id: string; pods: { id: string; name: string }[]; current: string | null }) {
  const say = useFlash();
  return <ActionForm action={async (fd) => { const r = await setPodAction(fd); if (r.ok) say(r.message ?? 'Pod set.'); return r.ok ? { ok: true } : r; }} className="flex flex-wrap items-center gap-1.5">
    <input type="hidden" name="id" value={id} />
    <select name="podId" aria-label="Pod" defaultValue={current ?? ''} className="!w-auto !py-1 text-[12.5px]" required><option value="" disabled>Choose its pod</option>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    <button type="submit" className="btn-secondary btn-sm">Set pod</button>
  </ActionForm>;
}

/**
 * Claim, with the pod to claim it into when the contact has none and the rep works in several (B050):
 * the claim needs that choice, so it is asked here rather than refused afterwards.
 */
export function ClaimWithPod({ id, pods, label = 'Claim', className = 'btn-secondary btn-sm' }: { id: string; pods: { id: string; name: string }[]; label?: string; className?: string }) {
  const say = useFlash();
  return <ActionForm action={async (fd) => { const r = await claimContactsAction(fd); if (r.ok) say(r.message ?? 'Claimed.'); return r.ok ? { ok: true } : r; }} className="inline-flex flex-wrap items-center gap-1.5">
    <input type="hidden" name="ids" value={id} />
    <select name="podId" aria-label="Pod to claim it into" defaultValue="" className="!w-auto !py-1 text-[12.5px]" required><option value="" disabled>Choose its pod</option>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    <button type="submit" className={className}>{label}</button>
  </ActionForm>;
}

/** "Fill it in": opens the first waiting post-call form, wherever it is (PLAN 4.0, 4.6). */
export function FillFormButton({ className = 'btn-secondary btn-sm' }: { className?: string }) {
  return <button type="button" className={className} onClick={() => window.dispatchEvent(new Event(OPEN_FORM_EVENT))}>Fill it in</button>;
}
