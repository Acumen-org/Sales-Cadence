import Link from 'next/link';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { canCreateMeeting, decidesMeetings, isAdmin, isBizOps } from '@/lib/auth/rbac';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { approvalList, meetingsTabCounts, type ApprovalRow } from '@/lib/meetings/approval';
import { addMeetingBackAction, approveMeetingAction, declineMeetingAction } from '@/lib/actions/meeting-approval';
import { addRecordingLinkAction } from '@/lib/actions/meetings';
import { addMeetingBackConfirm, addRecordingLinkConfirm, declineMeetingConfirm } from '@/lib/confirms';
import { workspaceTimezone } from '@/lib/workspace';
import { PageFrame } from '@/components/page-frame';
import { ActionButton } from '@/components/action-form';
import { MeetingsTabs } from '@/components/meetings/meetings-tabs';
import { Flash } from '@/components/flash';
import { IconCalendar, IconPlus } from '@/components/icons';
import { Empty, EmptyState, IdentityCell, Surface, ViewHeader } from '@/components/ui';

/**
 * Meetings > Approval (owner, 20 and 21 Nov 2026). A meeting saved with no recording link waits here for
 * the Sales Leader of the booked-by FO's pod, or an admin, to approve or decline it. Everyone in the
 * pod sees its waiting and declined meetings and only reads them; the FO named in Booked by may add
 * the recording link, which takes it off the list. Declined meetings are added back from Declined.
 */
export default async function MeetingApprovalPage({ searchParams }: { searchParams: Promise<{ view?: string; flash?: string; flashTone?: string }> }) {
  const user = await requireUser();
  const actor = toActor(user);
  const counts = await meetingsTabCounts(actor);
  const sp = await searchParams;
  const view = sp.view === 'declined' ? 'declined' : 'waiting';
  const rows = await approvalList(actor, view);
  const tz = workspaceTimezone();
  const whose = isAdmin(actor) || isBizOps(actor) ? 'every pod' : 'your pods';
  const intro = view === 'waiting'
    ? decidesMeetings(actor)
      ? `Meetings saved with no recording link. They count and are in the CRM until declined. You see ${whose}.`
      : `Meetings saved with no recording link, from ${whose}. Their Sales Leader or an admin approves or declines them; until then they count and are in the CRM. If you booked one, add its recording link to take it off this list.`
    : `Declined meetings from ${whose}. They are out of Cadence and the CRM. Nobody can add one again as a new meeting; its Sales Leader, Biz Ops or an admin can add it back here.`;

  return (
    <PageFrame className="space-y-3 px-6 pb-8 pt-2">
      {sp.flash ? <Flash message={sp.flash} tone={sp.flashTone === 'error' ? 'error' : 'ok'} /> : null}
      <Surface flush>
        <ViewHeader
          title="Meetings"
          meta={view === 'waiting' ? `${counts.waiting} waiting` : `${counts.declined} declined`}
          actions={canCreateMeeting(actor) ? <Link href="/meetings/new" className="btn-primary"><IconPlus size={14} /> Add meeting</Link> : null}
        />
        <MeetingsTabs current={view} counts={counts} />
        <p className="px-5 pt-3 text-[12.5px] text-ink-600">{intro}</p>
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconCalendar size={20} />}
            title={view === 'waiting' ? 'Nothing waiting for approval' : 'No declined meetings'}
            hint={view === 'waiting' ? 'A meeting added without a recording link shows here until it is approved or declined.' : undefined}
          />
        ) : view === 'waiting' ? <WaitingTable rows={rows} tz={tz} /> : <DeclinedTable rows={rows} tz={tz} />}
      </Surface>
    </PageFrame>
  );
}

function MeetingCell({ r }: { r: ApprovalRow }) {
  const who = r.prospects.map((p) => p.name).join(', ');
  return <IdentityCell name={r.title} href={`/meetings/${r.id}`} wrap sub={[who, r.companyName].filter(Boolean).join(' · ') || undefined} />;
}

function BookedCell({ r }: { r: ApprovalRow }) {
  return <>
    <span className="block text-ink-900">{r.bookedBy ?? <Empty />}</span>
    {r.pods.length ? <span className="block text-[12px] text-ink-500">{r.pods.join(', ')}</span> : null}
  </>;
}

