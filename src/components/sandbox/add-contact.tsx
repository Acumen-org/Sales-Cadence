'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/modal';
import { Notice } from '@/components/ui';
import { createContactAction } from '@/lib/actions/sandbox';
import { IconPlus } from '@/components/icons';
import { countryOfPhone, PHONE_COUNTRIES, PHONE_TYPE_LABELS, PHONE_TYPES } from '@/lib/sandbox/normalize';
import { COLD_OUTREACH_BASE } from '@/lib/cold-outreach-paths';

type Pod = { id: string; name: string };

/** A refusal in Add contact, with what it means for the rep (N003). */
export function refusalWords(error: string): { title: string; text: string } {
  if (/Do not contact in the CRM/.test(error)) return { title: 'Not added: Do not contact', text: `${error} Nobody may contact this person, so Cadence keeps them out of Cold outreach. If you think the CRM is wrong, ask whoever looks after the CRM.` };
  if (/already in the CRM/.test(error)) return { title: 'Not added: already in the CRM', text: `${error} Work this person in People.` };
  if (/already in Cold outreach/.test(error)) return { title: 'Not added: already here', text: error };
  if (/suppression list|asked not to be contacted/.test(error)) return { title: 'Not added: Do not contact', text: error };
  return { title: 'Not added', text: error };
}

/**
 * Add a contact by hand (PLAN 4.1). Cadence refuses one who is in the CRM, Do not contact there or
 * on the suppression list, or here already, and says why (N003); the same name at the same firm asks
 * first, naming the other contact (B139). Country is chosen, or read from a number written with +
 * (B204); the phone types are Edit's, and there is no phone type without a phone (B201). A rep in
 * several pods says which (B050). Every open starts clean: no message from last time (B201).
 */
export function AddContactButton({ pods, owns = true }: { pods: Pod[]; /** The adder owns what they add; admins' contacts wait unclaimed in the pod. */ owns?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="btn-primary btn-sm" onClick={() => setOpen(true)}><IconPlus size={14} />Add contact</button>
    {open ? <AddContactDialog pods={pods} owns={owns} onClose={() => setOpen(false)} /> : null}
  </>;
}

export function AddContactDialog({ pods, owns, onClose }: { pods: Pod[]; owns: boolean; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [twin, setTwin] = useState<{ id: string; words: string } | null>(null);
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('US');
  const [chosenCountry, setChosenCountry] = useState(false);
  const [pending, start] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return PHONE_COUNTRIES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  const submit = (addAnyway: boolean) => {
    if (!form.current) return;
    const fd = new FormData(form.current);
    if (addAnyway) fd.set('addAnyway', '1');
    start(async () => {
      const r = await createContactAction(fd);
      if (!r.ok) {
        // B139: the same name at the same firm is a question, not a dead end.
        if (r.possibleDuplicate) { setTwin({ id: r.possibleDuplicate, words: r.error }); setError(null); } else { setError(r.error); setTwin(null); }
        return;
      }
      onClose();
      router.push(r.redirectTo ?? COLD_OUTREACH_BASE);
    });
  };
  const refused = error ? refusalWords(error) : null;

  return <Modal label="Add a contact" onClose={() => { if (!pending) onClose(); }} className="max-w-xl">
    {/* B201, B203: anything typed clears the last message; it never outlives what it was about. */}
    <form ref={form} className="space-y-3 p-5" onInput={() => { setError(null); setTwin(null); }} onSubmit={(e) => { e.preventDefault(); submit(false); }}>
      <h2 className="text-base font-semibold text-ink-900">Add contact</h2>
      <p className="text-[13px] text-ink-600">{owns ? 'You own the contacts you add.' : 'Admins do not own contacts: this one waits unclaimed in its pod for a rep to claim.'}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-xs text-ink-500">First name<input name="firstName" required maxLength={100} className="mt-1 w-full" data-autofocus /></label>
        <label className="block text-xs text-ink-500">Last name<input name="lastName" required maxLength={100} className="mt-1 w-full" /></label>
        <label className="block text-xs text-ink-500">Job title<input name="jobTitle" maxLength={200} className="mt-1 w-full" /></label>
        <label className="block text-xs text-ink-500">Firm<input name="companyName" maxLength={200} className="mt-1 w-full" /></label>
        <label className="block text-xs text-ink-500">Email<input name="email" type="email" className="mt-1 w-full" /></label>
        <label className="block text-xs text-ink-500">Firm website<input name="companyWebsite" className="mt-1 w-full" /></label>
        <label className="block text-xs text-ink-500">Phone<input name="phone" type="tel" value={phone} onChange={(e) => { setPhone(e.target.value); const cc = countryOfPhone(e.target.value); if (cc && !chosenCountry) setCountry(cc); }} placeholder="+44 20 7946 0000" className="mt-1 w-full" /></label>
        <label className="block text-xs text-ink-500">Phone type
          <select name="phoneType" className="mt-1 w-full" defaultValue="direct" disabled={!phone.trim()} title={phone.trim() ? undefined : 'Enter a phone number first'}>
            {PHONE_TYPES.map((t) => <option key={t} value={t}>{PHONE_TYPE_LABELS[t]}</option>)}
          </select>
        </label>
        <label className="block text-xs text-ink-500">Country
          <select name="country" className="mt-1 w-full" value={country} onChange={(e) => { setCountry(e.target.value); setChosenCountry(true); }}>
            {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </label>
        <label className="block text-xs text-ink-500">LinkedIn<input name="linkedinUrl" placeholder="linkedin.com/in/…" className="mt-1 w-full" /></label>
        <div className="grid grid-cols-2 gap-2"><label className="block text-xs text-ink-500">City<input name="city" maxLength={100} className="mt-1 w-full" /></label><label className="block text-xs text-ink-500">State<input name="state" maxLength={100} className="mt-1 w-full" /></label></div>
        {pods.length > 1 ? <label className="block text-xs text-ink-500">Pod<select name="podId" required className="mt-1 w-full" defaultValue=""><option value="" disabled>Choose a pod</option>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : pods[0] ? <input type="hidden" name="podId" value={pods[0].id} /> : null}
      </div>
      {refused ? <Notice tone="error"><div role="alert"><div className="font-medium">{refused.title}</div><div className="mt-0.5">{refused.text}</div></div></Notice> : null}
      {twin ? <Notice tone="warn"><div role="alert" className="space-y-2">
        <div className="font-medium">Same name at the same firm</div>
        <div>{twin.words}</div>
        <div className="flex flex-wrap gap-2"><Link href={`${COLD_OUTREACH_BASE}/${twin.id}`} className="btn-secondary btn-sm" onClick={onClose}>Open that contact</Link><button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => submit(true)}>It is someone else: add anyway</button></div>
      </div></Notice> : null}
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" disabled={pending} onClick={onClose}>Cancel</button><button type="submit" className="btn-primary" disabled={pending || Boolean(twin)}>{pending ? 'Adding' : 'Add'}</button></div>
    </form>
  </Modal>;
}
