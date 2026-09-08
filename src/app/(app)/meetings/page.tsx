import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { formatInstant, todayIn, weekRange } from '@/lib/dates';
import { PROVIDER_LABELS } from '@/lib/meetings/providers';
import { IconCalendar, IconPlus } from '@/components/icons';
import { Badge, EmptyState, IdentityCell, Surface, Toolbar, ViewHeader } from '@/components/ui';

const PAGE_SIZE = 50;

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<{ scope?: string; page?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const scope = sp.scope === 'mine' ? 'mine' : sp.scope === 'week' ? 'week' : 'all';
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const today = todayIn(user.timezone);
  const week = weekRange(today, user.timezone);

  const where =
    scope === 'mine'
      ? { createdById: user.id }
      : scope === 'week'
        ? { occurredAt: { gte: week.fromInstant, lt: week.toInstant } }
        : {};

  const [meetings, total, mine, thisWeek] = await Promise.all([
    prisma.meeting.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        title: true,
        provider: true,
        occurredAt: true,
        durationSec: true,
        companyName: true,
        companyId: true,
        transcript: true,
        analysisStatus: true,
        createdBy: { select: { name: true } },
        _count: { select: { attendees: true } },
        attendees: { where: { external: true }, select: { id: true }, take: 1 },
      },
    }),
    prisma.meeting.count({ where }),
    prisma.meeting.count({ where: { createdById: user.id } }),
    prisma.meeting.count({ where: { occurredAt: { gte: week.fromInstant, lt: week.toInstant } } }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (s: string) => `/meetings?scope=${s}`;

  return (
    <div className="space-y-3 px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader
          title={scope === 'mine' ? 'My meetings' : scope === 'week' ? 'This week' : 'All meetings'}
          caret
          meta={`${total} recording${total === 1 ? '' : 's'}`}
          actions={
            <Link href="/meetings/new" className="btn-secondary btn-sm">
              <IconPlus size={13} /> Add meeting
            </Link>
          }
        />
        <Toolbar>
          <Link href={href('all')} className={scope === 'all' ? 'chip' : 'chip-muted'}>
            All
          </Link>
          <Link href={href('mine')} className={scope === 'mine' ? 'chip' : 'chip-muted'}>
            Added by me <span className="ml-0.5 opacity-60">{mine}</span>
          </Link>
          <Link href={href('week')} className={scope === 'week' ? 'chip' : 'chip-muted'}>
            This week <span className="ml-0.5 opacity-60">{thisWeek}</span>
          </Link>
        </Toolbar>

        {meetings.length === 0 ? (
          <EmptyState
            icon={<IconCalendar size={20} />}
            title="No meetings yet"
            hint="Paste a Teams, Zoom or Google Meet recording link and Cadence plays it here with the transcript underneath."
            action={
              <Link href="/meetings/new" className="btn-primary">
                <IconPlus size={15} /> Add meeting
              </Link>
            }
          />
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="table">
              <thead>
                <tr>
                  <th>Meeting</th>
                  <th>When</th>
                  <th>Length</th>
                  <th>Account</th>
                  <th>Attendees</th>
                  <th>Transcript</th>
                  <th>Analysis</th>
                  <th>Added by</th>
                </tr>
              </thead>
              <tbody>
                {meetings.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <IdentityCell name={m.title} href={`/meetings/${m.id}`} sub={PROVIDER_LABELS[m.provider]} />
                    </td>
                    <td className="whitespace-nowrap text-[12.5px]">{formatInstant(m.occurredAt, user.timezone)}</td>
                    <td className="whitespace-nowrap text-[12.5px]">{m.durationSec ? `${Math.round(m.durationSec / 60)} min` : '-'}</td>
                    <td className="text-[12.5px]">
                      {m.companyId ? (
                        <Link href={`/accounts/${m.companyId}`} className="text-brand-700 hover:underline">
                          {m.companyName}
                        </Link>
                      ) : (
                        m.companyName ?? <span className="text-ink-300">-</span>
                      )}
                    </td>
                    <td className="text-[12.5px]">
                      {m._count.attendees}
                      {m.attendees.length ? <Badge tone="green" className="ml-1.5">external</Badge> : null}
                    </td>
                    <td>{m.transcript ? <Badge tone="blue">yes</Badge> : <span className="text-[12px] text-ink-300">-</span>}</td>
                    <td>
                      {m.analysisStatus === 'READY' ? (
                        <Badge tone="green">ready</Badge>
                      ) : m.analysisStatus === 'FAILED' ? (
                        <Badge tone="red">failed</Badge>
                      ) : m.analysisStatus === 'PENDING' ? (
                        <Badge tone="amber">running</Badge>
                      ) : (
                        <span className="text-[12px] text-ink-300">not run</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-[12.5px]">{m.createdBy?.name ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      {pages > 1 ? (
        <div className="flex items-center justify-between text-[13px] text-ink-500">
          <span>
            Page {page} of {pages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link href={`/meetings?scope=${scope}&page=${page - 1}`} className="btn-secondary btn-sm">
                Previous
              </Link>
            ) : null}
            {page < pages ? (
              <Link href={`/meetings?scope=${scope}&page=${page + 1}`} className="btn-secondary btn-sm">
                Next
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
