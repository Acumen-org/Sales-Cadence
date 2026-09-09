import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canViewReports, toActor, visiblePodIds } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { todayIn } from '@/lib/dates';
import { buildReports, reportingRange, REPORTING_TIMEZONE, type GroupRow } from '@/lib/reports-query';
import { IconReports } from '@/components/icons';
import { Avatar, EmptyState, Field, Notice, Stat, Surface, Tabs, ViewHeader } from '@/components/ui';

function Rate({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-brand-50" aria-hidden="true">
        <span className="block h-full rounded-full bg-brand-600" style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
      <strong>{percent}%</strong>
    </span>
  );
}

function GroupTable({ rows, first }: { rows: GroupRow[]; first: string }) {
  const visible = rows.filter((r) => r.enrolled || r.replied || r.meeting || r.completed || r.exited || r.tasksDone || r.tasksSkipped);
  if (!visible.length) return <EmptyState icon={<IconReports size={20} />} title="No results in this period" />;
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="table data-table">
        <thead><tr><th>{first}</th><th>Enrolled</th><th>Replies</th><th>Meetings</th><th>Finished</th><th>Exited</th><th>Reply rate</th><th>Meeting rate</th><th>Completed tasks</th><th>Skipped</th></tr></thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td><td>{r.enrolled}</td><td>{r.replied}</td><td>{r.meeting}</td><td>{r.completed}</td><td>{r.exited}</td>
              <td><Rate value={r.replyRate} /></td><td><Rate value={r.meetingRate} /></td><td>{r.tasksDone}</td><td>{r.tasksSkipped}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TABS = [
  { key: 'activity', label: 'Team performance' },
  { key: 'pods', label: 'By pod' },
  { key: 'fos', label: 'By FO' },
  { key: 'campaigns', label: 'By campaign' },
  { key: 'sequences', label: 'By sequence' },
  { key: 'channels', label: 'By channel' },
];
type Search = { tab?: string; from?: string; to?: string; pod?: string; fo?: string };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  if (!canViewReports(toActor(user))) redirect('/tasks');
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : 'activity';
  const today = todayIn(REPORTING_TIMEZONE);
  const range = reportingRange(sp.from, sp.to, today);
  const visiblePods = visiblePodIds(user);
  const podId = sp.pod || null;
  const foUserId = sp.fo || null;
  const [pods, users, reports] = await Promise.all([
    prisma.pod.findMany({ where: visiblePods === null ? {} : { id: { in: visiblePods } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.user.findMany({
      where: { AND: [visiblePods === null ? {} : { OR: [{ id: user.id }, { pods: { some: { podId: { in: visiblePods } } } }] }, ...(podId ? [{ pods: { some: { podId } } }] : [])] },
      select: { id: true, name: true }, orderBy: { name: 'asc' },
    }),
    buildReports(user, today, 7, { range, podId, foUserId }),
  ]);
  const tabHref = (key: string) => {
    const params = new URLSearchParams({ tab: key, from: range.from, to: range.to });
    if (podId) params.set('pod', podId);
    if (foUserId) params.set('fo', foUserId);
    return `/reports?${params.toString()}`;
  };
  return (
    <div className="space-y-5 px-6 pb-8 pt-2">
      <Surface>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="tab" value={tab} />
          <Field label="From" className="min-w-[145px] flex-1"><input type="date" name="from" defaultValue={range.from} required /></Field>
          <Field label="Through" className="min-w-[145px] flex-1"><input type="date" name="to" defaultValue={range.to} required /></Field>
          <Field label="Pod" className="min-w-[150px] flex-1"><select name="pod" defaultValue={podId ?? ''}><option value="">All visible pods</option>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="FO" className="min-w-[150px] flex-1"><select name="fo" defaultValue={foUserId ?? ''}><option value="">All visible FOs</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          <button type="submit" className="btn-primary">Apply filters</button>
          <Link href={`/reports?tab=${tab}`} className="btn-ghost">Reset</Link>
        </form>
        {range.error ? <div className="mt-3"><Notice tone="error">{range.error}</Notice></div> : null}
      </Surface>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="New enrollments" value={reports.totals.enrollments} />
        <Stat label="Completed tasks" value={reports.totals.tasksDone} />
        <Stat label="Replies" value={reports.totals.replied} tone="good" />
        <Stat label="Meetings" value={reports.totals.meeting} tone="good" />
      </div>
      <Surface flush>
        <ViewHeader title="Performance" />
        <Tabs inset={false} current={tab} tabs={TABS.map((t) => ({ ...t, href: tabHref(t.key) }))} />
        {tab === 'activity' ? (
          reports.activity.length ? (
            <div className="overflow-x-auto scroll-thin">
              <table className="table data-table">
                <thead><tr><th>FO</th><th>Email</th><th>Calls</th><th>Answered calls</th><th>LinkedIn</th><th>Replies</th><th>Meetings</th><th>Completed tasks</th></tr></thead>
                <tbody>{reports.activity.map((row) => (
                  <tr key={row.id}>
                    <td><div className="flex items-center gap-2.5"><Avatar name={row.name} shape="circle" size={28} /><strong className="whitespace-nowrap">{row.name}</strong></div></td>
                    <td>{row.period.emails}</td><td>{row.period.calls}</td><td>{row.period.answered}</td><td>{row.period.linkedin}</td><td>{row.period.replies}</td><td>{row.period.meetings}</td><td>{row.period.total}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <EmptyState icon={<IconReports size={20} />} title="No results in this period" />
        ) : null}
        {tab === 'pods' ? <GroupTable rows={reports.byPod} first="Pod" /> : null}
        {tab === 'fos' ? <GroupTable rows={reports.byFo} first="FO" /> : null}
        {tab === 'campaigns' ? <GroupTable rows={reports.byCampaign} first="Campaign" /> : null}
        {tab === 'sequences' ? <GroupTable rows={reports.bySequence} first="Sequence" /> : null}
        {tab === 'channels' ? (
          <div className="overflow-x-auto scroll-thin"><table className="table data-table">
            <thead><tr><th>Channel</th><th>Scheduled</th><th>Completed</th><th>Confirmed by CRM</th><th>Logged by FO</th><th>Skipped</th><th>Cancelled</th></tr></thead>
            <tbody>{reports.channels.map((channel) => <tr key={channel.action}><td>{channel.label}</td><td>{channel.pending}</td><td>{channel.done}</td><td>{channel.observed}</td><td>{channel.manual}</td><td>{channel.skipped}</td><td>{channel.cancelled}</td></tr>)}</tbody>
          </table></div>
        ) : null}
      </Surface>
    </div>
  );
}
