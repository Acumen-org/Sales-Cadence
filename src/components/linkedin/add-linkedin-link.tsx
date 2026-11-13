'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { Modal } from '@/components/modal';
import { IconLinkedin, IconPlus } from '@/components/icons';
import { addPersonLinkedinLinkAction } from '@/lib/actions/linkedin-links';

/** Add LinkedIn link, on a CRM person's LinkedIn card: saved to the CRM and to Cadence. */
export function AddLinkedInLinkForm({ personId, onDone }: { personId: string; onDone?: () => void }) {
  const router = useRouter();
  return <ActionForm action={addPersonLinkedinLinkAction} onSuccess={() => { onDone?.(); router.refresh(); }} className="space-y-1.5">
    <input type="hidden" name="personId" value={personId} />
    <div className="flex flex-wrap items-center gap-2">
      <input name="linkedinUrl" type="url" required data-autofocus aria-label="LinkedIn profile link" placeholder="https://www.linkedin.com/in/…" className="min-w-0 flex-1 !py-1 text-[13px]" />
      <button type="submit" className="btn-secondary btn-sm">Add LinkedIn link</button>
    </div>
  </ActionForm>;
}

/**
 * "Add LinkedIn" in the person's header, where Email, Call and LinkedIn are (owner, 13 Nov 2026):
 * a person with no profile link gets it added from the top of the page, not from a card below.
 */
export function AddLinkedInButton({ personId, name }: { personId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="btn-secondary btn-sm border-dashed" onClick={() => setOpen(true)}><IconPlus size={13} /><IconLinkedin size={13} /> Add LinkedIn</button>
    {open ? <Modal label={`Add ${name}'s LinkedIn`} onClose={() => setOpen(false)} className="max-w-md">
      <div className="space-y-3 p-5">
        <h2 className="text-base font-semibold text-ink-900">Add {name}&apos;s LinkedIn</h2>
        <p className="text-[13px] text-ink-600">Paste their profile link. It is saved to the CRM, and Cadence matches LinkedIn activity to them from now on.</p>
        <AddLinkedInLinkForm personId={personId} onDone={() => setOpen(false)} />
        <div className="flex justify-end"><button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button></div>
      </div>
    </Modal> : null}
  </>;
}
