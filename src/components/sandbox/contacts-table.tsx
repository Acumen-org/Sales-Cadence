'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Modal } from '@/components/modal';
import { addToSandboxCampaignAction, assignContactsAction, claimContactsAction, removeContactsAction, startSandboxCampaignAction } from '@/lib/actions/sandbox';
import { undoMoveAction } from '@/lib/actions/sandbox-move';
import type { ContactRow } from '@/lib/sandbox/query';
import type { ActionResult } from '@/lib/actions/users';
import { MoveDialog } from './move-dialog';

type Option = { id: string; name: string };
type Props = {
  rows: ContactRow[];
  users: Option[];
  sequences: Option[];
  pods: Option[];
  campaigns: Option[];
  today: string;
  /** Whether this reader may change sandbox contacts at all (Biz Ops reads only). */
  mayWork: boolean;
  /** Undo per moved contact, while its one-year window is open. */
  undo: Record<string, string>;
};

/** The Contacts table: select, then claim, assign, start or add to a campaign, move to the CRM or remove. */
export function ContactsTable({ rows, users, sequences, pods, campaigns, today, mayWork, undo }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'move' | 'campaign' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const ids = [...selected];
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const run = (action: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string> = {}, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    const fd = new FormData();
    for (const id of ids) fd.append('ids', id);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    start(async () => {
      const r = await action(fd);
      setMessage({ ok: r.ok, text: r.ok ? r.message ?? 'Done.' : r.error });
      if (r.ok) { setSelected(new Set()); if (r.redirectTo) router.push(r.redirectTo); else router.refresh(); }
    });
  };
  return <div>
    {mayWork && selected.size ? <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-50/50 px-4 py-2 text-[13px]" role="toolbar" aria-label="Selected contacts">
      <span className="tabular-nums text-ink-700">{selected.size} selected</span>
      <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(claimContactsAction)}>Claim</button>
      <select aria-label="Assign to" className="!py-1 text-[13px]" defaultValue="" disabled={pending} onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) run(assignContactsAction, { userId: v === 'release' ? '' : v }); }}><option value="" disabled>Assign to</option><option value="release">Nobody (release)</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
      <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => setDialog('campaign')}>Start campaign</button>
      {campaigns.length ? <select aria-label="Add to campaign" className="!py-1 text-[13px]" defaultValue="" disabled={pending} onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) run(addToSandboxCampaignAction, { campaignId: v }); }}><option value="" disabled>Add to campaign</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select> : null}
      <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={() => setDialog('move')}>Move to CRM</button>
      <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => run(removeContactsAction, {}, `Remove ${selected.size} from the sandbox? Their details are cleared.`)}>Remove</button>
    </div> : null}
    {message ? <p role="status" className={clsx('px-4 py-2 text-[13px]', message.ok ? 'text-emerald-700' : 'text-red-700')}>{message.text}</p> : null}
    <table className="w-full table-fixed text-[13px]">
      <thead><tr className="border-b border-line text-left text-ink-500">
        {mayWork ? <th className="w-9 px-3 py-2"><input type="checkbox" aria-label="Select all" checked={all} onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} /></th> : null}
        <th className="px-3 py-2 font-normal">Name</th><th className="px-3 py-2 font-normal">Firm</th><th className="w-36 px-3 py-2 font-normal">Owner</th><th className="w-44 px-3 py-2 font-normal">Ready for CRM</th><th className="px-3 py-2 font-normal">Campaign</th><th className="px-3 py-2 font-normal">Next action</th><th className="w-24 px-3 py-2 font-normal">Last touch</th><th className="w-14 px-3 py-2 font-normal">Calls</th><th className="w-36 px-3 py-2 font-normal">Source</th>
      </tr></thead>
      <tbody className="divide-y divide-line">{rows.map((r) => <tr key={r.id} className={clsx(selected.has(r.id) && 'bg-brand-50/40')}>
        {mayWork ? <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => { const next = new Set(selected); if (next.has(r.id)) next.delete(r.id); else next.add(r.id); setSelected(next); }} /></td> : null}
        <td className="truncate px-3 py-2"><Link href={`/sandbox/${r.id}`} className="text-ink-900 hover:text-brand-700">{r.name}</Link>{r.title ? <span className="block truncate text-[12px] text-ink-500">{r.title}</span> : null}</td>
        <td className="truncate px-3 py-2 text-ink-700">{r.firm ?? '-'}</td>
        <td className="truncate px-3 py-2 text-ink-700">{r.owner ?? 'Unclaimed'}</td>
        <td className="truncate px-3 py-2">{r.status === 'MOVED' ? <span className="inline-flex items-center gap-2">{r.twentyPersonId ? <Link href={`/people/${r.twentyPersonId}`} className="text-brand-700 hover:underline">In People</Link> : 'Moved'}{undo[r.id] && mayWork ? <UndoButton itemId={undo[r.id]} /> : null}</span> : r.status !== 'ACTIVE' ? <span className="text-ink-500">{r.status === 'OPTED_OUT' ? 'Opted out' : 'Removed'}</span> : <span className={r.ready ? 'text-brand-700' : 'text-ink-600'}>{r.readyText}</span>}</td>
        <td className="truncate px-3 py-2">{r.campaign ? <Link href={`/sandbox/campaigns/${r.campaign.id}`} className="hover:text-brand-700">{r.campaign.name}</Link> : <span className="text-ink-400">-</span>}</td>
        <td className="truncate px-3 py-2 text-ink-700">{r.nextAction ?? <span className="text-ink-400">-</span>}</td>
        <td className="px-3 py-2 tabular-nums text-ink-700">{r.lastTouch ?? '-'}</td>
        <td className="px-3 py-2 tabular-nums text-ink-700">{r.calls}</td>
        <td className="truncate px-3 py-2 text-ink-500">{r.source}</td>
      </tr>)}</tbody>
    </table>
    {dialog === 'move' ? <MoveDialog ids={ids} onClose={() => setDialog(null)} /> : null}
    {dialog === 'campaign' ? <Modal label="Start a sandbox campaign" onClose={() => setDialog(null)} className="max-w-lg">
      <form className="space-y-3 p-5" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); setDialog(null); run(startSandboxCampaignAction, Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]))); }}>
        <h2 className="text-base font-semibold text-ink-900">Start a campaign with {selected.size}</h2>
        <label className="block text-xs text-ink-500">Name<input name="name" required className="mt-1 w-full" /></label>
        <label className="block text-xs text-ink-500">Sequence<select name="sequenceId" required className="mt-1 w-full" defaultValue={sequences[0]?.id}>{sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <div className="grid grid-cols-3 gap-3">
          <label className="block text-xs text-ink-500">Pod<select name="podId" required className="mt-1 w-full" defaultValue={pods[0]?.id}>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="block text-xs text-ink-500">Starts<input type="date" name="startDate" required min={today} defaultValue={today} className="mt-1 w-full" /></label>
          <label className="block text-xs text-ink-500">New a day per FO<input type="number" name="pace" min={1} max={200} defaultValue={20} className="mt-1 w-full" /></label>
        </div>
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setDialog(null)}>Cancel</button><button type="submit" className="btn-primary">Start</button></div>
      </form>
    </Modal> : null}
  </div>;
}

function UndoButton({ itemId }: { itemId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return <span><button type="button" className="text-[12px] text-ink-600 underline hover:text-ink-900" disabled={pending} onClick={() => { if (!window.confirm('Undo this move? The person is taken out of Twenty and the contact comes back to the sandbox.')) return; const fd = new FormData(); fd.set('itemId', itemId); start(async () => { const r = await undoMoveAction(fd); if (!r.ok) setError(r.error); else router.refresh(); }); }}>Undo</button>{error ? <span role="alert" className="ml-2 text-[12px] text-red-700">{error}</span> : null}</span>;
}
