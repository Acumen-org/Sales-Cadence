'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ActionButton } from '@/components/action-form';
import { assignContactsAction, claimContactsAction, eraseContactAction, optOutContactAction, removeContactsAction } from '@/lib/actions/sandbox';
import { logManualCallAction } from '@/lib/actions/call-forms';
import { MoveDialog } from './move-dialog';

type Props = {
  id: string;
  ready: boolean;
  unclaimed: boolean;
  mayWork: boolean;
  /** Opt out needs no claim: any sales user, any contact, a removed one too (PLAN 8.1, N027). */
  mayOptOut: boolean;
  mayMove: boolean;
  mayAssign: boolean;
  mayErase: boolean;
  users: { id: string; name: string }[];
};

/** The contact page's controls: Move to CRM first once the contact is ready, then the rest. */
export function ContactActions({ id, ready, unclaimed, mayWork, mayOptOut, mayMove, mayAssign, mayErase, users }: Props) {
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const payload = { ids: id };
  return <div className="flex flex-wrap items-center gap-2">
    {mayMove ? <button type="button" className={ready ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'} onClick={() => setMoving(true)}>Move to CRM</button> : null}
    {unclaimed && mayWork ? <ActionButton action={claimContactsAction} payload={payload} refresh>Claim</ActionButton> : null}
    {mayAssign ? <select aria-label="Assign to" className="!py-1 text-[13px]" defaultValue="" disabled={pending} onChange={(e) => { const v = e.target.value; e.target.value = ''; if (!v) return; const fd = new FormData(); fd.append('ids', id); fd.set('userId', v === 'release' ? '' : v); start(async () => { const r = await assignContactsAction(fd); if (!r.ok) setError(r.error); else router.refresh(); }); }}><option value="" disabled>Assign to</option><option value="release">Nobody (release)</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select> : null}
    {mayWork ? <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => { const fd = new FormData(); fd.set('sandboxContactId', id); start(async () => { const r = await logManualCallAction(fd); if (!r.ok) setError(r.error); else router.refresh(); }); }}>Log a call</button> : null}
    {mayOptOut ? <ActionButton action={optOutContactAction} payload={{ id }} confirm="Opt this person out? Cadence will not contact them again, and Bellwether shows them as opted out." refresh className="btn-ghost btn-sm">Opt out</ActionButton> : null}
    {mayMove ? <ActionButton action={removeContactsAction} payload={payload} confirm="Remove this contact from the sandbox? Their details are cleared." className="btn-ghost btn-sm">Remove</ActionButton> : null}
    {mayErase ? <ActionButton action={eraseContactAction} payload={{ id }} confirm="Erase every piece of this person's data in Cadence? It cannot be undone." className="btn-ghost btn-sm">Erase</ActionButton> : null}
    {error ? <span role="alert" className="text-[12px] text-red-700">{error}</span> : null}
    {moving ? <MoveDialog ids={[id]} onClose={() => setMoving(false)} /> : null}
  </div>;
}
