import Link from 'next/link';
import { PageFrame } from '@/components/page-frame';
import { requireUser } from '@/lib/auth/current-user';
import { formatInstant } from '@/lib/dates';
import { listMoves } from '@/lib/sandbox/moves-query';
import { prisma } from '@/lib/db';
import { filterParam, sectionDefaults } from '@/lib/default-filters';
import { coldMoveHref } from '@/lib/subject';
import { ColdOutreachHeader } from '@/components/sandbox/section-tabs';
import { MovesToolbar } from '@/components/sandbox/moves-toolbar';
import { Badge, EmptyState, Surface } from '@/components/ui';

export const metadata = { title: 'Moves to CRM · Cold outreach' };

/**
 * Cold outreach > Moves to CRM (PLAN 4.5): every move, newest first; failed ones stay visible (B036).
 * Opens on the reader's pod, as Tasks does (owner, 10 Nov 2026), with the reader's own moves always in it.
 * One row of filters that apply as they are chosen; a one-contact move shows why it failed in its row.
 */
export default async function MovesPage({ searchParams }: { searchParams: Promise<{ state?: string; mover?: string; pod?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const state = ['failed', 'running', 'undone'].includes(sp.state ?? '') ? sp.state! : '';
  const podDefault = (await sectionDefaults(user)).podId;
  const podId = filterParam(sp.pod, podDefault);
  const [list, pods, everyMover] = await Promise.all([
    listMoves({ state: state || null, moverId: sp.mover || null, podId, viewerId: user.id }),
    prisma.pod.findMany({ where: { archived: false }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.sandboxMove.findMany({ distinct: ['createdById'], select: { createdById: true } }),
  ]);
  // Everyone who has moved anyone, so the filter never loses the person it is set to.
  const movers = await prisma.user.findMany({ where: { id: { in: everyMover.map((m) => m.createdById) } }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  const filtered = Boolean(state || sp.mover || podId);
  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    <ColdOutreachHeader user={user} current="moves" />
    <Surface flush>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <MovesToolbar pod={podId ?? ''} podDefault={podDefault ?? ''} state={state} mover={sp.mover ?? ''} pods={pods.map((p) => ({ value: p.id, label: p.name }))} movers={movers.map((m) => ({ value: m.id, label: m.name }))} />
        <span className="ml-auto shrink-0 tabular-nums text-[12.5px] text-ink-500">{list.length === 1 ? '1 move' : `${list.length} moves`}</span>
      </div>
      {list.length ? <div className="overflow-x-auto"><table className="w-full text-[13px]">
        <thead><tr className="border-b border-line bg-canvas/60 text-left text-[12px] text-ink-500">
          <th className="px-4 py-2.5 font-medium">Contacts</th><th className="px-4 py-2.5 font-medium">Result</th><th className="hidden px-4 py-2.5 font-medium sm:table-cell">Moved by</th><th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">When</th>
        </tr></thead>
        <tbody className="divide-y divide-line">{list.map((m) => <tr key={m.id} className="align-top hover:bg-canvas/50">
          <td className="px-4 py-3">
            <Link href={coldMoveHref(m.id)} className="font-medium text-ink-900 hover:text-brand-700">{m.names.join(', ') || (m.count === 1 ? '1 contact' : `${m.count} contacts`)}{m.names.length && m.count > m.names.length ? <span className="font-normal text-ink-500">{` and ${m.count - m.names.length} more`}</span> : null}</Link>
            <div className="mt-0.5 text-[12px] text-ink-500 sm:hidden">{m.moverName} · {formatInstant(m.createdAt, user.timezone)}</div>
            {m.error ? <div className="mt-0.5 max-w-[60ch] text-[12.5px] text-ink-600">{m.error}</div> : null}
          </td>
          <td className="px-4 py-3"><span className="flex flex-wrap gap-1.5">
            {m.done ? <Badge tone="green">{`${m.done} in the CRM`}</Badge> : null}
            {m.waiting ? <Badge tone="blue">{`${m.waiting} moving`}</Badge> : null}
            {m.retrying ? <Badge tone="amber">{`${m.retrying} trying again`}</Badge> : null}
            {m.failed ? <Badge tone="red">{`${m.failed} failed`}</Badge> : null}
            {m.undone ? <Badge tone="gray">{`${m.undone} undone`}</Badge> : null}
          </span></td>
          <td className="hidden px-4 py-3 text-ink-700 sm:table-cell">{m.moverName}</td>
          <td className="hidden whitespace-nowrap px-4 py-3 text-right tabular-nums text-ink-600 sm:table-cell">{formatInstant(m.createdAt, user.timezone)}</td>
        </tr>)}</tbody>
      </table></div> : <EmptyState title={filtered ? 'No moves match' : 'No moves to the CRM yet'} hint={filtered ? 'Choose All pods, or Reset, to see every move.' : 'When a contact is ready, open it and choose Move to CRM. Each move is listed here with what happened.'} />}
    </Surface>
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
