import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { formatInstant, formatLocalDate, toLocalDate } from '@/lib/dates';
import { getSettings } from '@/lib/settings';
import { workspaceTimezone } from '@/lib/workspace';
import { undoClosesOn } from '@/lib/sandbox/move';
import { ActionButton } from '@/components/action-form';
import { AutoRefresh } from '@/components/sandbox/auto-refresh';
import { Badge, Surface, ViewHeader } from '@/components/ui';
import { retryMoveAction, undoMoveAction } from '@/lib/actions/sandbox-move';

const STATE: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'gray' | 'blue' }> = {
  QUEUED: { label: 'Waiting', tone: 'gray' }, RUNNING: { label: 'Moving', tone: 'gray' }, DONE: { label: 'In the CRM', tone: 'green' }, FAILED: { label: 'Failed', tone: 'red' }, DRY_RUN: { label: 'Dry run', tone: 'amber' }, UNDONE: { label: 'Undone', tone: 'blue' },
};

/** One Move to CRM: each contact's progress, Twenty's answer when it failed, Retry and Undo. */
export default async function MovePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const move = await prisma.sandboxMove.findUnique({ where: { id }, include: { items: { orderBy: { id: 'asc' } } } });
  if (!move) notFound();
  const [contacts, mover, settings] = await Promise.all([
    prisma.sandboxContact.findMany({ where: { id: { in: move.items.map((i) => i.sandboxContactId) } }, select: { id: true, firstName: true, lastName: true } }),
    prisma.user.findUnique({ where: { id: move.createdById }, select: { name: true } }),
    getSettings(),
  ]);
  const nameOf = new Map(contacts.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]));
  const snapshotName = (s: unknown) => { const v = s as { firstName?: string; lastName?: string } | null; return `${v?.firstName ?? ''} ${v?.lastName ?? ''}`.trim(); };
  const failed = move.items.filter((i) => i.state === 'FAILED').length;
  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    {move.state !== 'DONE' ? <AutoRefresh /> : null}
    <Surface flush>
      <ViewHeader title={`Move to CRM · ${move.count}`} meta={<span className="text-ink-500">{mover?.name ?? 'Someone'} · {formatInstant(move.createdAt, user.timezone)}</span>} actions={failed ? <ActionButton action={retryMoveAction} payload={{ moveId: move.id }} refresh>Retry failed</ActionButton> : null} />
      <table className="w-full text-[13px]"><thead><tr className="border-b border-line text-left text-ink-500"><th className="px-4 py-2 font-normal">Contact</th><th className="px-4 py-2 font-normal">State</th><th className="px-4 py-2 font-normal">Firm</th><th className="px-4 py-2 font-normal">Detail</th><th className="px-4 py-2 font-normal">Undo until</th><th className="px-4 py-2 font-normal" /></tr></thead>
        <tbody className="divide-y divide-line">{move.items.map((i) => {
          const closes = undoClosesOn(i, settings.sandbox);
          const open = i.state === 'DONE' && closes && closes.getTime() > Date.now();
          return <tr key={i.id}>
            <td className="px-4 py-2"><Link href={i.state === 'DONE' && i.twentyPersonId ? `/people/${i.twentyPersonId}` : `/sandbox/${i.sandboxContactId}`} className="text-ink-900 hover:text-brand-700">{nameOf.get(i.sandboxContactId) || snapshotName(i.snapshot) || 'Contact'}</Link></td>
            <td className="px-4 py-2"><Badge tone={STATE[i.state]?.tone ?? 'gray'}>{STATE[i.state]?.label ?? i.state}</Badge></td>
            <td className="px-4 py-2 text-ink-600">{i.mode === 'attach' ? 'Attached to an existing person' : i.companyAction === 'created' ? 'Created the firm' : i.companyAction === 'linked' ? 'Linked to the firm' : '-'}</td>
            <td className="px-4 py-2 text-ink-600">{i.error ?? (i.notesWritten.length ? `${i.notesWritten.length} notes written` : '')}</td>
            <td className="px-4 py-2 tabular-nums text-ink-600">{open ? formatLocalDate(toLocalDate(closes, workspaceTimezone())) : '-'}</td>
            <td className="px-4 py-2 text-right">{open ? <ActionButton action={undoMoveAction} payload={{ itemId: i.id }} refresh confirm="Undo this move? The person is taken out of Twenty and the contact comes back to the sandbox.">Undo</ActionButton> : null}</td>
          </tr>;
        })}</tbody></table>
    </Surface>
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
