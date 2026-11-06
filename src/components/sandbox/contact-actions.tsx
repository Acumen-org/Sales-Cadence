'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ActionButton } from '@/components/action-form';
import { ConfirmDialog, type ConfirmOptions } from '@/components/confirm-dialog';
import { assignContactsAction, claimContactsAction, eraseContactAction, optOutContactAction, removeContactsAction } from '@/lib/actions/sandbox';
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
  /** B200: a Junior FO may let go of their own contact (the server always allowed it), with no one to give it to. */
  mayRelease?: boolean;
  mayErase: boolean;
  /** The reps this reader may give the contact to (B119, B208). */
  users: (Option & { podIds?: string[] })[];
  /** The owner the page shows: an assign goes ahead only if it is still the owner (N076). */
  ownerId?: string | null;
  /** What moves with the contact, for the Assign confirm (B049): "1 next step and 1 campaign (2 steps)". */
  work?: string;
  /** Pods the reader may put the contact in, for the Move dialog's fixes (B050). */
  pods?: Option[];
  /** The confirms for Opt out, Remove and Erase, naming the person and every effect (confirm-words.ts). */
  confirms: { optOut: ConfirmOptions; remove: ConfirmOptions; erase: ConfirmOptions };
  /** Open the Move dialog at once: "Move to CRM" offered after a booked meeting (N061). */
  openMove?: boolean;
};

/** The contact page's controls: Move to CRM first once the contact is ready, then the rest. */
export function ContactActions({ id, name = 'this contact', ready, unclaimed, mayWork, mayOptOut, mayMove, mayAssign, mayRelease = false, mayErase, users, ownerId = null, work, pods = [], confirms, openMove = false }: Props) {
  const [moving, setMoving] = useState(openMove && mayMove);
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
    {mayAssign ? <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => { setTo(''); setAssigning(true); }}>Assign</button> : mayRelease ? <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => { setTo('release'); setAssigning(true); }}>Let go</button> : null}
    {mayOptOut ? <ActionButton action={optOutContactAction} payload={{ id }} confirm={confirms.optOut} refresh className="btn-ghost btn-sm">Opt out</ActionButton> : null}
    {mayMove ? <ActionButton action={removeContactsAction} payload={payload} confirm={confirms.remove} className="btn-ghost btn-sm">Remove</ActionButton> : null}
    {mayErase ? <ActionButton action={eraseContactAction} payload={{ id }} confirm={confirms.erase} className="btn-ghost btn-sm">Erase</ActionButton> : null}
    {error ? <span role="alert" className="text-[12px] text-red-700">{error}</span> : null}
    {message ? <span role="status" className="text-[12px] text-emerald-700">{message}</span> : null}
    {moving ? <MoveDialog ids={[id]} owners={users.map((u) => ({ ...u, podIds: u.podIds ?? [] }))} pods={pods} onClose={() => setMoving(false)} /> : null}
    {assigning ? <ConfirmDialog
      title={mayAssign ? `Assign ${name}` : `Let go of ${name}`}
      effects={[to === 'release' ? (work ? `It has ${work}, so it cannot be let go: give it to someone instead.` : "It goes back to its pod's Unclaimed view.") : `${target?.name ?? 'The new owner'} owns it from now${work ? `, with its ${work}` : ''}.`]}
      confirmLabel={to === 'release' ? 'Let go' : 'Assign'}
      confirmDisabled={!to || (to === 'release' && Boolean(work))}
      pending={pending}
      onCancel={() => setAssigning(false)}
      onConfirm={assign}
    >
      {mayAssign ? <label className="block text-xs text-ink-500">To<select className="mt-1 w-full" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose a rep</option><option value="release">Nobody: let it go</option>{users.filter((u) => u.id !== ownerId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label> : null}
    </ConfirmDialog> : null}
  </div>;
}
