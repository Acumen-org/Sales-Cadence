import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { formatInstant } from '@/lib/dates';
import { loadMovePage } from '@/lib/sandbox/moves-query';
import { ActionButton } from '@/components/action-form';
import { AutoRefresh } from '@/components/sandbox/auto-refresh';
import { UndoMoveButton } from '@/components/sandbox/move-undo';
import { Flash } from '@/components/flash';
import { Badge, EmptyState, Notice, RecordHeader, Surface, ViewHeader } from '@/components/ui';
import { IconArrowUp } from '@/components/icons';
import { ColdOutreachHeader } from '@/components/sandbox/section-tabs';
import { retryMoveAction } from '@/lib/actions/sandbox-move';
import { COLD_MOVES_HREF } from '@/lib/subject';

export const metadata = { title: 'Move to CRM · Cold outreach' };

/**
 * One Move to CRM (4.5): a breadcrumb back, the counts and a progress bar, every contact by name with
 * what happened in plain words (B100, B109), a fix button for each failure (B036), Retry only where
 * it can help and only for whoever may undo (B105, B188), "Undo until" with the year from each
 * item's own deadline (N062), Undo all (B187), and what the queue left out (B186).
 */
export default async function MovePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ flash?: string; flashTone?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  // B186: an Undo's result, carried on the address so the re-read page keeps it.
  const sp = (await searchParams) ?? {};
  const flash = typeof sp.flash === 'string' && sp.flash ? sp.flash.slice(0, 300) : null;
  const move = await loadMovePage(id, toActor(user));
  if (!move) notFound();
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    {!move.settled ? <AutoRefresh /> : null}
    {flash ? <Flash message={flash} tone={sp.flashTone === 'error' ? 'error' : 'ok'} /> : null}
    <ColdOutreachHeader user={user} current="moves" />
    <div className="text-[12px] text-ink-500"><Link href={COLD_MOVES_HREF} className="hover:text-ink-700">Moves to CRM</Link> › <span className="text-ink-700">{move.rows.length === 1 ? move.rows[0].name : n(move.count, 'contact')}</span></div>
    <RecordHeader
      name={move.rows.length === 1 ? `Move to CRM: ${move.rows[0].name}` : `Move to CRM · ${n(move.count, 'contact')}`}
      shape="square"
      icon={<IconArrowUp size={20} />}
      sub={`By ${move.moverName} · ${formatInstant(move.createdAt, user.timezone)}`}
      badges={<>
        {move.counts.done ? <Badge tone="green">{`${move.counts.done} in the CRM`}</Badge> : null}
        {move.counts.waiting ? <Badge tone="blue">{`${move.counts.waiting} moving`}</Badge> : null}
        {move.counts.retrying ? <Badge tone="amber">{`${move.counts.retrying} trying again`}</Badge> : null}
        {move.counts.failed - move.counts.retrying ? <Badge tone="red">{`${move.counts.failed - move.counts.retrying} failed`}</Badge> : null}
        {move.counts.undone ? <Badge tone="gray">{`${move.counts.undone} undone`}</Badge> : null}
      </>}
      actions={<>
        {move.retryable ? <ActionButton action={retryMoveAction} payload={{ moveId: move.id }} refresh>{move.counts.retrying ? 'Retry now' : `Retry ${move.retryable} failed`}</ActionButton> : null}
        {move.undoAll.length > 1 ? <UndoMoveButton itemIds={move.undoAll} label={`Undo all ${move.undoAll.length}`} confirm={`Each person this move created is deleted from the CRM; each person it added history to stays there, without that history. The ${move.undoAll.length} contacts come back to Cold outreach.`} /> : null}
      </>}
    />
    {move.settled ? null : <div aria-label={`${move.progress}% finished`} role="progressbar" aria-valuenow={move.progress} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full bg-brand-600" style={{ width: `${move.progress}%` }} /></div>}
    {move.leftOut.length ? <Notice tone="warn">Left out of this move: {move.leftOut.map((l) => `${l.name} (${l.reason})`).join('; ')}.</Notice> : null}
    <Surface flush>
      <ViewHeader title="Contacts" />
      {move.rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[13px]"><thead><tr className="border-b border-line bg-canvas/60 text-left text-[12px] text-ink-500"><th className="px-4 py-2.5 font-medium">Contact</th><th className="px-4 py-2.5 font-medium">State</th><th className="px-4 py-2.5 font-medium">In the CRM</th><th className="px-4 py-2.5 font-medium">What happened</th><th className="px-4 py-2.5 font-medium">Undo until</th><th className="px-4 py-2.5 font-medium" /></tr></thead>
        <tbody className="divide-y divide-line">{move.rows.map((r) => <tr key={r.itemId} className="align-top [&>td]:py-3">
          <td className="px-4 py-2"><Link href={r.href} className="font-medium text-ink-900 hover:text-brand-700">{r.name}</Link></td>
          <td className="px-4 py-2"><Badge tone={r.tone}>{r.stateLabel}</Badge></td>
          <td className="px-4 py-2 text-ink-600">{r.personName ? <span>{r.mode === 'attach' ? `History added to ${r.personName}` : r.personName}</span> : null}{r.firm ? <span className="block text-[12px] text-ink-500">{r.firm}</span> : null}</td>
          <td className="max-w-[44ch] px-4 py-2 text-ink-700">{r.detail}{r.fix ? <div className="mt-1.5"><Link href={r.fix.href} className="btn-secondary btn-sm">{r.fix.label}</Link></div> : null}</td>
          <td className="whitespace-nowrap px-4 py-2 tabular-nums text-ink-600">{r.undoUntil ?? <span className="text-ink-400">–</span>}</td>
          <td className="px-4 py-2 text-right">{r.canUndo ? <UndoMoveButton itemIds={[r.itemId]} confirm={r.undoConfirm} campaigns={r.campaigns} finishing={r.state === 'UNDO_PARTIAL'} /> : null}</td>
        </tr>)}</tbody></table></div> : <EmptyState title="Nothing in this move" />}
    </Surface>
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
