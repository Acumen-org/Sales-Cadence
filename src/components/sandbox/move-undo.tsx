'use client';

import { useState, useTransition } from 'react';
import clsx from 'clsx';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useFlash } from '@/components/flash';
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
  const say = useFlash();
  const run = () => start(async () => {
    const fd = new FormData();
    for (const id of itemIds) fd.append('itemId', id);
    for (const id of restore) fd.append('restore', id);
    const r = await undoMoveAction(fd);
    setOpen(false);
    const ok = r.ok && !(r.message ?? '').startsWith('Undo incomplete');
    const text = r.ok ? r.message ?? 'Undone.' : r.error;
    // B186: an undo that worked takes this button off the page as it re-reads, so its result goes to
    // the page's toast (which a re-read keeps); a refusal stays beside the button too.
    if (r.ok) say(text, ok ? 'ok' : 'error');
    else setResult({ ok: false, text });
  });
  return <span className="inline-flex flex-wrap items-center gap-2">
    <button type="button" className="btn-secondary btn-sm" disabled={pending || !itemIds.length} onClick={() => { setResult(null); setOpen(true); }}>{finishing ? 'Finish undo' : label}</button>
    {result ? <span role="status" className={clsx('text-[12px]', result.ok ? 'text-emerald-700' : 'text-amber-800')}>{result.text}</span> : null}
    {open ? <ConfirmDialog
      title={finishing ? 'Finish the undo?' : itemIds.length > 1 ? `Undo ${itemIds.length} moves?` : 'Undo this move?'}
      body={finishing ? 'Cadence tries again to take off what is still in the CRM.' : confirm}
      confirmLabel={finishing ? 'Finish undo' : itemIds.length > 1 ? `Undo ${itemIds.length}` : 'Undo'}
      pending={pending}
      onCancel={() => setOpen(false)}
      onConfirm={run}
    >
      {!finishing && campaigns.length ? <fieldset className="space-y-1.5">
        <legend className="text-[12px] text-ink-500">The move ended {campaigns.length === 1 ? 'this campaign' : 'these campaigns'}:</legend>
        {campaigns.map((c) => <label key={c.enrollmentId} className="flex items-center gap-2 text-[13px] text-ink-800"><input type="checkbox" checked={restore.has(c.enrollmentId)} onChange={() => { const next = new Set(restore); if (next.has(c.enrollmentId)) next.delete(c.enrollmentId); else next.add(c.enrollmentId); setRestore(next); }} />Put back in {c.name}</label>)}
      </fieldset> : null}
      {!finishing ? <Notice tone="info">The contact&apos;s own next step comes back. Nothing restarts unless you tick it.</Notice> : null}
    </ConfirmDialog> : null}
  </span>;
}
