'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Badge } from '@/components/ui';
import { assignContactsAction, claimContactsAction, removeContactsAction } from '@/lib/actions/sandbox';
import { AddToCampaign } from '@/components/campaigns/add-to-campaign';
import { campaignSelectionUrl } from '@/lib/campaign-selection';
import type { ContactRow } from '@/lib/sandbox/query';
import type { ContactMove } from '@/lib/sandbox/moves-query';
import type { ActionResult } from '@/lib/actions/users';
import { MoveDialog } from './move-dialog';
import { UndoMoveButton } from './move-undo';
import { ConfirmDialog, useConfirm, type ConfirmOptions } from '@/components/confirm-dialog';
import { removeConfirm } from '@/lib/outreach/confirm-words';

type Option = { id: string; name: string };
type Props = {
  rows: ContactRow[];
  /** Who this reader may give contacts to: active sales reps of their pods (B119, B208). Empty: no Assign. */
  owners: (Option & { podIds: string[] })[];
  pods: Option[];
  /** Whether this reader may change cold contacts at all (Biz Ops reads only). */
  mayWork: boolean;
  /** Each row's latest move: Undo where this reader may (B106), a failure with its fix (B036), Moving. */
  moves: Record<string, ContactMove>;
};

/**
 * The Contacts table: select, then claim, assign, start or add to a campaign, move to the CRM or
 * remove. A campaign is started in the campaign studio and added to through the same "Add to
 * campaign" as People, both for cold campaigns only (B133, B044).
 */
export function ContactsTable({ rows, owners, pods, mayWork, moves }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'move' | 'assign' | null>(null);
  const [assignTo, setAssignTo] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const [ask, confirmDialog] = useConfirm();
  const ids = [...selected];
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const run = async (action: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string> = {}, confirm?: ConfirmOptions) => {
    const answer = confirm ? await ask(confirm) : null;
    if (confirm && !answer) return;
    const fd = new FormData();
    if (answer?.reason) fd.set('reason', answer.reason);
    for (const id of ids) fd.append('ids', id);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    start(async () => {
      const r = await action(fd);
      setMessage({ ok: r.ok, text: r.ok ? r.message ?? 'Done.' : r.error });
      if (r.ok) { setSelected(new Set()); if (r.redirectTo) router.push(r.redirectTo); else router.refresh(); }
    });
  };
  // N076: each contact goes only if its owner is still the one shown here.
  const seenOwners = Object.fromEntries(ids.map((id) => [`owner:${id}`, rows.find((r) => r.id === id)?.ownerId ?? '']));
  const target = owners.find((o) => o.id === assignTo);
  return <div>
    {confirmDialog}
    {mayWork && selected.size ? <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-50/50 px-4 py-2 text-[13px]" role="toolbar" aria-label="Selected contacts">
      <span className="tabular-nums text-ink-700">{selected.size} selected</span>
      <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(claimContactsAction)}>Claim</button>
      {owners.length ? <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => { setAssignTo(''); setDialog('assign'); }}>Assign</button> : null}
      <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => { try { router.push(campaignSelectionUrl('/campaigns/new', ids, { audience: 'cold' })); } catch { setMessage({ ok: false, text: 'Your browser could not keep this selection. Open New campaign from Campaigns and choose the contacts there.' }); } }}>Start campaign</button>
      <AddToCampaign personIds={ids} audience="SANDBOX" className="btn-secondary btn-sm" onDone={(m) => { setSelected(new Set()); if (m) setMessage({ ok: true, text: m }); }} />
      <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={() => setDialog('move')}>Move to CRM</button>
      <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => run(removeContactsAction, {}, removeConfirm(selected.size))}>Remove</button>
    </div> : null}
    {message ? <p role="status" className={clsx('px-4 py-2 text-[13px]', message.ok ? 'text-emerald-700' : 'text-red-700')}>{message.text}</p> : null}
    <table className="w-full table-fixed text-[13px]">
      <thead><tr className="border-b border-line text-left text-ink-500">
        {mayWork ? <th className="w-9 px-3 py-2"><input type="checkbox" aria-label="Select all" checked={all} onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} /></th> : null}
        <th className="px-3 py-2 font-normal">Name</th><th className="px-3 py-2 font-normal">Firm</th><th className="w-36 px-3 py-2 font-normal">Owner</th><th className="w-48 px-3 py-2 font-normal">Status</th><th className="px-3 py-2 font-normal">Campaign</th><th className="px-3 py-2 font-normal">Next action</th><th className="w-24 px-3 py-2 font-normal">Last touch</th><th className="w-14 px-3 py-2 font-normal">Calls</th><th className="w-36 px-3 py-2 font-normal">Source</th>
      </tr></thead>
      <tbody className="divide-y divide-line">{rows.map((r) => {
        const m = moves[r.id];
        return <tr key={r.id} className={clsx(selected.has(r.id) && 'bg-brand-50/40')}>
          {mayWork ? <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => { const next = new Set(selected); if (next.has(r.id)) next.delete(r.id); else next.add(r.id); setSelected(next); }} /></td> : null}
          <td className="truncate px-3 py-2"><Link href={`/sandbox/${r.id}`} className="text-ink-900 hover:text-brand-700">{r.name}</Link>{r.title ? <span className="block truncate text-[12px] text-ink-500">{r.title}</span> : null}</td>
          <td className="truncate px-3 py-2 text-ink-700">{r.firm ?? '-'}</td>
          <td className={clsx('truncate px-3 py-2', r.ownerRemoved ? 'text-amber-800' : 'text-ink-700')}>{r.owner ?? 'Unclaimed'}</td>
          <td className="px-3 py-2"><StatusCell row={r} move={m} />{r.warning ? <Badge tone="amber" className="ml-1.5">{r.warning}</Badge> : null}</td>
          <td className="truncate px-3 py-2">{r.campaign ? <><Link href={`/campaigns/${r.campaign.id}`} className="hover:text-brand-700">{r.campaign.name}</Link>{r.campaign.startsOn ? <span className="block truncate text-[12px] text-ink-500">Starts {r.campaign.startsOn}</span> : null}</> : <span className="text-ink-400">-</span>}</td>
          <td className="truncate px-3 py-2 text-ink-700">{r.nextAction ?? <span className="text-ink-400">-</span>}</td>
          <td className="px-3 py-2 tabular-nums text-ink-700">{r.lastTouch ?? '-'}</td>
          <td className="px-3 py-2 tabular-nums text-ink-700">{r.calls}</td>
          <td className="truncate px-3 py-2 text-ink-500">{r.source}</td>
        </tr>;
      })}</tbody>
    </table>
    {dialog === 'move' ? <MoveDialog ids={ids} owners={owners} pods={pods} onClose={() => setDialog(null)} /> : null}
    {dialog === 'assign' ? <ConfirmDialog
      title={`Assign ${selected.size === 1 ? rows.find((r) => r.id === ids[0])?.name ?? 'this contact' : `${selected.size} contacts`}`}
      effects={[assignTo === 'release' ? 'A contact with an open next step or a running campaign is not let go: give it to someone instead.' : `Their open next steps and running campaigns go to ${target?.name ?? 'the new owner'} too.`]}
      confirmLabel={assignTo === 'release' ? 'Let go' : 'Assign'}
      confirmDisabled={!assignTo}
      pending={pending}
      onCancel={() => setDialog(null)}
      onConfirm={() => { setDialog(null); void run(assignContactsAction, { userId: assignTo === 'release' ? '' : assignTo, ...seenOwners }); }}
    >
      <label className="block text-xs text-ink-500">To<select className="mt-1 w-full" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}><option value="">Choose a rep</option><option value="release">Nobody: let {selected.size === 1 ? 'it' : 'them'} go</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
    </ConfirmDialog> : null}
  </div>;
}

