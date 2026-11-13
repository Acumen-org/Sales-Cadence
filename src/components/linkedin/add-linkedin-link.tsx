'use client';

import { useRouter } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { addPersonLinkedinLinkAction } from '@/lib/actions/linkedin-links';

/** Add LinkedIn link, on a CRM person's LinkedIn card: saved to the CRM and to Cadence. */
export function AddLinkedInLinkForm({ personId }: { personId: string }) {
  const router = useRouter();
  return <ActionForm action={addPersonLinkedinLinkAction} onSuccess={() => router.refresh()} className="space-y-1.5">
    <input type="hidden" name="personId" value={personId} />
    <div className="flex flex-wrap items-center gap-2">
      <input name="linkedinUrl" type="url" required aria-label="LinkedIn profile link" placeholder="https://www.linkedin.com/in/…" className="min-w-0 flex-1 !py-1 text-[13px]" />
      <button type="submit" className="btn-secondary btn-sm">Add LinkedIn link</button>
    </div>
  </ActionForm>;
}
