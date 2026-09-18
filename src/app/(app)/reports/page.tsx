import { PageFrame } from '@/components/page-frame';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canViewReports, toActor } from '@/lib/auth/rbac';
import { addDays, formatLocalDate } from '@/lib/dates';
import { loadReportBundle } from '@/lib/reports-bundle';
import type { GroupRow } from '@/lib/reports-query';
import { IconReports } from '@/components/icons';
import { Avatar, Count, EmptyState, Field, Notice, Surface, Tabs, ViewHeader } from '@/components/ui';
import { GroupCompare, ReportDocument } from '@/components/reports/report-document';
import { Delta } from '@/components/reports/charts';

/**
 * Two views of one period. "Picture" is the infographic leadership reads and exports; "Table" is
 * the same numbers as roll-ups, each beside the period before. The range presets are the ones a
 * leader actually asks for.
 */
const TABS = [
  { key: 'activity', label: 'By FO and channel' },
  { key: 'pods', label: 'By pod' },
  { key: 'fos', label: 'By FO' },
  { key: 'campaigns', label: 'By campaign' },
  { key: 'sequences', label: 'By sequence' },
  { key: 'channels', label: 'By channel' },
];
type Search = { view?: string; tab?: string; from?: string; to?: string; pod?: string; fo?: string };

