'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Modal } from '@/components/modal';
import { Notice } from '@/components/ui';
import { undoMoveAction } from '@/lib/actions/sandbox-move';

type Props = {
  itemIds: string[];
  /** "Undo" for one item, "Undo all 12" for the move (B187). */
  label?: string;
  /** What the undo does, worded by mode (B098). */
  confirm: string;
  /** The campaigns the move ended, offered back unticked (B101). */
  campaigns?: { enrollmentId: string; name: string }[];
  /** An undo left partial: Undo finishes it. */
  finishing?: boolean;
};

/**
 * Undo of a Move to CRM (4.5): the same small secondary button in the list, on the contact and on the
 * move's page (CRITIQUE 11). It always asks first (B186), says what it does by mode (B098), offers the
 * campaigns back (B101), and shows its result, partial or not, where it was pressed (B113).
 */
export function UndoMoveButton({ itemIds, label = 'Undo', confirm, campaigns = [], finishing }: Props) {
  const [open, setOpen] = useState(false);
  const [restore, setRestore] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = () => start(async () => {
    const fd = new FormData();
    for (const id of itemIds) fd.append('itemId', id);
    for (const id of restore) fd.append('restore', id);
    const r = await undoMoveAction(fd);
    setOpen(false);
    setResult({ ok: r.ok && !(r.message ?? '').startsWith('Undo incomplete'), text: r.ok ? r.message ?? 'Undone.' : r.error });
    if (r.ok) router.refresh();
  });
  return <span className="inline-flex flex-wrap items-center gap-2">
    <button type="button" className="btn-secondary btn-sm" disabled={pending || !itemIds.length} onClick={() => { setResult(null); setOpen(true); }}>{finishing ? 'Finish undo' : label}</button>
    {result ? <span role="status" className={clsx('text-[12px]', result.ok ? 'text-emerald-700' : 'text-amber-800')}>{result.text}</span> : null}
    {open ? <Modal label={finishing ? 'Finish the undo' : 'Undo the move'} onClose={() => setOpen(false)} className="max-w-md">
      <div className="space-y-4 p-5">
        <h2 className="text-base font-semibold text-ink-900">{finishing ? 'Finish the undo?' : itemIds.length > 1 ? `Undo ${itemIds.length} moves?` : 'Undo this move?'}</h2>
        <p className="text-[13px] text-ink-700">{finishing ? 'Cadence tries again to take off what is still in the CRM.' : confirm}</p>
        {!finishing && campaigns.length ? <fieldset className="space-y-1.5">
          <legend className="text-[12px] text-ink-500">The move ended {campaigns.length === 1 ? 'this campaign' : 'these campaigns'}:</legend>
          {campaigns.map((c) => <label key={c.enrollmentId} className="flex items-center gap-2 text-[13px] text-ink-800"><input type="checkbox" checked={restore.has(c.enrollmentId)} onChange={() => { const next = new Set(restore); if (next.has(c.enrollmentId)) next.delete(c.enrollmentId); else next.add(c.enrollmentId); setRestore(next); }} />Put back in {c.name}</label>)}
        </fieldset> : null}
        {!finishing ? <Notice tone="info">The contact&apos;s own next step comes back. Nothing restarts unless you tick it.</Notice> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
          <button type="button" className="btn-primary" disabled={pending} onClick={run}>{pending ? 'Undoing' : finishing ? 'Finish undo' : itemIds.length > 1 ? `Undo ${itemIds.length}` : 'Undo'}</button>
        </div>
      </div>
    </Modal> : null}
  </span>;
}