function WaitingTable({ rows, tz }: { rows: ApprovalRow[]; tz: string }) {
  return (
    <table className="table table-dense table-approvals mt-2 w-full table-fixed">
      <colgroup><col style={{ width: '31%' }} /><col style={{ width: '13%' }} /><col style={{ width: '16%' }} /><col style={{ width: '17%' }} /><col style={{ width: '23%' }} /></colgroup>
      <thead><tr><th>Meeting</th><th>Date</th><th>Booked by</th><th>Added</th><th>Decision</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td data-label="Meeting"><MeetingCell r={r} /></td>
            <td data-label="Date" className="whitespace-nowrap text-[12.5px] font-medium text-ink-900">{formatLocalDate(r.day, 'long')}</td>
            <td data-label="Booked by" className="break-words text-[12.5px]"><BookedCell r={r} /></td>
            <td data-label="Added" className="text-[12.5px]">
              <span className="block text-ink-900">{r.addedBy ?? 'Someone'}</span>
              <span className="block text-[12px] text-ink-500">{formatInstant(r.createdAt, tz)}</span>
            </td>
            <td data-label="Decision">
              {r.mayDecide || r.mayAddLink ? (
                <div className="flex flex-wrap items-start gap-1.5">
                  {r.mayDecide ? <>
                    <ActionButton action={approveMeetingAction} payload={{ meetingId: r.id }} className="btn-primary btn-sm" flash>Approve</ActionButton>
                    <ActionButton action={declineMeetingAction} payload={{ meetingId: r.id }} className="btn-secondary btn-sm text-red-700" confirm={declineMeetingConfirm({ title: r.title, bookedBy: r.bookedBy })} flash>Decline</ActionButton>
                  </> : null}
                  {r.mayAddLink ? <ActionButton action={addRecordingLinkAction} payload={{ meetingId: r.id }} className={r.mayDecide ? 'btn-ghost btn-sm' : 'btn-secondary btn-sm'} confirm={addRecordingLinkConfirm({ title: r.title })} flash>Add recording link</ActionButton> : null}
                </div>
              ) : null}
              {!r.mayDecide ? <span className={`block text-[12px] text-ink-500${r.mayAddLink ? ' mt-1.5' : ''}`}>Waiting for {r.deciders ?? 'its Sales Leader'}.</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DeclinedTable({ rows, tz }: { rows: ApprovalRow[]; tz: string }) {
  return (
    <table className="table table-dense table-approvals mt-2 w-full table-fixed">
      <colgroup><col style={{ width: '25%' }} /><col style={{ width: '12%' }} /><col style={{ width: '14%' }} /><col style={{ width: '16%' }} /><col style={{ width: '20%' }} /><col style={{ width: '13%' }} /></colgroup>
      <thead><tr><th>Meeting</th><th>Date</th><th>Booked by</th><th>Declined</th><th>Why</th><th aria-label="Add back" /></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td data-label="Meeting"><MeetingCell r={r} /></td>
            <td data-label="Date" className="whitespace-nowrap text-[12.5px] font-medium text-ink-900">{formatLocalDate(r.day, 'long')}</td>
            <td data-label="Booked by" className="break-words text-[12.5px]"><BookedCell r={r} /></td>
            <td data-label="Declined" className="text-[12.5px]">
              <span className="block text-ink-900">{r.declinedBy ?? 'Someone'}</span>
              {r.declinedAt ? <span className="block text-[12px] text-ink-500">{formatInstant(r.declinedAt, tz)}</span> : null}
            </td>
            <td data-label="Why" className="break-words text-[12.5px] text-ink-700">{r.declineReason ?? <Empty />}</td>
            <td data-label="Add back">
              {r.mayAddBack ? <ActionButton action={addMeetingBackAction} payload={{ meetingId: r.id }} className="btn-secondary btn-sm" confirm={addMeetingBackConfirm({ title: r.title, bookedBy: r.bookedBy })} flash>Add back</ActionButton> : <Empty />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const dynamic = 'force-dynamic';
