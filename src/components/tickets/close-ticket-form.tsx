'use client';

import { useState } from 'react';
import { ActionForm, ActionButton } from '@/components/action-form';
import { closeTicketAction, liftOptOutAction, raiseOptOutTicketAction } from '@/lib/actions/tickets';

/**
 * Biz Ops close an opt-out ticket with what they found (D4). Ticking "Lift the opt-out" makes the person
 * contactable again: only that opt-out's own suppression goes, nothing restarts, and it is logged.
 */
export function CloseTicketForm({ ticketId, name, mayLift }: { ticketId: string; name: string; mayLift: boolean }) {
  const [lift, setLift] = useState(false);
  return (
    <ActionForm
      action={closeTicketAction}
      className="space-y-3 p-4"
      confirm={lift ? { title: `Lift ${name}'s opt-out?`, effects: [`Cadence may contact ${name} again.`, 'Only this opt-out\'s own suppression goes; any other Do not contact stays.', 'Nothing restarts: no campaign, no next step.', 'Bellwether is told the opt-out was lifted.'], confirmLabel: 'Lift and close' } : undefined}
      onSuccess={(r) => { if (r.redirectTo) window.location.assign(r.redirectTo); }}
    >
      <input type="hidden" name="ticketId" value={ticketId} />
      <div className="space-y-1.5">
        <label htmlFor={`resolution-${ticketId}`}>What you found <span className="text-red-700">*</span></label>
        <textarea id={`resolution-${ticketId}`} name="resolution" rows={3} maxLength={1000} required />
      </div>
      {mayLift ? <label className="flex items-start gap-2 text-[13px] text-ink-800"><input type="checkbox" name="lift" value="1" checked={lift} onChange={(e) => setLift(e.target.checked)} className="mt-0.5" /><span>Lift the opt-out: it was a mistake</span></label> : <p className="text-[12.5px] text-ink-600">This opt-out was lifted already, or is no longer one from the form.</p>}
      <button type="submit" className="btn-primary">{lift ? 'Lift and close' : 'Close ticket'}</button>
    </ActionForm>
  );
}

/**
 * On a person opted out by the post-call form: anyone may ask "Think this is wrong?" (a ticket for Biz
 * Ops, with what they know); an admin may undo it at once, with no reason (D4).
 */
export function FormOptOutControls({ subject, name, mayLift, ticket }: { subject: { personId?: string; sandboxContactId?: string }; name: string; mayLift: boolean; ticket: string | null }) {
  const payload: Record<string, string> = subject.personId ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId ?? '' };
  return <span className="flex flex-wrap items-center gap-2">
    {ticket ? <span className="text-[12.5px]">{ticket}</span> : <ActionButton action={raiseOptOutTicketAction} payload={payload} className="btn-secondary btn-sm" refresh confirm={{ title: 'Think this opt-out is wrong?', body: `Biz Ops look into it and answer on the ticket. Until then ${name} stays Do not contact.`, confirmLabel: 'Raise it', reason: { label: 'What you know', required: true, placeholder: 'I picked the wrong outcome: she booked a meeting' } }}>Think this is wrong?</ActionButton>}
    {mayLift ? <ActionButton action={liftOptOutAction} payload={payload} className="btn-ghost btn-sm" refresh confirm={{ title: `Undo ${name}'s opt-out?`, effects: [`Cadence may contact ${name} again.`, 'Only this opt-out\'s own suppression goes; any other Do not contact stays.', 'Nothing restarts: no campaign, no next step.', 'Bellwether is told the opt-out was lifted.'], confirmLabel: 'Undo opt-out' }}>Undo opt-out</ActionButton> : null}
  </span>;
}