/** One status per row: moved (with Undo), moving, a failed move with its fix, Also in CRM, Closed, Ready to move. */
function StatusCell({ row: r, move: m }: { row: ContactRow; move?: ContactMove }) {
  if (r.status === 'MOVED') return <span className="inline-flex flex-wrap items-center gap-2">{r.twentyPersonId ? <Link href={`/people/${r.twentyPersonId}`} className="text-brand-700 hover:underline">In CRM · Open</Link> : 'Moved'}{m?.canUndo ? <UndoMoveButton itemIds={[m.itemId]} confirm={m.undoConfirm} campaigns={m.campaigns} /> : null}</span>;
  if (r.status !== 'ACTIVE') return <span className="text-ink-500">{r.status === 'OPTED_OUT' ? 'Do not contact' : 'Removed'}</span>;
  if (m && (m.state === 'QUEUED' || m.state === 'RUNNING')) return <Badge tone="blue">Moving to CRM…</Badge>;
  if (m?.state === 'FAILED') return <span className="block text-[12px] text-red-700" title={m.error ?? undefined}>Move failed: {m.error ?? 'see the move'} <Link href={`/sandbox/moves/${m.moveId}`} className="underline">{m.failure === 'permanent' ? 'Move again' : 'Retry'}</Link></span>;
  if (r.crmMatchPersonId) return <Link href={`/people/${r.crmMatchPersonId}`} className="text-amber-700 hover:underline" title="Added to the CRM after the push; outreach stopped">Already in CRM</Link>;
  if (r.closed) return <Badge tone="gray">{r.closed}</Badge>;
  return <span className={r.ready ? 'text-emerald-700' : 'text-ink-600'}>{r.readyText}</span>;
}
