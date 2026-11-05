import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { formatInstant } from '@/lib/dates';
import { canWorkTickets, listTickets, ticketOutcomeWords } from '@/lib/tickets';
import { workspaceTimezone } from '@/lib/workspace';
import { PageFrame } from '@/components/page-frame';
import { Avatar, Badge, Empty, EmptyState, Surface, Tabs, ViewHeader } from '@/components/ui';

/**
 * Tickets (D4): every question raised for Biz Ops, of every kind, in one list: "Think this is wrong?"
 * on an opt-out from the post-call form, and meeting-number checks. Biz Ops and admins open one to
 * look into it and close it with a note.
 */
export default async function TicketsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  if (!canWorkTickets(user)) redirect('/home');
  const tab = (await searchParams).tab === 'closed' ? 'closed' : 'open';
  const [rows, openCount, closedCount] = await Promise.all([
    listTickets(tab === 'open'),
    Promise.all([prisma.ticket.count({ where: { open: true } }), prisma.meetingNumberTicket.count({ where: { open: true } })]).then(([a, b]) => a + b),
    Promise.all([prisma.ticket.count({ where: { open: false } }), prisma.meetingNumberTicket.count({ where: { open: false } })]).then(([a, b]) => a + b),
  ]);
  const tz = workspaceTimezone();

  return (
    <PageFrame className="space-y-3 px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader title="Tickets" meta={`${openCount} open`} />
        <Tabs current={tab} tabs={[{ key: 'open', label: 'Open', href: '/tickets', count: openCount }, { key: 'closed', label: 'Closed', href: '/tickets?tab=closed', count: closedCount }]} />
        {rows.length === 0 ? (
          <EmptyState title={tab === 'open' ? 'No open tickets' : 'No closed tickets yet'} />
        ) : (
          <table className="table table-dense w-full table-fixed">
            <colgroup><col style={{ width: '24%' }} /><col style={{ width: '14%' }} /><col style={{ width: '38%' }} /><col style={{ width: '24%' }} /></colgroup>
            <thead>
              <tr><th>About</th><th>Kind</th><th>{tab === 'open' ? 'What they know' : 'What Biz Ops found'}</th><th>{tab === 'open' ? 'Raised' : 'Closed'}</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td data-label="About">
                    <Link href={r.href} className="flex items-center gap-2.5 hover:text-brand-700">
                      <Avatar name={r.name} shape="circle" size={26} />
                      <span className="min-w-0"><span className="block truncate text-[13px] font-medium text-ink-900">{r.name}</span>{r.firm ? <span className="block truncate text-[12px] text-ink-500">{r.firm}</span> : null}</span>
                    </Link>
                  </td>
                  <td data-label="Kind" className="text-[12.5px]">
                    <Badge tone={r.kind === 'opt_out' ? 'red' : 'sky'}>{r.kindLabel}</Badge>
                    {!r.open && r.outcome ? <span className="mt-1 block text-[12px] text-ink-500">{ticketOutcomeWords(r.outcome)}</span> : null}
                  </td>
                  <td data-label="Notes" className="break-words text-[12.5px] text-ink-700">{(tab === 'open' ? r.what : r.resolution) ?? <Empty />}</td>
                  <td data-label="When" className="text-[12.5px]">
                    <span className="block text-ink-900">{tab === 'open' ? r.raisedBy ?? 'Someone' : r.resolvedBy ?? 'Biz Ops'}</span>
                    <span className="block text-[12px] text-ink-500">{formatInstant(tab === 'open' ? r.raisedAt : r.resolvedAt ?? r.raisedAt, tz)}</span>
                    {tab === 'open' ? <Link href={r.href} className="btn-secondary btn-sm mt-1.5">Look into it</Link> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Surface>
    </PageFrame>
  );
}

export const dynamic = 'force-dynamic';
