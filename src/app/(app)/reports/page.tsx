import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canViewReports, toActor } from '@/lib/auth/rbac';
import { formatInstant, formatLocalDate, todayIn } from '@/lib/dates';
import { buildReports, type GroupRow } from '@/lib/reports-query';
import { getSettings } from '@/lib/settings';
import { Card, EmptyState, PageHeader, Stat, Tabs } from '@/components/ui';

const pct = (n: number) => `${Math.round(n * 100)}%`;

function GroupTable({ rows, first }: { rows: GroupRow[]; first: string }) {
  if (!rows.length) return <EmptyState title="No data yet" />;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{first}</th>
          <th>Enrolled</th>
          <th>Active</th>
          <th>Replied</th>
          <th>Meetings</th>
          <th>Completed</th>
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
            <td className="font-medium text-slate-900">{r.label}</td>
            <td>{r.enrolled}</td>
            <td>{r.active}</td>
            <td>{r.replied}</td>
            <td>{r.meeting}</td>
            <td>{r.completed}</td>
            <td>{r.exited}</td>
            <td>{pct(r.replyRate)}</td>
            <td>{pct(r.meetingRate)}</td>
            <td>{r.tasksDone}</td>
            <td>{r.tasksSkipped}</td>
            <td className={r.overdue ? 'font-medium text-red-600' : undefined}>{r.overdue}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const today = todayIn(user.timezone);
  const r = await buildReports(user, today, settings.rules.stalledDays);

  return (
    <>
      <PageHeader title="Reports" subtitle={`As of ${formatLocalDate(today, 'long')}. Reply rate = replied + meetings over everyone not exited.`} />
      <div className="grid gap-3 px-6 pt-6 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Enrolled" value={r.totals.enrollments} />
        <Stat label="Active" value={r.totals.active} />
        <Stat label="Replied" value={r.totals.replied} tone="good" />
        <Stat label="Meetings" value={r.totals.meeting} tone="good" />
        <Stat label="Overdue tasks" value={r.totals.overdue} tone={r.totals.overdue ? 'warn' : 'default'} />
        <Stat label={`Stalled (${settings.rules.stalledDays}d)`} value={r.totals.stalled} tone={r.totals.stalled ? 'warn' : 'default'} />
      </div>
      <div className="mt-4">
        <Tabs current={tab} tabs={TABS.map((t) => ({ ...t, href: `/reports?tab=${t.key}`, count: t.key === 'overdue' ? r.overdue.length : t.key === 'stalled' ? r.stalled.length : undefined }))} />
      </div>
      <div className="p-6">
        <Card>
          {tab === 'activity' ? (
            r.activity.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th rowSpan={2}>FO</th>
                    <th colSpan={6} className="text-center">
                      Last 7 days
                    </th>
                    <th colSpan={4} className="text-center">
                      Last 28 days
                    </th>
                  </tr>
                  <tr>
                    <th>Emails</th>
                    <th>Calls</th>
                    <th>Answered</th>
                    <th>LinkedIn</th>
                    <th>Replies</th>
                    <th>Meetings</th>
                    <th>Touches</th>
                    <th>Observed in Twenty</th>
                    <th>Replies</th>
                    <th>Meetings</th>
                  </tr>
                </thead>
                <tbody>
                  {r.activity.map((a) => (
                    <tr key={a.id}>
                      <td className="font-medium text-slate-900">{a.name}</td>
                      <td>{a.last7.emails}</td>
                      <td>{a.last7.calls}</td>
                      <td>{a.last7.answered}</td>
                      <td>{a.last7.linkedin}</td>
                      <td>{a.last7.replies}</td>
                      <td>{a.last7.meetings}</td>
                      <td>{a.last28.total}</td>
                      <td>{a.last28.total ? `${Math.round((a.last28.observed / a.last28.total) * 100)}%` : '-'}</td>
                      <td>{a.last28.replies}</td>
                      <td>{a.last28.meetings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}
          {tab === 'pods' ? <GroupTable rows={r.byPod} first="Pod" /> : null}
          {tab === 'fos' ? <GroupTable rows={r.byFo} first="FO" /> : null}
          {tab === 'campaigns' ? <GroupTable rows={r.byCampaign} first="Campaign" /> : null}
          {tab === 'sequences' ? <GroupTable rows={r.bySequence} first="Sequence" /> : null}
          {tab === 'channels' ? (
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
                    <td className="font-medium text-slate-900">{c.label}</td>
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
          ) : null}
          {tab === 'overdue' ? (
            r.overdue.length === 0 ? (
              <EmptyState title="Nothing overdue" />
            ) : (
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
                        <div className="font-medium text-slate-900">{t.person}</div>
                        <div className="text-xs text-slate-500">{t.company}</div>
                      </td>
                      <td>{t.label}</td>
                      <td>{t.fo}</td>
                      <td>{t.pod}</td>
                      <td>{t.due}</td>
                      <td className="font-medium text-red-600">{t.daysOverdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}
          {tab === 'stalled' ? (
            r.stalled.length === 0 ? (
              <EmptyState title="Nothing stalled" hint={`Active enrollments with no touch in ${settings.rules.stalledDays} days would appear here.`} />
            ) : (
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
                        <div className="font-medium text-slate-900">{s.person}</div>
                        <div className="text-xs text-slate-500">{s.company}</div>
                      </td>
                      <td>{s.fo}</td>
                      <td>{s.pod}</td>
                      <td>{s.startDate}</td>
                      <td>{s.currentStep + 1}</td>
                      <td>{s.lastTouch ? formatInstant(s.lastTouch, user.timezone) : <span className="text-slate-400">never</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}
        </Card>
      </div>
    </>
  );
}
