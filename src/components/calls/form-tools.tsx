'use client';

import { ActionButton, ActionForm } from '@/components/action-form';
import { closeFormAction, handFormAction } from '@/lib/actions/call-forms';

/**
 * A leader's tools for a call form nobody can fill (N010, PLAN 4.6): hand it to another rep, or close
 * it without a form. Closing asks first, in the one ConfirmDialog, and the reason it asks for is kept.
 */
export function HandFormForm({ callId, reps }: { callId: string; reps: { id: string; name: string }[] }) {
  if (!reps.length) return null;
  return <ActionForm action={handFormAction} className="flex flex-wrap items-end gap-2">
    <input type="hidden" name="callId" value={callId} />
    <label className="block text-xs text-ink-500">Hand the form to<select name="userId" required defaultValue="" className="mt-1"><option value="" disabled>Choose a rep</option>{reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
    <button type="submit" className="btn-secondary btn-sm">Hand on</button>
  </ActionForm>;
}

export function CloseFormButton({ callId, holder }: { callId: string; holder: string }) {
  return <ActionButton
    action={closeFormAction}
    payload={{ callId }}
    className="btn-ghost btn-sm"
    refresh
    confirm={{ title: 'Close this call\'s form without one?', effects: ['The call stays, with no outcome.', `${holder} can call again.`, 'The reason is kept on the call.'], confirmLabel: 'Close without a form', reason: { label: 'Why', required: true, placeholder: 'Wrong number, nobody spoke' } }}
  >Close without a form</ActionButton>;
}
