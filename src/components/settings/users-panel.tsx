'use client';

import { Fragment, useState } from 'react';
import type { Role } from '@prisma/client';
import { ROLE_LABELS } from '@/lib/auth/rbac';
import { createPodAction, createUserAction, deletePodAction, updateUserAction } from '@/lib/actions/users';
import { syncPodsAction } from '@/lib/actions/admin';
import { ActionButton, ActionForm } from '@/components/action-form';
import { Badge, Card, Field } from '@/components/ui';

export type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  timezone: string;
  twentyMemberId: string | null;
  aliases: string[];
  dailyCap: number | null;
  active: boolean;
  podIds: string[];
};

export type PodRow = { id: string; name: string; podOwnerValue: string; userCount: number; peopleCount: number; discovered: boolean };
export type MemberOption = { id: string; label: string };

const ROLES: Role[] = ['ADMIN', 'SENIOR_FO', 'JUNIOR_FO'];

function UserFields({ user, pods, members }: { user?: UserRow; pods: PodRow[]; members: MemberOption[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {!user ? (
        <Field label="Email">
          <input name="email" type="email" required className="w-full" />
        </Field>
      ) : null}
      <Field label="Name">
        <input name="name" required defaultValue={user?.name} className="w-full" />
      </Field>
      <Field label="Role">
        <select name="role" defaultValue={user?.role ?? 'JUNIOR_FO'} className="w-full">
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Timezone" hint="IANA name, e.g. Europe/London">
        <input name="timezone" defaultValue={user?.timezone ?? 'Europe/London'} className="w-full" />
      </Field>
      <Field label="Twenty workspace member" hint="Outbound emails and calls by this member complete this user's tasks.">
        {members.length ? (
          <select name="twentyMemberId" defaultValue={user?.twentyMemberId ?? ''} className="w-full">
            <option value="">Not mapped</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <input name="twentyMemberId" defaultValue={user?.twentyMemberId ?? ''} className="w-full" placeholder="workspaceMember id" />
        )}
      </Field>
      <Field label="Aliases" hint="Comma separated handles that appear in note titles, e.g. tw_alisa">
        <input name="aliases" defaultValue={user?.aliases.join(', ')} className="w-full" />
      </Field>
      <Field label="Daily cap override" hint="Blank = global setting">
        <input name="dailyCap" type="number" min={1} defaultValue={user?.dailyCap ?? ''} className="w-full" />
      </Field>
      <Field label={user ? 'New password (leave blank to keep)' : 'Password'}>
        <input name="password" type="password" minLength={user ? undefined : 8} required={!user} className="w-full" autoComplete="new-password" />
      </Field>
      <div className="md:col-span-2">
        <label className="mb-1 block">Pods</label>
        <div className="flex flex-wrap gap-3">
          {pods.map((p) => (
            <label key={p.id} className="inline-flex items-center gap-1.5 text-sm font-normal text-slate-700">
              <input type="checkbox" name="podIds" value={p.id} defaultChecked={user?.podIds.includes(p.id)} className="h-4 w-4 rounded" />
              {p.name}
            </label>
          ))}
          {pods.length === 0 ? <span className="text-xs text-slate-500">No pods yet.</span> : null}
        </div>
      </div>
      {user ? (
        <label className="inline-flex items-center gap-1.5 text-sm font-normal text-slate-700">
          <input type="checkbox" name="active" defaultChecked={user.active} className="h-4 w-4 rounded" /> Active
        </label>
      ) : null}
    </div>
  );
}

export function UsersPanel({ users, pods, members }: { users: UserRow[]; pods: PodRow[]; members: MemberOption[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const podName = (id: string) => pods.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <Card
        title="Users and roles"
        actions={
          <button type="button" className="btn-primary btn-sm" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Close' : 'Add user'}
          </button>
        }
      >
        {creating ? (
          <div className="border-b border-slate-100 bg-slate-50 p-4">
            <ActionForm action={createUserAction} resetOnSuccess onSuccess={() => setCreating(false)}>
              <UserFields pods={pods} members={members} />
              <div className="mt-3">
                <button type="submit" className="btn-primary">
                  Create user
                </button>
              </div>
            </ActionForm>
          </div>
        ) : null}
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Pods</th>
              <th>Twenty member</th>
              <th>Cap</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <Fragment key={u.id}>
                <tr>
                  <td>
                    <div className="font-medium text-slate-900">{u.name}</div>
                    <div className="text-xs text-slate-500">{u.email}</div>
                  </td>
                  <td>
                    <Badge tone={u.role === 'ADMIN' ? 'purple' : u.role === 'SENIOR_FO' ? 'blue' : 'gray'}>{ROLE_LABELS[u.role]}</Badge>
                  </td>
                  <td>{u.podIds.map(podName).join(', ') || <span className="text-slate-400">-</span>}</td>
                  <td className="text-xs">
                    {u.twentyMemberId ? members.find((m) => m.id === u.twentyMemberId)?.label ?? u.twentyMemberId : <span className="text-slate-400">not mapped</span>}
                    {u.aliases.length ? <div className="text-slate-400">{u.aliases.join(', ')}</div> : null}
                  </td>
                  <td>{u.dailyCap ?? <span className="text-slate-400">global</span>}</td>
                  <td>{u.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Inactive</Badge>}</td>
                  <td className="text-right">
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(editing === u.id ? null : u.id)}>
                      {editing === u.id ? 'Close' : 'Edit'}
                    </button>
                  </td>
                </tr>
                {editing === u.id ? (
                  <tr>
                    <td colSpan={7} className="bg-slate-50">
                      <ActionForm action={updateUserAction} onSuccess={() => setEditing(null)}>
                        <input type="hidden" name="userId" value={u.id} />
                        <UserFields user={u} pods={pods} members={members} />
                        <div className="mt-3 flex gap-2">
                          <button type="submit" className="btn-primary">
                            Save
                          </button>
                          <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </div>
                      </ActionForm>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Pods"
        actions={
          <ActionButton action={() => syncPodsAction()} payload={{}} className="btn-secondary btn-sm" title="Create or rename pods from the podOwner options in Twenty">
            Sync pods from Twenty
          </ActionButton>
        }
      >
        <div className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">
          Which pod a person belongs to comes from Twenty (the podOwner field). New values create pods automatically; option labels renamed in Twenty rename the pod here. Which FOs work a pod is set on each user above.
        </div>
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <div>
            <table className="table">
              <thead>
                <tr>
                  <th>Pod</th>
                  <th>Twenty podOwner value</th>
                  <th>People</th>
                  <th>FOs</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pods.map((p) => (
                  <tr key={p.id}>
                    <td className="font-medium">
                      {p.name}
                      {p.discovered ? <Badge tone="amber" className="ml-2">discovered from Twenty</Badge> : null}
                      {p.userCount === 0 ? <Badge tone="red" className="ml-2">no FOs</Badge> : null}
                    </td>
                    <td>
                      <code className="text-xs">{p.podOwnerValue}</code>
                    </td>
                    <td>{p.peopleCount}</td>
                    <td>{p.userCount}</td>
                    <td className="text-right">
                      <ActionButton action={deletePodAction} payload={{ podId: p.id }} className="btn-ghost btn-sm text-red-600" confirm={`Delete pod ${p.name}?`}>
                        Delete
                      </ActionButton>
                    </td>
                  </tr>
                ))}
                {pods.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-slate-500">
                      No pods yet. Click &quot;Sync pods from Twenty&quot;, or add one per podOwner value used in Twenty.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <ActionForm action={createPodAction} resetOnSuccess className="space-y-3">
            <Field label="Pod name">
              <input name="name" required className="w-full" placeholder="Pod Alisa" />
            </Field>
            <Field label="Twenty podOwner value" hint="Exactly as the select option is stored in Twenty (e.g. Alisa).">
              <input name="podOwnerValue" required className="w-full" placeholder="Alisa" />
            </Field>
            <button type="submit" className="btn-secondary">
              Add pod
            </button>
          </ActionForm>
        </div>
      </Card>
    </div>
  );
}
