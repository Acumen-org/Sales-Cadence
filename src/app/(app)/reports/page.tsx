import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canViewReports, toActor } from '@/lib/auth/rbac';
import { formatInstant, formatLocalDate, todayIn } from '@/lib/dates';
import { buildReports, type GroupRow } from '@/lib/reports-query';
import { getSettings } from '@/lib/settings';
import { IconReports } from '@/components/icons';
import { Avatar, EmptyState, IdentityCell, Stat, Surface, Tabs, ViewHeader } from '@/components/ui';

const pct = (n: number) => `${Math.round(n * 100)}%`;

function Rate({ value }: { value: number }) {
  const v = Math.round(value * 100);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-canvas">
        <span className="block h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, v)}%` }} />
      </span>
      <span className="text-[12.5px] font-medium text-ink-900">{v}%</span>
    </span>
  );
}

function GroupTable({ rows, first }: { rows: GroupRow[]; first: string }) {
  if (!rows.length) return <EmptyState icon={<IconReports size={20} />} title="No data yet" />;
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="table table-tight">
        <thead>
          <tr>
            <th>{first}</th>
            <th>Enrolled</th>
            <th>Active</th>
            <th>Replied</th>
            <th>Meetings</th>
            <th>Finished</th>
            <th>Exited</th>
            <th>Reply rate</th>
            <th>Meeting rate</th>
            <th>Tasks done</th>
            <th>Skipped</th>
            <th>Overdue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="font-medium text-ink-900">{r.label}</td>
              <td>{r.enrolled}</td>
              <td>{r.active}</td>
              <td>{r.replied}</td>
              <td>{r.meeting}</td>
              <td>{r.completed}</td>
              <td>{r.exited}</td>
              <td>
                <Rate value={r.replyRate} />
              </td>
              <td>{pct(r.meetingRate)}</td>
              <td>{r.tasksDone}</td>
              <td>{r.tasksSkipped}</td>
              <td className={r.overdue ? 'font-medium text-red-600' : undefined}>{r.overdue}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TABS = [
  { key: 'activity', label: 'Activity' },
  { key: 'pods', label: 'By pod' },
  { key: 'fos', label: 'By FO' },
  { key: 'campaigns', label: 'By campaign' },
  { key: 'sequences', label: 'By sequence' },
  { key: 'channels', label: 'By channel' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'stalled', label: 'Stalled' },
];

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  if (!canViewReports(toActor(user))) redirect('/tasks');
  const { tab = 'activity' } = await searchParams;
  const settings = await getSettings();
  const todayDate = todayIn(user.timezone);
  const r = await buildReports(user, todayDate, settings.rules.stalledDays);

  return (
    <div className="space-y-3 px-6 pb-8 pt-2">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Enrolled" value={r.totals.enrollments} />
        <Stat label="Active" value={r.totals.active} />
        <Stat label="Replied" value={r.totals.replied} tone="good" />
        <Stat label="Meetings" value={r.totals.meeting} tone="good" />
        <Stat label="Overdue tasks" value={r.totals.overdue} tone={r.totals.overdue ? 'warn' : 'default'} />
        <Stat label={`Stalled (${settings.rules.stalledDays}d)`} value={r.totals.stalled} tone={r.totals.stalled ? 'warn' : 'default'} />
      </div>

      <Surface flush>
        <ViewHeader title="Performance" caret meta={`as of ${formatLocalDate(todayDate, 'long')}`} />
        <Tabs
          inset={false}
          current={tab}
          tabs={TABS.map((t) => ({ ...t, href: `/reports?tab=${t.key}`, count: t.key === 'overdue' ? r.overdue.length : t.key === 'stalled' ? r.stalled.length : undefined }))}
        />

        {tab === 'activity' ? (
          r.activity.length === 0 ? (
            <EmptyState icon={<IconReports size={20} />} title="No activity yet" />
          ) : (
            <div className="overflow-x-auto scroll-thin">
              <table className="table table-tight">
                <thead>
                  <tr>
                    <th rowSpan={2}>FO</th>
                    <th colSpan={6} className="border-l border-line text-center">
                      Last 7 days
                    </th>
                    <th colSpan={4} className="border-l border-line text-center">
                      Last 28 days
                    </th>
                  </tr>
                  <tr>
                    <th className="border-l border-line">Emails</th>
                    <th>Calls</th>
                    <th>Answered</th>
                    <th>LinkedIn</th>
                    <th>Replies</th>
                    <th>Meetings</th>
                    <th className="border-l border-line">Touches</th>
                    <th>Observed</th>
                    <th>Replies</th>
                    <th>Meetings</th>
                  </tr>
                </thead>
                <tbody>
                  {r.activity.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <Avatar name={a.name} shape="circle" size={26} />
                          <span className="whitespace-nowrap font-medium text-ink-900">{a.name}</span>
                        </div>
                      </td>
                      <td className="border-l border-line">{a.last7.emails}</td>
                      <td>{a.last7.calls}</td>
                      <td>{a.last7.answered}</td>
                      <td>{a.last7.linkedin}</td>
                      <td>{a.last7.replies}</td>
                      <td>{a.last7.meetings}</td>
                      <td className="border-l border-line">{a.last28.total}</td>
                      <td>{a.last28.total ? `${Math.round((a.last28.observed / a.last28.total) * 100)}%` : '-'}</td>
                      <td>{a.last28.replies}</td>
                      <td>{a.last28.meetings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {tab === 'pods' ? <GroupTable rows={r.byPod} first="Pod" /> : null}
        {tab === 'fos' ? <GroupTable rows={r.byFo} first="FO" /> : null}
        {tab === 'campaigns' ? <GroupTable rows={r.byCampaign} first="Campaign" /> : null}
        {tab === 'sequences' ? <GroupTable rows={r.bySequence} first="Sequence" /> : null}

        {tab === 'channels' ? (
          <div className="overflow-x-auto scroll-thin">
            <table className="table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Pending</th>
                  <th>Overdue</th>
                  <th>Done</th>
                  <th>Observed in Twenty</th>
                  <th>Marked manually</th>
                  <th>Skipped</th>
                  <th>Cancelled</th>
                </tr>
              </thead>
              <tbody>
                {r.channels.map((c) => (
                  <tr key={c.action}>
                    <td className="font-medium text-ink-900">{c.label}</td>
                    <td>{c.pending}</td>
                    <td className={c.overdue ? 'font-medium text-red-600' : undefined}>{c.overdue}</td>
                    <td>{c.done}</td>
                    <td>{c.observed}</td>
                    <td>{c.manual}</td>
                    <td>{c.skipped}</td>
                    <td>{c.cancelled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === 'overdue' ? (
          r.overdue.length === 0 ? (
            <EmptyState title="Nothing overdue" />
          ) : (
            <div className="overflow-x-auto scroll-thin">
              <table className="table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Task</th>
                    <th>FO</th>
                    <th>Pod</th>
                    <th>Due</th>
                    <th>Days overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {r.overdue.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <IdentityCell name={t.person} sub={t.company} shape="circle" size={28} />
                      </td>
                      <td>{t.label}</td>
                      <td className="whitespace-nowrap">{t.fo}</td>
                      <td className="whitespace-nowrap">{t.pod}</td>
                      <td className="whitespace-nowrap">{formatLocalDate(t.due)}</td>
                      <td className="font-medium text-red-600">{t.daysOverdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {tab === 'stalled' ? (
          r.stalled.length === 0 ? (
            <EmptyState title="Nothing stalled" hint={`Active enrollments with no touch in ${settings.rules.stalledDays} days would appear here.`} />
          ) : (
            <div className="overflow-x-auto scroll-thin">
              <table className="table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>FO</th>
                    <th>Pod</th>
                    <th>Started</th>
                    <th>Step</th>
                    <th>Last touch</th>
                  </tr>
                </thead>
                <tbody>
                  {r.stalled.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <IdentityCell name={s.person} sub={s.company} shape="circle" size={28} />
                      </td>
                      <td className="whitespace-nowrap">{s.fo}</td>
                      <td className="whitespace-nowrap">{s.pod}</td>
                      <td className="whitespace-nowrap">{formatLocalDate(s.startDate)}</td>
                      <td>{s.currentStep + 1}</td>
                      <td className="whitespace-nowrap">{s.lastTouch ? formatInstant(s.lastTouch, user.timezone) : <span className="text-ink-300">never</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </Surface>
    </div>
  );
}
