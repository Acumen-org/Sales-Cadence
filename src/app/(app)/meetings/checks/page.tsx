import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { canCheckMeetingNumbers } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { ordinal } from '@/lib/meetings/numbering';
import { workspaceTimezone } from '@/lib/workspace';
import { PageFrame } from '@/components/page-frame';
import { Avatar, Empty, EmptyState, Surface, Tabs, ViewHeader } from '@/components/ui';

const nth = (n: number) => `${ordinal(n)} meeting`;

/**
 * Meeting numbers someone thought were wrong. Biz Ops and admins see every check and open one to
 * investigate; anyone else sees the checks they raised and, once closed, what was found.
 */
export default async function NumberChecksPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const checker = canCheckMeetingNumbers(user);
  const tab = (await searchParams).tab === 'closed' ? 'closed' : 'open';
  const scope = checker ? {} : { raisedById: user.id };
  const [checks, openCount, closedCount] = await Promise.all([
    prisma.meetingNumberTicket.findMany({
      where: { ...scope, open: tab === 'open' },
      orderBy: { createdAt: tab === 'open' ? 'asc' : 'desc' },
      take: 200,
      include: { person: { select: { firstName: true, lastName: true, companyName: true } }, meeting: { select: { id: true, title: true } }, raisedBy: { select: { name: true } }, resolvedBy: { select: { name: true } } },
    }),
    prisma.meetingNumberTicket.count({ where: { ...scope, open: true } }),
    prisma.meetingNumberTicket.count({ where: { ...scope, open: false } }),
  ]);
  const tz = workspaceTimezone();

  return (
    <PageFrame className="space-y-3 px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader title="Number checks" meta={`${openCount} open`} actions={<Link href="/meetings" className="btn-secondary">All meetings</Link>} />
        <Tabs current={tab} tabs={[{ key: 'open', label: 'Open', href: '/meetings/checks', count: openCount }, { key: 'closed', label: 'Closed', href: '/meetings/checks?tab=closed', count: closedCount }]} />
        {checks.length === 0 ? (
          <EmptyState title={tab === 'open' ? 'No open checks' : 'No closed checks yet'} />
        ) : (
          <table className="table table-dense w-full table-fixed">
            <colgroup><col style={{ width: '22%' }} /><col style={{ width: '20%' }} /><col style={{ width: '14%' }} /><col style={{ width: '24%' }} /><col style={{ width: '20%' }} /></colgroup>
            <thead>
              <tr><th>Prospect</th><th>Meeting</th><th>Number</th><th>{tab === 'open' ? 'What they know' : 'What Biz Ops found'}</th><th>{tab === 'open' ? 'Raised' : 'Closed'}</th></tr>
            </thead>
            <tbody>
              {checks.map((c) => {
                const name = `${c.person.firstName} ${c.person.lastName}`.trim() || 'Unnamed contact';
                return (
                  <tr key={c.id}>
                    <td data-label="Prospect">
                      <Link href={`/meetings/checks/${c.id}`} className="flex items-center gap-2.5 hover:text-brand-700">
                        <Avatar name={name} shape="circle" size={26} />
                        <span className="min-w-0"><span className="block truncate text-[13px] font-medium text-ink-900">{name}</span>{c.person.companyName ? <span className="block truncate text-[12px] text-ink-500">{c.person.companyName}</span> : null}</span>
                      </Link>
                    </td>
                    <td data-label="Meeting" className="text-[12.5px]">
                      {c.meeting ? <Link href={`/meetings/${c.meeting.id}`} className="block truncate text-brand-700 hover:underline">{c.meeting.title}</Link> : <span className="text-ink-500">Not saved</span>}
                      <span className="block text-[12px] text-ink-500">{formatLocalDate(c.meetingDay, 'short')}</span>
                    </td>
                    <td data-label="Number" className="text-[12.5px] tabular-nums"><span className="block"><span className="text-ink-500">Shown </span>{nth(c.shownNumber)}</span>{c.expectedNumber ? <span className="block"><span className="text-ink-500">Should be </span>{nth(c.expectedNumber)}</span> : null}</td>
                    <td data-label="Notes" className="break-words text-[12.5px] text-ink-700">{(tab === 'open' ? c.note : c.resolution) ?? <Empty />}</td>
                    <td data-label="When" className="text-[12.5px]">
                      <span className="block text-ink-900">{tab === 'open' ? c.raisedBy?.name ?? 'Someone' : c.resolvedBy?.name ?? 'Biz Ops'}</span>
                      <span className="block text-[12px] text-ink-500">{formatInstant(tab === 'open' ? c.createdAt : c.resolvedAt ?? c.createdAt, tz)}</span>
                      {checker && tab === 'open' ? <Link href={`/meetings/checks/${c.id}`} className="btn-secondary btn-sm mt-1.5">Check</Link> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Surface>
    </PageFrame>
  );
}
