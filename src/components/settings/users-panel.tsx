'use client';

import { Fragment, useState } from 'react';
import type { Role } from '@prisma/client';
import { ROLE_LABELS } from '@/lib/auth/rbac';
import { createPodAction, createUserAction, deletePodAction, restorePodAction, setUserAccessAction, updateUserAction } from '@/lib/actions/users';
import { ActionButton, ActionForm } from '@/components/action-form';
import { Avatar, Badge, Card, Field } from '@/components/ui';

export type UserRow = { id: string; email: string; name: string; role: Role; active: boolean; podIds: string[]; openWork: number; openPodIds: string[] };
export type PodRow = { id: string; name: string; podOwnerValue: string; userCount: number; peopleCount: number; archived: boolean };
const ROLES: Role[] = ['JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'ADMIN'];

function UserFields({ user, pods }: { user?: UserRow; pods: PodRow[] }) {
  return <div className="grid gap-4 md:grid-cols-2">
    <Field label="Name"><input name="name" required maxLength={200} defaultValue={user?.name} /></Field>
    <Field label="Email"><input name="email" type="email" required maxLength={254} defaultValue={user?.email} /></Field>
    <Field label="Role"><select name="role" defaultValue={user?.role ?? 'JUNIOR_FO'}>{ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}</select></Field>
    <Field label={user ? 'New password (optional)' : 'Password'}><input name="password" type="password" minLength={8} required={!user} autoComplete="new-password" /></Field>
    <fieldset className="rounded-xl border border-line bg-white p-4 md:col-span-2"><legend className="px-1 text-sm font-medium text-ink-700">Pods</legend><div className="flex flex-wrap gap-3">{pods.filter((pod) => !pod.archived).map((pod) => <label key={pod.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink-900"><input type="checkbox" name="podIds" value={pod.id} defaultChecked={user?.podIds.includes(pod.id)} />{pod.name}</label>)}{!pods.some((pod) => !pod.archived) ? <span className="text-sm text-ink-500">No active pods</span> : null}</div></fieldset>
  </div>;
}

export function UsersPanel({ users, pods }: { users: UserRow[]; pods: PodRow[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [addingPod, setAddingPod] = useState(false);
  const visibleUsers = users.filter((user) => showRemoved || user.active);
  const visiblePods = pods.filter((pod) => showRemoved || !pod.archived);
  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-3"><div className="flex gap-2"><Badge tone="blue">US Central</Badge><Badge tone="gray">{users.filter((user) => user.active).length} team members</Badge></div><label className="flex items-center gap-2 text-sm text-ink-700"><input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />Show removed</label></div>
    <Card title="Team" actions={<button type="button" className="btn-primary btn-sm" onClick={() => setCreating(!creating)}>{creating ? 'Close' : 'Add team member'}</button>}>
      {creating ? <ActionForm action={createUserAction} onSuccess={() => setCreating(false)} className="space-y-4 border-b border-line bg-canvas p-5"><UserFields pods={pods} /><button type="submit" className="btn-primary">Add team member</button></ActionForm> : null}
      <div className="overflow-x-auto"><table className="table"><thead><tr><th>Team member</th><th>Role</th><th>Pods</th><th>Access</th><th aria-label="Actions" /></tr></thead><tbody>{visibleUsers.map((u) => <Fragment key={u.id}>
        <tr><td><div className="flex items-center gap-3"><Avatar name={u.name} shape="circle" size={32} /><div><div className="font-semibold text-ink-900">{u.name}</div><div className="mt-1 text-xs font-semibold text-ink-700">{u.email}</div></div></div></td><td><Badge tone={u.role === 'ADMIN' || u.role === 'SALES_LEADER' ? 'purple' : u.role === 'SENIOR_FO' ? 'blue' : 'gray'}>{ROLE_LABELS[u.role]}</Badge></td><td><div className="flex flex-wrap gap-1">{u.podIds.map((id) => pods.find((pod) => pod.id === id)).filter((pod): pod is PodRow => Boolean(pod && !pod.archived)).map((pod) => <Badge key={pod.id} tone="gray">{pod.name}</Badge>)}</div></td><td><Badge tone={u.active ? 'green' : 'gray'}>{u.active ? 'Enabled' : 'Removed'}</Badge></td><td><div className="flex justify-end gap-2"><button type="button" className="btn-ghost btn-sm" onClick={() => { setEditing(editing === u.id ? null : u.id); setRemoving(null); }}>{editing === u.id ? 'Close' : 'Edit'}</button>{u.active ? <button type="button" className="btn-ghost btn-sm text-red-700" onClick={() => { setRemoving(removing === u.id ? null : u.id); setEditing(null); }}>Remove</button> : <ActionButton action={setUserAccessAction} payload={{ userId: u.id, active: 'true' }} className="btn-secondary btn-sm">Restore</ActionButton>}</div></td></tr>
        {editing === u.id ? <tr><td colSpan={5} className="bg-canvas"><ActionForm action={updateUserAction} onSuccess={() => setEditing(null)} className="space-y-4 p-2"><input type="hidden" name="userId" value={u.id} /><UserFields user={u} pods={pods} /><div className="flex gap-2"><button type="submit" className="btn-primary">Save changes</button><button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button></div></ActionForm></td></tr> : null}
        {removing === u.id ? <tr><td colSpan={5} className="bg-canvas"><ActionForm action={setUserAccessAction} onSuccess={() => setRemoving(null)} className="space-y-3 p-2"><input type="hidden" name="userId" value={u.id} /><input type="hidden" name="active" value="false" /><div className="font-semibold text-ink-900">Remove access for {u.name}?</div>{u.openWork ? <Field label={`Transfer ${u.openWork} live enrollment${u.openWork === 1 ? '' : 's'} to`}><select name="replacementId" required><option value="">Select team member</option>{users.filter((candidate) => candidate.active && candidate.id !== u.id && u.openPodIds.every((podId) => candidate.podIds.includes(podId))).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></Field> : null}<div className="flex gap-2"><button type="submit" className="btn-danger">Remove access</button><button type="button" className="btn-secondary" onClick={() => setRemoving(null)}>Cancel</button></div></ActionForm></td></tr> : null}
      </Fragment>)}</tbody></table></div>
    </Card>
    <Card title="Pods" actions={<button type="button" className="btn-secondary btn-sm" onClick={() => setAddingPod(!addingPod)}>{addingPod ? 'Close' : 'Add pod'}</button>}>
      {addingPod ? <ActionForm action={createPodAction} onSuccess={() => setAddingPod(false)} className="flex flex-wrap items-end gap-3 border-b border-line bg-canvas p-4"><Field label="Pod name"><input name="name" required maxLength={120} placeholder="Pod name" /></Field><button type="submit" className="btn-primary">Add pod</button></ActionForm> : null}
      <div className="overflow-x-auto"><table className="table"><thead><tr><th>Pod</th><th>Contacts</th><th>Team members</th><th>Status</th><th aria-label="Actions" /></tr></thead><tbody>{visiblePods.map((pod) => <tr key={pod.id}><td className="font-semibold text-ink-900">{pod.name}</td><td className="font-bold text-ink-900">{pod.peopleCount}</td><td className="font-bold text-ink-900">{pod.userCount}</td><td><Badge tone={pod.archived ? 'gray' : 'green'}>{pod.archived ? 'Removed' : 'Available'}</Badge></td><td className="text-right">{pod.archived ? <ActionButton action={restorePodAction} payload={{ podId: pod.id }} className="btn-secondary btn-sm">Restore</ActionButton> : <ActionButton action={deletePodAction} payload={{ podId: pod.id }} className="btn-ghost btn-sm text-red-700" confirm={`Remove ${pod.name}? Its history will remain available.`}>Remove</ActionButton>}</td></tr>)}</tbody></table>{!visiblePods.length ? <div className="p-4 text-sm text-ink-500">No active pods</div> : null}</div>
    </Card>
  </div>;
}
