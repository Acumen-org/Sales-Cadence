'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/modal';
import { createContactAction } from '@/lib/actions/sandbox';
import { IconPlus } from '@/components/icons';

/** Add a contact by hand. Cadence refuses one already in the CRM, in the sandbox or on the suppression list. */
export function AddContactButton({ pods }: { pods: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return <>
    <button type="button" className="btn-primary btn-sm" onClick={() => setOpen(true)}><IconPlus size={14} />Add contact</button>
    {open ? <Modal label="Add a sandbox contact" onClose={() => setOpen(false)} className="max-w-xl">
      <form className="space-y-3 p-5" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); start(async () => { const r = await createContactAction(fd); if (!r.ok) { setError(r.error); return; } setOpen(false); if (r.redirectTo) router.push(r.redirectTo); else router.refresh(); }); }}>
        <h2 className="text-base font-semibold text-ink-900">Add contact</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-ink-500">First name<input name="firstName" required className="mt-1 w-full" data-autofocus /></label>
          <label className="block text-xs text-ink-500">Last name<input name="lastName" required className="mt-1 w-full" /></label>
          <label className="block text-xs text-ink-500">Job title<input name="jobTitle" className="mt-1 w-full" /></label>
          <label className="block text-xs text-ink-500">Firm<input name="companyName" className="mt-1 w-full" /></label>
          <label className="block text-xs text-ink-500">Email<input name="email" type="email" className="mt-1 w-full" /></label>
          <label className="block text-xs text-ink-500">Firm website<input name="companyWebsite" className="mt-1 w-full" /></label>
          <label className="block text-xs text-ink-500">Phone<input name="phone" className="mt-1 w-full" /></label>
          <label className="block text-xs text-ink-500">Phone type<select name="phoneType" className="mt-1 w-full" defaultValue="direct"><option value="direct">Direct</option><option value="mobile">Mobile</option><option value="office">Office</option><option value="main">Main line</option></select></label>
          <label className="block text-xs text-ink-500">LinkedIn<input name="linkedinUrl" className="mt-1 w-full" /></label>
          <div className="grid grid-cols-2 gap-2"><label className="block text-xs text-ink-500">City<input name="city" className="mt-1 w-full" /></label><label className="block text-xs text-ink-500">State<input name="state" className="mt-1 w-full" /></label></div>
          {pods.length > 1 ? <label className="block text-xs text-ink-500">Pod<select name="podId" className="mt-1 w-full" defaultValue={pods[0].id}>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : null}
        </div>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Adding' : 'Add'}</button></div>
      </form>
    </Modal> : null}
  </>;
}
