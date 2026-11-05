'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ActionButton } from '@/components/action-form';
import { Modal } from '@/components/modal';
import { assignContactsAction, claimContactsAction, eraseContactAction, optOutContactAction, removeContactsAction } from '@/lib/actions/sandbox';
import { logManualCallAction } from '@/lib/actions/call-forms';
import { MoveDialog } from './move-dialog';

type Option = { id: string; name: string };
type Props = {
  id: string;
  name?: string;
  /** D3: green "Ready to move" (complete details and a positive outcome): Move is the main button. */
  ready: boolean;
  unclaimed: boolean;
  mayWork: boolean;
  /** Opt out needs no claim: any sales user, any contact, a removed one too (PLAN 8.1, N027). */
  mayOptOut: boolean;
  mayMove: boolean;
  mayAssign: boolean;
  mayErase: boolean;
  /** The reps this reader may give the contact to (B119, B208). */
  users: (Option & { podIds?: string[] })[];
  /** The owner the page shows: an assign goes ahead only if it is still the owner (N076). */
  ownerId?: string | null;
  /** What moves with the contact, for the Assign confirm (B049): "1 next step and 1 campaign (2 steps)". */
  work?: string;
  /** Pods the reader may put the contact in, for the Move dialog's fixes (B050). */
  pods?: Option[];
};

/** The contact page's controls: Move to CRM first once the contact is ready, then the rest. */
export function ContactActions({ id, name = 'this contact', ready, unclaimed, mayWork, mayOptOut, mayMove, mayAssign, mayErase, users, ownerId = null, work, pods = [] }: Props) {
  const [moving, setMoving] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const payload = { ids: id };
  const target = users.find((u) => u.id === to);
  const assign = () => {
    const fd = new FormData();
    fd.append('ids', id);
    fd.set('userId', to === 'release' ? '' : to);
    fd.set(`owner:${id}`, ownerId ?? '');
    setAssigning(false);
    start(async () => { const r = await assignContactsAction(fd); if (!r.ok) { setError(r.error); setMessage(null); } else { setError(null); setMessage(r.message ?? 'Done.'); router.refresh(); } });
  };
  return <div className="flex flex-wrap items-center gap-2">
    {mayMove ? <button type="button" className={ready ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'} onClick={() => setMoving(true)}>Move to CRM</button> : null}
    {unclaimed && mayWork ? <ActionButton action={claimContactsAction} payload={payload} refresh>Claim</ActionButton> : null}
    {mayAssign ? <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => { setTo(''); setAssigning(true); }}>Assign</button> : null}
    {mayWork ? <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => { const fd = new FormData(); fd.set('sandboxContactId', id); start(async () => { const r = await logManualCallAction(fd); if (!r.ok) setError(r.error); else router.refresh(); }); }}>Log a call</button> : null}
    {mayOptOut ? <ActionButton action={optOutContactAction} payload={{ id }} confirm="Opt this person out? Cadence will not contact them again, and Bellwether shows them as opted out." refresh className="btn-ghost btn-sm">Opt out</ActionButton> : null}
    {mayMove ? <ActionButton action={removeContactsAction} payload={payload} confirm="Remove this contact from Cold outreach? Their details are cleared." className="btn-ghost btn-sm">Remove</ActionButton> : null}
    {mayErase ? <ActionButton action={eraseContactAction} payload={{ id }} confirm="Erase every piece of this person's data in Cadence? It cannot be undone." className="btn-ghost btn-sm">Erase</ActionButton> : null}
    {error ? <span role="alert" className="text-[12px] text-red-700">{error}</span> : null}
    {message ? <span role="status" className="text-[12px] text-emerald-700">{message}</span> : null}
    {moving ? <MoveDialog ids={[id]} owners={users.map((u) => ({ ...u, podIds: u.podIds ?? [] }))} pods={pods} onClose={() => setMoving(false)} /> : null}
    {assigning ? <Modal label="Assign the contact" onClose={() => setAssigning(false)} className="max-w-md">
      <div className="space-y-4 p-5">
        <h2 className="text-base font-semibold text-ink-900">Assign {name}</h2>
        <label className="block text-xs text-ink-500">To<select className="mt-1 w-full" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose a rep</option><option value="release">Nobody: let it go</option>{users.filter((u) => u.id !== ownerId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <p className="text-[13px] text-ink-700">{to === 'release' ? (work ? `It has ${work}, so it cannot be let go: give it to someone instead.` : 'It goes back to its pod\'s Unclaimed view.') : `${target?.name ?? 'The new owner'} owns it from now${work ? `, with its ${work}` : ''}.`}</p>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setAssigning(false)}>Cancel</button><button type="button" className="btn-primary" disabled={!to || pending || (to === 'release' && Boolean(work))} onClick={assign}>{to === 'release' ? 'Let go' : 'Assign'}</button></div>
      </div>
    </Modal> : null}
  </div>;
}
