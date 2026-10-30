import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import clsx from 'clsx';
import { requireUser } from '@/lib/auth/current-user';
import { canCheckMeetingNumbers } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { meetingDay } from '@/lib/meetings/day';
import { ordinal } from '@/lib/meetings/numbering';
import { workspaceTimezone } from '@/lib/workspace';
import { PageFrame } from '@/components/page-frame';
import { Badge, Card, Empty, KeyValue, RecordHeader } from '@/components/ui';
import { CloseCheckForm, ReopenCheckButton, SetNumberForm } from '@/components/meetings/number-check-forms';

const nth = (n: number) => `${ordinal(n)} meeting`;

/**
 * One number check: what was raised, every meeting with that prospect in order with the number
 * each carries, a number Biz Ops can set on any of them (the ones after count on from it), and the
 * check closed with what was found.
 */
export default async function NumberCheckPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const check = await prisma.meetingNumberTicket.findUnique({
    where: { id },
    include: { person: { select: { id: true, firstName: true, lastName: true, companyName: true, email: true } }, meeting: { select: { id: true, title: true } }, raisedBy: { select: { name: true } }, resolvedBy: { select: { name: true } } },
  });
  if (!check) notFound();
  const checker = canCheckMeetingNumbers(user);
  if (!checker && check.raisedById !== user.id) redirect('/meetings/checks');
  const rows = await prisma.meetingAttendee.findMany({
    where: { personId: check.personId, prospect: true, meeting: { review: 'APPROVED' } },
    select: { id: true, meetingNumber: true, numberSetTo: true, meeting: { select: { id: true, title: true, occurredAt: true, createdAt: true, meetingNumber: true, bookedBy: { select: { name: true } } } } },
  });
  rows.sort((a, b) => a.meeting.occurredAt.getTime() - b.meeting.occurredAt.getTime() || a.meeting.createdAt.getTime() - b.meeting.createdAt.getTime() || a.meeting.id.localeCompare(b.meeting.id));
  const name = `${check.person.firstName} ${check.person.lastName}`.trim() || check.person.email || 'Unnamed contact';
  const tz = workspaceTimezone();

  return (
    <PageFrame className="space-y-3 px-6 pb-8 pt-2">
      <RecordHeader
        name={name}
        sub={`Meeting number check${check.person.companyName ? ` · ${check.person.companyName}` : ''}`}
        shape="circle"
        badges={<Badge tone={check.open ? 'amber' : 'green'}>{check.open ? 'Open' : 'Closed'}</Badge>}
        actions={<><Link href={`/people/${check.person.id}`} className="btn-secondary btn-sm">Open {name}</Link><Link href="/meetings/checks" className="btn-ghost btn-sm">All checks</Link></>}
      />

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card title={`Meetings with ${name} (${rows.length})`}>
          {rows.length ? (
            <table className="table table-dense w-full">
              <thead><tr><th>Date</th><th>Meeting</th><th>Booked by</th><th>Number</th>{checker && check.open ? <th>Set the number</th> : null}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  // The meeting the check was raised on stands out with a tint.
                  <tr key={r.id} className={clsx(r.meeting.id === check.meetingId && 'bg-amber-50/60')}>
                    <td className="whitespace-nowrap text-[12.5px]">{formatLocalDate(meetingDay(r.meeting.occurredAt), 'short')}</td>
                    <td className="text-[12.5px]"><Link href={`/meetings/${r.meeting.id}`} className="text-brand-700 hover:underline">{r.meeting.title}</Link></td>
                    <td className="text-[12.5px]">{r.meeting.bookedBy?.name ?? <Empty />}</td>
                    <td className="whitespace-nowrap text-[12.5px] tabular-nums">{r.meetingNumber ? nth(r.meetingNumber) : <Empty />}{r.numberSetTo !== null ? <Badge tone="sky" className="ml-1.5">Set by Biz Ops</Badge> : null}</td>
                    {checker && check.open ? <td><SetNumberForm attendeeId={r.id} current={r.meetingNumber} setTo={r.numberSetTo} label={`${r.meeting.title} on ${formatLocalDate(meetingDay(r.meeting.occurredAt), 'short')}`} /></td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="p-4 text-[13px] text-ink-500">No saved meeting with {name} yet.</div>}
        </Card>

        <aside className="space-y-3">
          <Card title="Raised">
            <div className="p-4">
              <KeyValue items={[
                { k: 'By', v: `${check.raisedBy?.name ?? 'Someone'}, ${formatInstant(check.createdAt, tz)}` },
                { k: 'Meeting', v: check.meeting ? <Link href={`/meetings/${check.meeting.id}`} className="text-brand-700 hover:underline">{check.meeting.title}</Link> : `Not saved (${formatLocalDate(check.meetingDay, 'short')})` },
                { k: 'Shown', v: nth(check.shownNumber) },
                { k: 'Should be', v: check.expectedNumber ? nth(check.expectedNumber) : <Empty /> },
                { k: 'What they know', v: check.note ?? <Empty /> },
              ]} />
            </div>
          </Card>
          {check.open ? (
            checker ? <Card title="Close the check"><CloseCheckForm ticketId={check.id} /></Card> : null
          ) : (
            <Card title="Closed" actions={checker ? <ReopenCheckButton ticketId={check.id} /> : null}>
              <div className="p-4">
                <KeyValue items={[
                  { k: 'By', v: `${check.resolvedBy?.name ?? 'Biz Ops'}${check.resolvedAt ? `, ${formatInstant(check.resolvedAt, tz)}` : ''}` },
                  { k: 'What they found', v: check.resolution ?? <Empty /> },
                ]} />
              </div>
            </Card>
          )}
        </aside>
      </div>
    </PageFrame>
  );
}
