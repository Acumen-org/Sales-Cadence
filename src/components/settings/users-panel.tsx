'use client';

import { Fragment, useState, useTransition } from 'react';
import type { Role } from '@prisma/client';
import { ROLE_LABELS } from '@/lib/auth/rbac';
import { createPodAction, createUserAction, deletePodAction, restorePodAction, setUserAccessAction, updateUserAction } from '@/lib/actions/users';
import { ActionButton, ActionForm } from '@/components/action-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Avatar, Badge, Card, Count, Empty, Field, type BadgeTone } from '@/components/ui';
import { removeAccessConfirm, removePodConfirm, type LeaverHoldings } from '@/lib/confirms';

/** roleAssigned is false for someone who joined through Microsoft and has no title yet. */
export type UserRow = {
  id: string; email: string; name: string; role: Role; roleAssigned: boolean; active: boolean; podIds: string[]; openWork: number; openPodIds: string[];
  /** Everything they hold (N089): cold contacts, next steps, enrollments, call forms, their number. Null when nothing. */
  work?: LeaverHoldings | null;
  /** Their calling number, which removal lets go or moves (N107). */
  callerNumber?: string | null;
  /** How many active cold contacts they own, for the pod change (N090). */
  coldContacts?: number;
};
export type PodRow = { id: string; name: string; podOwnerValue: string; userCount: number; peopleCount: number; archived: boolean };
const ROLES: Role[] = ['JUNIOR_FO', 'SENIOR_FO', 'POD_MANAGER', 'SALES_LEADER', 'BIZ_OPS', 'ADMIN'];
const ROLE_TONE: Record<Role, BadgeTone> = { ADMIN: 'purple', SALES_LEADER: 'purple', POD_MANAGER: 'purple', SENIOR_FO: 'blue', JUNIOR_FO: 'gray', BIZ_OPS: 'sky' };

