import Link from 'next/link';
import { PageFrame } from '@/components/page-frame';
import { requireUser } from '@/lib/auth/current-user';
import { formatInstant } from '@/lib/dates';
import { listMoves } from '@/lib/sandbox/moves-query';
import { COLD_MOVES_HREF, coldMoveHref } from '@/lib/subject';
import { ColdOutreachHeader } from '@/components/sandbox/section-tabs';
import { Badge, EmptyState, Surface, Toolbar } from '@/components/ui';

export const metadata = { title: 'Moves to CRM · Cold outreach' };

/** Cold outreach > Moves to CRM (PLAN 4.5): every move, newest first; failed ones stay visible (B036). */
export default async function MovesPage({ searchParams }: { searchParams: Promise<{ state?: string; mover?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const state = ['failed', 'running', 'undone'].includes(sp.state ?? '') ? sp.state! : '';
  const list = await listMoves({ state: state || null, moverId: sp.mover || null });
  const movers = [...new Map(list.map((m) => [m.moverId, m.moverName])).entries()];
  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    <ColdOutreachHeader user={user} current="moves" />
    <Surface flush>
      <Toolbar className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <form action={COLD_MOVES_HREF} className="flex flex-wrap items-center gap-2">
          <select name="state" defaultValue={state} aria-label="State"><option value="">Every move</option><option value="failed">With failures</option><option value="running">Still moving</option><option value="undone">With undos</option></select>
          <select name="mover" defaultValue={sp.mover ?? ''} aria-label="Moved by"><option value="">Anyone</option>{movers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
          <button type="submit" className="btn-secondary btn-sm">Apply</button>
        </form>
        <span className="ml-auto tabular-nums text-[13px] text-ink-500">{list.length === 1 ? '1 move' : `${list.length} moves`}</span>
      </Toolbar>
      {list.length ? <div className="overflow-x-auto"><table className="w-full text-[13px]"><thead><tr className="border-b border-line text-left text-ink-500"><th className="px-4 py-2 font-normal">Move</th><th className="px-4 py-2 font-normal">Moved by</th><th className="px-4 py-2 font-normal">When</th><th className="px-4 py-2 font-normal">Result</th></tr></thead>
        <tbody className="divide-y divide-line">{list.map((m) => <tr key={m.id}>
          <td className="px-4 py-2"><Link href={coldMoveHref(m.id)} className="text-ink-900 hover:text-brand-700">{m.names.join(', ') || 'Contacts'}{m.count > m.names.length ? ` and ${m.count - m.names.length} more` : ''}</Link></td>
          <td className="px-4 py-2 text-ink-700">{m.moverName}</td>
          <td className="px-4 py-2 tabular-nums text-ink-600">{formatInstant(m.createdAt, user.timezone)}</td>
          <td className="px-4 py-2"><span className="flex flex-wrap gap-1.5">{m.done ? <Badge tone="green">{`${m.done} in the CRM`}</Badge> : null}{m.waiting ? <Badge tone="blue">{`${m.waiting} moving`}</Badge> : null}{m.failed ? <Badge tone="red">{`${m.failed} failed`}</Badge> : null}{m.undone ? <Badge tone="gray">{`${m.undone} undone`}</Badge> : null}</span></td>
        </tr>)}</tbody></table></div> : <EmptyState title={state || sp.mover ? 'No moves match' : 'No moves to the CRM yet'} hint={state || sp.mover ? 'Clear the filters to see every move.' : 'When a contact is ready, open it and choose Move to CRM. Each move is listed here with what happened.'} />}
    </Surface>
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
