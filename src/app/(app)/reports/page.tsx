import { PageFrame } from '@/components/page-frame';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canAttachCalls, canViewReports, toActor } from '@/lib/auth/rbac';
import { addDays, startOfLocalDay, workWeekRange } from '@/lib/dates';
import { loadReportBundle } from '@/lib/reports-bundle';
import { REPORT_AUDIENCES, reportingTimezone } from '@/lib/reports-query';
import { reportsHref, type ReportParams } from '@/lib/report-keys';
import { REPORT_DOCUMENT_STYLES } from '@/lib/report-export-styles';
import { Notice, Surface, Tabs, ViewHeader } from '@/components/ui';
import { BreakdownSwitch } from '@/components/reports/breakdown-switch';
import { ReportToolbar } from '@/components/reports/report-toolbar';
import { BREAKDOWNS, BreakdownTable, ReportDocument, type BreakdownKey } from '@/components/reports/report-document';
import { CallsDocument } from '@/components/reports/calls-report';
import { AssignCallRep, AttachCallContact, NewColdContactFromCall } from '@/components/calls/unmatched-controls';
import { callReport } from '@/lib/calls/analytics';
import { prisma } from '@/lib/db';

/**
 * One page for one period and one audience (PLAN 6: All outreach · CRM · Cold outreach): what was
 * sent, what came back and the meetings, beside the period before; outreach over time, by channel
 * and by product; then the breakdown by FO, campaign, pod and channel. The Calls view follows the
 * same audience, and so does the export (B041, B125). The range presets are the ones a leader
 * actually asks for; weeks run Monday to Sunday, as on Home.
 */
type Search = { tab?: string; from?: string; to?: string; pod?: string; fo?: string; view?: string; audience?: string; page?: string; upage?: string };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  if (!canViewReports(toActor(user))) redirect('/tasks');
  const sp = await searchParams;
  // Old links: the retired views fall back to the FO table.
  const tab: BreakdownKey = BREAKDOWNS.some((b) => b.key === sp.tab) ? (sp.tab as BreakdownKey) : 'fos';
  const view = sp.view === 'calls' ? 'calls' : 'outreach';
  const bundle = await loadReportBundle(user, sp);
  const { today, range, podId, foUserId, pods, users, reports, previous, campaigns, scope, audience } = bundle;
  const tz = reportingTimezone();
  const instant = (d: string) => startOfLocalDay(d, tz);
  const mayAttach = canAttachCalls(toActor(user));
  const [calls, reps] = await Promise.all([
    view === 'calls' ? callReport({ from: instant(range.from), to: instant(addDays(range.to, 1)), podId, foUserId, audience, previous: { from: instant(bundle.previousRange.from), to: instant(addDays(bundle.previousRange.to, 1)) }, page: Number(sp.page) || 1, unmatchedPage: Number(sp.upage) || 1 }) : Promise.resolve(null),
    // B127: a call is given only to an active sales rep.
    view === 'calls' && mayAttach ? prisma.user.findMany({ where: { active: true, role: { in: ['JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'] } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : Promise.resolve([]),
  ]);
  const params: ReportParams = { tab, from: range.from, to: range.to, pod: podId ?? '', fo: foUserId ?? '', view, audience };
  const query = (patch: Partial<ReportParams>) => reportsHref(params, patch);
  const exportHref = reportsHref(params, {}, '/reports/export');
  const week = workWeekRange(today, tz);
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const presets = [
    { label: 'This week', from: week.from, to: today },
    { label: 'Last week', from: addDays(week.from, -7), to: addDays(week.from, -1) },
    { label: 'This month', from: monthStart, to: today },
    { label: 'Last month', from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd },
    // The default window, so it is always one click away.
    { label: '4 weeks', from: addDays(today, -27), to: today },
    { label: '90 days', from: addDays(today, -89), to: today },
  ].map((p) => ({ ...p, href: query({ from: p.from, to: p.to }) }));
  const audiences = REPORT_AUDIENCES.map((a) => ({ ...a, href: query({ audience: a.key }) }));
  const callsQuery = (patch: { page?: number; upage?: number }) => `${query({})}${patch.page ? `&page=${patch.page}` : ''}${patch.upage ? `&upage=${patch.upage}` : ''}`;

  return (
    <PageFrame className="space-y-5 px-6 pb-8 pt-2">
      <style dangerouslySetInnerHTML={{ __html: REPORT_DOCUMENT_STYLES }} />
      <Surface>
        <ReportToolbar presets={presets} audiences={audiences} params={params} pods={pods} users={users} exportHref={exportHref} />
        {range.error ? <div className="mt-3"><Notice tone="error">{range.error}</Notice></div> : null}
      </Surface>

      <Surface flush><Tabs inset={false} current={view} tabs={[{ key: 'outreach', label: 'Outreach', href: query({ view: 'outreach' }) }, { key: 'calls', label: 'Calls', href: query({ view: 'calls' }) }]} /></Surface>

      {calls ? <CallsDocument data={calls} timezone={user.timezone} compared={bundle.previousRange} links={{ call: (id) => `/calls/${id}`, page: callsQuery }}
        unmatchedControls={mayAttach ? (c) => ({
          rep: <AssignCallRep callId={c.id} reps={reps} />,
          contact: <div className="space-y-1"><AttachCallContact callId={c.id} candidates={(c.candidates as { kind: string; id: string; name: string }[] | null) ?? []} /><NewColdContactFromCall callId={c.id} /></div>,
        }) : null} /> : null}
      {view === 'outreach' ? <ReportDocument reports={reports} previous={previous} range={{ from: range.from, to: range.to }} compared={bundle.previousRange} scope={scope} campaigns={campaigns} breakdown={
        <Surface flush>
          <ViewHeader title="Breakdown" />
          <BreakdownSwitch initial={tab} panels={BREAKDOWNS.map((b) => ({ key: b.key, label: b.label, href: query({ tab: b.key }), node: <BreakdownTable tab={b.key} reports={reports} previous={previous} /> }))} />
        </Surface>
      } /> : null}
    </PageFrame>
  );
}