/** With Microsoft sign-in there are no passwords to set: people sign in with their work account. */
function UserFields({ user, pods, passwords }: { user?: UserRow; pods: PodRow[]; passwords: boolean }) {
  const untitled = user && !user.roleAssigned;
  const live = pods.filter((pod) => !pod.archived);
  return <div className="grid gap-4 md:grid-cols-2">
    <Field label="Name"><input name="name" required maxLength={200} defaultValue={user?.name} /></Field>
    <Field label="Email"><input name="email" type="email" required maxLength={254} defaultValue={user?.email} /></Field>
    <Field label="Role"><select name="role" required defaultValue={untitled ? '' : user?.role ?? 'JUNIOR_FO'}>{untitled ? <option value="" disabled>Choose a role</option> : null}{ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}</select></Field>
    {passwords ? <Field label={user ? 'New password (optional)' : 'Password'}><input name="password" type="password" minLength={8} required={!user} autoComplete="new-password" /></Field> : null}
    <fieldset className="rounded-xl border border-line bg-white p-4 md:col-span-2"><legend className="px-1 text-sm font-medium text-ink-700">Pods</legend><div className="flex flex-wrap gap-3">{live.map((pod) => <label key={pod.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink-900"><input type="checkbox" name="podIds" value={pod.id} defaultChecked={user?.podIds.includes(pod.id)} />{pod.name}</label>)}{!live.length ? <span className="text-sm text-ink-500">No active pods</span> : null}</div></fieldset>
    {user?.coldContacts ? <Field label={`If ${user.name} leaves a pod, their ${user.coldContacts} cold contact${user.coldContacts === 1 ? '' : 's'} there move to`} hint="Needed only when they end up in more than one pod."><select name="contactsPodId" defaultValue=""><option value="">Their only pod</option>{live.map((pod) => <option key={pod.id} value={pod.id}>{pod.name}</option>)}</select></Field> : null}
  </div>;
}

const SALES: Role[] = ['JUNIOR_FO', 'SENIOR_FO', 'POD_MANAGER', 'SALES_LEADER'];

/**
 * Remove access (PLAN 8.8, N089), in the one ConfirmDialog: everything the leaver holds is listed with
 * where it goes, and whoever takes it over is required when any of it needs a taker: their cold
 * contacts with their work, open next steps (CRM and cold), live enrollments and call forms waiting.
 * Their calling number is let go, or moved, which needs a taker too (N107). Only a sales rep in every
 * pod of their live enrollments can take over; a blocked Remove says why.
 */
function RemoveAccessDialog({ user: u, users, pods, onClose, onDone }: { user: UserRow; users: UserRow[]; pods: PodRow[]; onClose: () => void; onDone: (message: string) => void }) {
  const { needsTaker: holdsWork, ...confirm } = removeAccessConfirm(u.name, u.work ?? null);
  const [taker, setTaker] = useState('');
  const [number, setNumber] = useState<'release' | 'move'>('release');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const needsTaker = holdsWork || (number === 'move' && Boolean(u.callerNumber));
  const takers = users.filter((c) => c.active && c.id !== u.id && SALES.includes(c.role) && u.openPodIds.every((podId) => c.podIds.includes(podId)));
  const podNames = u.openPodIds.map((id) => pods.find((p) => p.id === id)?.name).filter(Boolean).join(', ');
  const blocked = !needsTaker || taker ? null : takers.length ? 'Choose who takes over to go on.' : `Nobody can take this over: it needs an active sales rep${podNames ? ` in ${podNames}` : ''}. Add one first, or move the work by hand.`;
  const confirmRemove = () => {
    const fd = new FormData();
    fd.set('userId', u.id);
    fd.set('active', 'false');
    fd.set('number', number);
    if (needsTaker && taker) fd.set('replacementId', taker);
    setError(null);
    start(async () => {
      try {
        const r = await setUserAccessAction(fd);
        if (r.ok) onDone(r.message ?? 'Access removed.');
        else setError(r.error);
      } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    });
  };
  return <ConfirmDialog {...confirm} pending={pending} error={error} confirmDisabled={Boolean(blocked)} onCancel={onClose} onConfirm={confirmRemove}>
    {u.callerNumber ? <fieldset className="space-y-1 text-sm text-ink-700"><legend className="text-xs text-ink-500">Their calling number {u.callerNumber}</legend>
      <label className="flex items-center gap-2 font-normal text-ink-700"><input type="radio" name="number" value="release" checked={number === 'release'} onChange={() => setNumber('release')} />Let it go: assign it later in Settings › Calling</label>
      <label className="flex items-center gap-2 font-normal text-ink-700"><input type="radio" name="number" value="move" checked={number === 'move'} onChange={() => setNumber('move')} />Move it to whoever takes over</label>
    </fieldset> : null}
    {needsTaker ? <Field label="Who takes over"><select name="replacementId" value={taker} onChange={(e) => setTaker(e.target.value)}><option value="">Select a sales rep</option>{takers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field> : null}
    {blocked ? <p className="text-[12.5px] text-ink-600">{blocked}</p> : null}
  </ConfirmDialog>;
}

export function UsersPanel({ users, pods, selfId, passwords = true }: { users: UserRow[]; pods: PodRow[]; selfId?: string; passwords?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [addingPod, setAddingPod] = useState(false);
  const visibleUsers = users.filter((user) => showRemoved || user.active);
  const visiblePods = pods.filter((pod) => showRemoved || !pod.archived);
  const leaver = removing ? users.find((u) => u.id === removing) ?? null : null;
  return <div className="space-y-5">
    {leaver ? <RemoveAccessDialog user={leaver} users={users} pods={pods} onClose={() => setRemoving(null)} onDone={(message) => { setRemoving(null); setRemoved(message); }} /> : null}
    <Card title="Team" actions={<><label className="flex items-center gap-2 text-sm text-ink-700"><input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />Show removed</label><button type="button" className="btn-secondary btn-sm" onClick={() => setCreating(!creating)}>{creating ? 'Close' : 'Add team member'}</button></>}>
      {removed ? <p role="status" className="border-b border-line bg-emerald-50 px-4 py-2 text-[13px] text-emerald-800">{removed}</p> : null}
      {creating ? <ActionForm action={createUserAction} onSuccess={() => setCreating(false)} className="space-y-4 border-b border-line bg-canvas p-5"><UserFields pods={pods} passwords={passwords} /><button type="submit" className="btn-primary">Add team member</button></ActionForm> : null}
      <div className="overflow-x-auto"><table className="table"><thead><tr><th>Team member</th><th>Role</th><th>Pods</th><th>Access</th><th aria-label="Actions" /></tr></thead><tbody>{visibleUsers.map((u) => <Fragment key={u.id}>
        <tr><td><div className="flex items-center gap-3"><Avatar name={u.name} shape="circle" size={32} /><div><div className="font-medium text-ink-900">{u.name}</div><div className="mt-1 text-xs text-ink-500">{u.email}</div></div></div></td><td>{u.roleAssigned ? <Badge tone={ROLE_TONE[u.role]}>{ROLE_LABELS[u.role]}</Badge> : <Badge tone="amber">No title</Badge>}</td><td>{(() => { const mine = u.podIds.map((id) => pods.find((pod) => pod.id === id)).filter((pod): pod is PodRow => Boolean(pod && !pod.archived)); return mine.length ? <div className="flex flex-wrap gap-1">{mine.map((pod) => <Badge key={pod.id} tone="gray">{pod.name}</Badge>)}</div> : <Empty />; })()}</td><td><Badge tone={u.active ? 'green' : 'gray'}>{u.active ? 'Enabled' : 'Removed'}</Badge></td><td><div className="flex justify-end gap-2"><button type="button" className="btn-ghost btn-sm" onClick={() => { setEditing(editing === u.id ? null : u.id); setRemoving(null); }}>{editing === u.id ? 'Close' : 'Edit'}</button>{u.id === selfId ? null : u.active ? <button type="button" className="btn-ghost btn-sm text-red-700" onClick={() => { setRemoving(u.id); setRemoved(null); setEditing(null); }}>Remove</button> : <ActionButton action={setUserAccessAction} payload={{ userId: u.id, active: 'true' }} className="btn-secondary btn-sm">Restore</ActionButton>}</div></td></tr>
        {editing === u.id ? <tr><td colSpan={5} className="bg-canvas"><ActionForm action={updateUserAction} onSuccess={() => setEditing(null)} className="space-y-4 p-2"><input type="hidden" name="userId" value={u.id} /><UserFields user={u} pods={pods} passwords={passwords} /><div className="flex gap-2"><button type="submit" className="btn-primary">Save changes</button><button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button></div></ActionForm></td></tr> : null}
      </Fragment>)}</tbody></table></div>
    </Card>
    <Card title="Pods" actions={<button type="button" className="btn-secondary btn-sm" onClick={() => setAddingPod(!addingPod)}>{addingPod ? 'Close' : 'Add pod'}</button>}>
      {addingPod ? <ActionForm action={createPodAction} onSuccess={() => setAddingPod(false)} className="flex flex-wrap items-end gap-3 border-b border-line bg-canvas p-4"><Field label="Pod name"><input name="name" required maxLength={120} placeholder="Pod name" /></Field><button type="submit" className="btn-primary">Add pod</button></ActionForm> : null}
      <div className="overflow-x-auto"><table className="table"><thead><tr><th>Pod</th><th className="num">People</th><th className="num">Team members</th><th>Status</th><th aria-label="Actions" /></tr></thead><tbody>{visiblePods.map((pod) => <tr key={pod.id}><td className="font-medium text-ink-900">{pod.name}</td><td className="num"><Count value={pod.peopleCount} /></td><td className="num"><Count value={pod.userCount} /></td><td><Badge tone={pod.archived ? 'gray' : 'green'}>{pod.archived ? 'Removed' : 'Available'}</Badge></td><td className="text-right">{pod.archived ? <ActionButton action={restorePodAction} payload={{ podId: pod.id }} className="btn-secondary btn-sm">Restore</ActionButton> : <ActionButton action={deletePodAction} payload={{ podId: pod.id }} className="btn-ghost btn-sm text-red-700" confirm={removePodConfirm(pod.name)}>Remove</ActionButton>}</td></tr>)}</tbody></table>{!visiblePods.length ? <div className="p-4 text-sm text-ink-500">No active pods</div> : null}</div>
    </Card>
  </div>;
}
