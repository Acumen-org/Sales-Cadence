import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { formatInstant } from '@/lib/dates';
import { loadMovePage } from '@/lib/sandbox/moves-query';
import { ActionButton } from '@/components/action-form';
import { AutoRefresh } from '@/components/sandbox/auto-refresh';
import { UndoMoveButton } from '@/components/sandbox/move-undo';
import { Badge, EmptyState, Notice, RecordHeader, Stat, Surface, ViewHeader } from '@/components/ui';
import { retryMoveAction } from '@/lib/actions/sandbox-move';
import { COLD_CONTACT_BASE, COLD_MOVES_HREF } from '@/lib/subject';

export const metadata = { title: 'Move to CRM · Cold outreach' };

/**
 * One Move to CRM (4.5): a breadcrumb back, the counts and a progress bar, every contact by name with
 * what happened in plain words (B100, B109), a fix button for each failure (B036), Retry only where
 * it can help and only for whoever may undo (B105, B188), "Undo until" with the year from each
 * item's own deadline (N062), Undo all (B187), and what the queue left out (B186).
 */
export default async function MovePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const move = await loadMovePage(id, toActor(user));
  if (!move) notFound();
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    {!move.settled ? <AutoRefresh /> : null}
    <div className="text-[12px] text-ink-500"><Link href={COLD_CONTACT_BASE} className="hover:text-ink-700">Cold outreach</Link> › <Link href={COLD_MOVES_HREF} className="hover:text-ink-700">Moves to CRM</Link></div>
    <RecordHeader
      name={`Move to CRM · ${n(move.count, 'contact')}`}
      sub={`${move.moverName} · ${formatInstant(move.createdAt, user.timezone)}`}
      badges={<Badge tone={move.settled ? (move.counts.failed ? 'amber' : 'green') : 'blue'}>{move.settled ? (move.counts.failed ? `${move.counts.failed} failed` : 'Finished') : 'Moving…'}</Badge>}
      actions={<>
        {move.retryable ? <ActionButton action={retryMoveAction} payload={{ moveId: move.id }} refresh>{`Retry ${move.retryable} failed`}</ActionButton> : null}
        {move.undoAll.length > 1 ? <UndoMoveButton itemIds={move.undoAll} label={`Undo all ${move.undoAll.length}`} confirm={`Each person this move created is deleted from the CRM; each person it added history to stays there, without that history. The ${move.undoAll.length} contacts come back to Cold outreach.`} /> : null}
      </>}
    />
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="In the CRM" value={move.counts.done} tone="good" />
      <Stat label="Waiting or moving" value={move.counts.waiting} />
      <Stat label="Failed" value={move.counts.failed} tone="warn" />
      <Stat label="Undone" value={move.counts.undone} />
    </div>
    <div aria-label={`${move.progress}% finished`} role="progressbar" aria-valuenow={move.progress} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full bg-brand-600" style={{ width: `${move.progress}%` }} /></div>
    {move.leftOut.length ? <Notice tone="warn">Left out of this move: {move.leftOut.map((l) => `${l.name} (${l.reason})`).join('; ')}.</Notice> : null}
    <Surface flush>
      <ViewHeader title="Contacts" meta={<span className="text-ink-500">by name</span>} />
      {move.rows.length ? <table className="w-full text-[13px]"><thead><tr className="border-b border-line text-left text-ink-500"><th className="px-4 py-2 font-normal">Contact</th><th className="px-4 py-2 font-normal">State</th><th className="px-4 py-2 font-normal">In the CRM</th><th className="px-4 py-2 font-normal">What happened</th><th className="px-4 py-2 font-normal">Undo until</th><th className="px-4 py-2 font-normal" /></tr></thead>
        <tbody className="divide-y divide-line">{move.rows.map((r) => <tr key={r.itemId} className="align-top">
          <td className="px-4 py-2"><Link href={r.href} className="text-ink-900 hover:text-brand-700">{r.name}</Link></td>
          <td className="px-4 py-2"><Badge tone={r.tone}>{r.stateLabel}</Badge></td>
          <td className="px-4 py-2 text-ink-600">{r.personName ? <span>{r.mode === 'attach' ? `History added to ${r.personName}` : r.personName}</span> : null}{r.firm ? <span className="block text-[12px] text-ink-500">{r.firm}</span> : null}</td>
          <td className="px-4 py-2 text-ink-700">{r.detail}{r.fix ? <> <Link href={r.fix.href} className="btn-secondary btn-sm ml-1 inline-flex">{r.fix.label}</Link></> : null}</td>
          <td className="px-4 py-2 tabular-nums text-ink-600">{r.undoUntil ?? '-'}</td>
          <td className="px-4 py-2 text-right">{r.canUndo ? <UndoMoveButton itemIds={[r.itemId]} confirm={r.undoConfirm} campaigns={r.campaigns} finishing={r.state === 'UNDO_PARTIAL'} /> : null}</td>
        </tr>)}</tbody></table> : <EmptyState title="Nothing in this move" />}
    </Surface>
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
