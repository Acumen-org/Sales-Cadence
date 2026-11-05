'use client';

import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Notice } from '@/components/ui';
import { reassignStrandedNextActionsAction } from '@/lib/actions/sandbox';
import type { Stranded } from '@/lib/outreach/ownership';

const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/**
 * "Needs a new owner" (PLAN 8.8; N033, N034, N035): work whose owner's access was removed, for the
 * leaders of its pods. Contacts open in the list's Needs a new owner view, where Assign moves them
 * with their work; a removed rep's open next steps, CRM ones included, go to a rep in one step.
 */
export function NeedsNewOwner({ stranded, owners }: { stranded: Stranded[]; owners: { id: string; name: string }[] }) {
  return <Notice tone="warn">
    <div className="space-y-2">
      <div className="font-medium">Needs a new owner</div>
      {stranded.map((s) => <div key={s.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{s.name} no longer has access: {[s.contacts ? n(s.contacts, 'cold contact') : null, s.nextSteps ? n(s.nextSteps, 'open next step') : null, s.forms ? `${n(s.forms, 'call form')} waiting` : null].filter(Boolean).join(', ')}.</span>
        {s.contacts ? <Link href="/sandbox?owner=needs_owner" className="underline">Assign the contacts</Link> : null}
        {s.nextSteps && owners.length ? <ActionForm action={reassignStrandedNextActionsAction} className="flex items-center gap-1.5">
          <input type="hidden" name="fromUserId" value={s.userId} />
          <select name="toUserId" required aria-label={`Give ${s.name}'s next steps to`} className="!py-0.5 text-[12px]" defaultValue=""><option value="" disabled>Give the next steps to</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          <button type="submit" className="btn-secondary btn-sm">Give</button>
        </ActionForm> : null}
        {s.forms ? <span className="text-[12px]">Hand on or close each waiting form: {s.formCallIds.map((id, i) => <span key={id}>{i ? ', ' : ''}<Link href={`/calls/${id}`} className="underline">{`call ${i + 1}`}</Link></span>)}{s.forms > s.formCallIds.length ? ` and ${s.forms - s.formCallIds.length} more` : ''}.</span> : null}
      </div>)}
    </div>
  </Notice>;
}