function GroupTable({ rows, previous, first }: { rows: GroupRow[]; previous: GroupRow[]; first: string }) {
  const visible = rows.filter((r) => r.enrolled || r.replied || r.meeting || r.completed || r.exited || r.tasksDone || r.tasksSkipped);
  if (!visible.length) return <EmptyState icon={<IconReports size={20} />} title="No results in this period" />;
  return <div className="p-4"><GroupCompare rows={visible} previous={previous} first={first} /></div>;
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  if (!canViewReports(toActor(user))) redirect('/tasks');
  const sp = await searchParams;
  const view = sp.view === 'table' ? 'table' : 'picture';
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : 'activity';
  const bundle = await loadReportBundle(user, sp);
  const { today, range, podId, foUserId, pods, users, reports, previous, campaigns, scope } = bundle;
  const query = (patch: Record<string, string | null | undefined>) => {
    const params = new URLSearchParams({ view, tab, from: range.from, to: range.to });
    params.set('pod', podId ?? '');
    params.set('fo', foUserId ?? '');
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined) params.delete(k); else params.set(k, v); }
    return `/reports?${params.toString()}`;
  };
  const exportHref = `/reports/export?${new URLSearchParams({ from: range.from, to: range.to, pod: podId ?? '', fo: foUserId ?? '' }).toString()}`;
  const presets = [
    { label: 'This week', from: addDays(today, -6), to: today },
    { label: '4 weeks', from: addDays(today, -27), to: today },
    { label: 'Quarter', from: addDays(today, -90), to: today },
  ];

  return (
    <PageFrame className="space-y-5 px-6 pb-8 pt-2">
      <Surface>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="tab" value={tab} />
          <Field label="From" className="min-w-[145px]"><input type="date" name="from" defaultValue={range.from} required /></Field>
          <Field label="Through" className="min-w-[145px]"><input type="date" name="to" defaultValue={range.to} required /></Field>
          <Field label="Pod" className="min-w-[150px]"><select name="pod" defaultValue={podId ?? ''}><option value="">All visible pods</option>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="FO" className="min-w-[150px]"><select name="fo" defaultValue={foUserId ?? ''}><option value="">All visible FOs</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          <button type="submit" className="btn-primary">Apply</button>
          <span className="flex flex-wrap gap-1.5">{presets.map((p) => <Link key={p.label} href={query({ from: p.from, to: p.to })} className={range.from === p.from && range.to === p.to ? 'chip' : 'chip-muted'}>{p.label}</Link>)}</span>
          <span className="ml-auto flex items-center gap-2">
            <span className="inline-flex overflow-hidden rounded-lg border border-line text-[12.5px]">
              <Link href={query({ view: 'picture' })} className={`px-3 py-1.5 ${view === 'picture' ? 'bg-brand-600 text-white' : 'bg-white text-ink-700 hover:bg-canvas'}`} aria-current={view === 'picture' ? 'page' : undefined}>Picture</Link>
              <Link href={query({ view: 'table' })} className={`px-3 py-1.5 ${view === 'table' ? 'bg-brand-600 text-white' : 'bg-white text-ink-700 hover:bg-canvas'}`} aria-current={view === 'table' ? 'page' : undefined}>Table</Link>
            </span>
            <a href={exportHref} target="_blank" rel="noreferrer" className="btn-secondary">Export report</a>
          </span>
        </form>
        {range.error ? <div className="mt-3"><Notice tone="error">{range.error}</Notice></div> : null}
      </Surface>

      {view === 'picture' ? (
        <ReportDocument reports={reports} previous={previous} range={{ from: range.from, to: range.to }} scope={scope} campaigns={campaigns} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ['New enrollments', reports.totals.enrollments, previous.totals.enrollments],
              ['Touches completed', reports.totals.tasksDone, previous.totals.tasksDone],
              ['Replies', reports.totals.replied, previous.totals.replied],
              ['Meetings', reports.totals.meeting, previous.totals.meeting],
            ].map(([label, value, before]) => (
              <div key={String(label)} className="surface px-5 py-5">
                <div className="text-[11px] font-medium text-ink-500">{label}</div>
                <div className={`mt-3 text-[30px] font-semibold leading-tight tracking-[-0.04em] tabular-nums ${value === 0 ? 'text-ink-400' : 'text-ink-900'}`}>{Number(value).toLocaleString('en-US')}</div>
                <div className="mt-1"><Delta current={Number(value)} previous={Number(before)} /></div>
              </div>
            ))}
          </div>
          <Surface flush>
            <ViewHeader title="Performance" meta={<span className="text-[12px] text-ink-500">against {formatLocalDate(bundle.previousRange.from)} → {formatLocalDate(bundle.previousRange.to)}</span>} />
            <Tabs inset={false} current={tab} tabs={TABS.map((t) => ({ ...t, href: query({ tab: t.key }) }))} />
            {tab === 'activity' ? (
              reports.activity.length ? (
                <div className="overflow-x-auto scroll-thin">
                  <table className="table table-dense data-table">
                    <thead><tr><th>FO</th><th>Email</th><th>Calls</th><th>Answered calls</th><th>LinkedIn</th><th>Replies</th><th>Meetings</th><th>Touches</th></tr></thead>
                    <tbody>{reports.activity.map((row) => {
                      const before = previous.activity.find((b) => b.id === row.id)?.period;
                      return (
                        <tr key={row.id}>
                          <td><div className="flex items-center gap-2.5"><Avatar name={row.name} shape="circle" size={28} /><span className="whitespace-nowrap font-medium text-ink-900">{row.name}</span></div></td>
                          <td><Count value={row.period.emails} /></td><td><Count value={row.period.calls} /></td><td><Count value={row.period.answered} /></td><td><Count value={row.period.linkedin} /></td><td><Count value={row.period.replies} /></td><td><Count value={row.period.meetings} /></td>
                          <td><span className="inline-flex items-center gap-2"><Count value={row.period.total} />{before ? <Delta current={row.period.total} previous={before.total} /> : null}</span></td>
                        </tr>
                      );
                    })}</tbody>
                  </table>
                </div>
              ) : <EmptyState icon={<IconReports size={20} />} title="No results in this period" />
            ) : null}
            {tab === 'pods' ? <GroupTable rows={reports.byPod} previous={previous.byPod} first="Pod" /> : null}
            {tab === 'fos' ? <GroupTable rows={reports.byFo} previous={previous.byFo} first="FO" /> : null}
            {tab === 'campaigns' ? <GroupTable rows={reports.byCampaign} previous={previous.byCampaign} first="Campaign" /> : null}
            {tab === 'sequences' ? <GroupTable rows={reports.bySequence} previous={previous.bySequence} first="Sequence" /> : null}
            {tab === 'channels' ? (
              <div className="overflow-x-auto scroll-thin"><table className="table table-dense data-table">
                <thead><tr><th>Channel</th><th>Scheduled</th><th>Completed</th><th>Confirmed by CRM</th><th>Logged by FO</th><th>Skipped</th><th>Cancelled</th></tr></thead>
                <tbody>{reports.channels.map((channel) => { const b = previous.channels.find((x) => x.action === channel.action); return <tr key={channel.action}><td>{channel.label}</td><td><Count value={channel.pending} /></td><td><span className="inline-flex items-center gap-2"><Count value={channel.done} />{b ? <Delta current={channel.done} previous={b.done} /> : null}</span></td><td><Count value={channel.observed} /></td><td><Count value={channel.manual} /></td><td><Count value={channel.skipped} /></td><td><Count value={channel.cancelled} /></td></tr>; })}</tbody>
              </table></div>
            ) : null}
          </Surface>
        </>
      )}
    </PageFrame>
  );
}
