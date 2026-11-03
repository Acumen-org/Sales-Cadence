'use client';

import { ActionForm } from '@/components/action-form';
import { assignCallRepAction, attachCallContactAction } from '@/lib/actions/call-forms';

/** Unmatched list: say which rep made the call. Their form opens if the call is recent. */
export function AssignCallRep({ callId, reps }: { callId: string; reps: { id: string; name: string }[] }) {
  return <ActionForm action={assignCallRepAction} className="flex items-center gap-1.5">
    <input type="hidden" name="callId" value={callId} />
    <select name="userId" aria-label="Rep" defaultValue="" className="!py-1 text-[13px]"><option value="" disabled>Choose rep</option>{reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
    <button type="submit" className="btn-secondary btn-sm">Give</button>
  </ActionForm>;
}

/** Unmatched list: a shared line rang several contacts; say which one it was. */
export function AttachCallContact({ callId, candidates }: { callId: string; candidates: { kind: string; id: string; name: string }[] }) {
  return <ActionForm action={attachCallContactAction} className="flex items-center gap-1.5">
    <input type="hidden" name="callId" value={callId} />
    <select name="contact" aria-label="Contact" defaultValue="" className="!py-1 text-[13px]"><option value="" disabled>Choose contact</option>{candidates.map((c) => <option key={`${c.kind}:${c.id}`} value={`${c.kind}:${c.id}`}>{c.name}{c.kind === 'sandbox' ? ' (sandbox)' : ''}</option>)}</select>
    <button type="submit" className="btn-secondary btn-sm">Attach</button>
  </ActionForm>;
}
