import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { formatInstant } from '@/lib/dates';
import { getSettings } from '@/lib/settings';
import { callOutcomes } from '@/lib/call-outcomes';
import { mayHearCall } from '@/lib/calls/access';
import { coldRef, personRef, subjectHref } from '@/lib/subject';
import { canWorkTickets, formOptOut, ticketOutcomeWords } from '@/lib/tickets';
import { workspaceTimezone } from '@/lib/workspace';
import { PageFrame } from '@/components/page-frame';
import { Badge, Card, Empty, KeyValue, RecordHeader } from '@/components/ui';
import { CloseTicketForm } from '@/components/tickets/close-ticket-form';

/**
 * One opt-out ticket (D4): what was raised, the opt-out it is about (the call and its form), and Biz Ops'
 * close with a note, which may lift the opt-out. A meeting-number check keeps its own page.
 */
export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const ticket = await prisma.ticket.findUnique({ where: { id }, include: { person: { select: { id: true, firstName: true, lastName: true, companyName: true } }, sandboxContact: { select: { id: true, firstName: true, lastName: true, companyName: true, status: true, ownerId: true } }, raisedBy: { select: { name: true } }, resolvedBy: { select: { name: true } } } });
  if (!ticket) notFound();
  const worker = canWorkTickets(user);
  if (!worker && ticket.raisedById !== user.id) redirect('/home');
  const who = ticket.person ?? ticket.sandboxContact;
  const name = who ? `${who.firstName} ${who.lastName}`.trim() || 'Removed contact' : 'Removed contact';
  const ref = ticket.sandboxContactId && ticket.sandboxContact?.status !== 'MOVED' ? coldRef(ticket.sandboxContactId) : ticket.personId ? personRef(ticket.personId) : null;
  const details = (ticket.details ?? {}) as { optedOutAt?: string | null; callId?: string | null; by?: string | null };
  const [opt, call, settings] = await Promise.all([
    ref ? formOptOut(ref) : null,
    details.callId ? prisma.callLog.findUnique({ where: { id: details.callId }, include: { form: true, user: { select: { name: true } } } }) : null,
    getSettings(),
  ]);
  const tz = workspaceTimezone();
  const hears = call ? mayHearCall(toActor(user), { userId: call.userId, formUserId: call.formUserId, ownerId: ticket.sandboxContact?.ownerId ?? null }) : false;
  const outcome = call?.form ? callOutcomes(settings.rules).find((o) => o.key === call.form!.outcome)?.label ?? call.form.outcome : null;

  return (
    <PageFrame className="space-y-3 px-6 pb-8 pt-2">
      <RecordHeader
        name={name}
        sub={`Opt-out check${who?.companyName ? ` · ${who.companyName}` : ''}`}
        shape="circle"
        badges={<Badge tone={ticket.open ? 'amber' : 'green'}>{ticket.open ? 'Open' : 'Closed'}</Badge>}
        actions={<>{ref ? <Link href={subjectHref(ref)} className="btn-secondary btn-sm">Open {name}</Link> : null}{worker ? <Link href="/tickets" className="btn-ghost btn-sm">All tickets</Link> : null}</>}
      />
      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card title="The opt-out">
          <div className="p-4">
            <KeyValue items={[
              { k: 'Opted out', v: details.optedOutAt ? formatInstant(new Date(details.optedOutAt), tz) : <Empty /> },
              { k: 'From', v: `The post-call form${details.by ? `, filed by ${details.by}` : ''}` },
              { k: 'Call', v: call ? <Link href={`/calls/${call.id}`} className="text-brand-700 hover:underline">{formatInstant(call.startedAt ?? call.createdAt, tz)} · {call.user?.name ?? 'Unknown rep'}</Link> : <Empty /> },
              { k: 'Outcome', v: outcome ?? <Empty /> },
              { k: 'What was said', v: call?.form?.notes ? (hears ? <span className="whitespace-pre-wrap">{call.form.notes}</span> : 'Only the rep, the owner and those who see Reports can read it.') : <Empty /> },
              { k: 'Now', v: opt ? <Badge tone="red">Do not contact</Badge> : ticket.outcome === 'lifted' ? 'Lifted' : 'No longer opted out by the form' },
            ]} />
          </div>
        </Card>
        <aside className="space-y-3">
          <Card title="Raised">
            <div className="p-4"><KeyValue items={[
              { k: 'By', v: `${ticket.raisedBy?.name ?? 'Someone'}, ${formatInstant(ticket.createdAt, tz)}` },
              { k: 'What they know', v: ticket.note ?? <Empty /> },
            ]} /></div>
          </Card>
          {ticket.open ? (worker ? <Card title="Close the ticket"><CloseTicketForm ticketId={ticket.id} name={name} mayLift={Boolean(opt)} /></Card> : <Card title="Open"><p className="p-4 text-[13px] text-ink-600">Biz Ops will look into it and answer here.</p></Card>) : (
            <Card title="Closed">
              <div className="p-4"><KeyValue items={[
                { k: 'By', v: `${ticket.resolvedBy?.name ?? 'Biz Ops'}${ticket.resolvedAt ? `, ${formatInstant(ticket.resolvedAt, tz)}` : ''}` },
                { k: 'Result', v: ticketOutcomeWords(ticket.outcome) ?? <Empty /> },
                { k: 'What they found', v: ticket.resolution ?? <Empty /> },
              ]} /></div>
            </Card>
          )}
        </aside>
      </div>
    </PageFrame>
  );
}

export const dynamic = 'force-dynamic';
