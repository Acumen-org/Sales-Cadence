import { PageFrame } from '@/components/page-frame';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canViewReports, toActor } from '@/lib/auth/rbac';
import { addDays, workWeekRange } from '@/lib/dates';
import { loadReportBundle } from '@/lib/reports-bundle';
import { reportingTimezone } from '@/lib/reports-query';
import { REPORT_DOCUMENT_STYLES } from '@/lib/report-export-styles';
import { Notice, Surface, ViewHeader } from '@/components/ui';
import { BreakdownSwitch } from '@/components/reports/breakdown-switch';
import { ReportToolbar } from '@/components/reports/report-toolbar';
import { BREAKDOWNS, BreakdownTable, ReportDocument, type BreakdownKey } from '@/components/reports/report-document';

/**
 * One page for one period: what was sent, what came back and the meetings, beside the period
 * before; outreach over time, by channel and by product; then the breakdown by FO, campaign, pod
 * and channel. The range presets are the ones a leader actually asks for; weeks run Monday to
 * Sunday, as on Home.
 */
type Search = { tab?: string; from?: string; to?: string; pod?: string; fo?: string };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  if (!canViewReports(toActor(user))) redirect('/tasks');
  const sp = await searchParams;
  // Old links: the retired views fall back to the FO table.
  const tab: BreakdownKey = BREAKDOWNS.some((b) => b.key === sp.tab) ? (sp.tab as BreakdownKey) : 'fos';
  const bundle = await loadReportBundle(user, sp);
  const { today, range, podId, foUserId, pods, users, reports, previous, campaigns, scope } = bundle;
  const query = (patch: Record<string, string | null | undefined>) => {
    const params = new URLSearchParams({ tab, from: range.from, to: range.to });
    params.set('pod', podId ?? '');
    params.set('fo', foUserId ?? '');
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined) params.delete(k); else params.set(k, v); }
    return `/reports?${params.toString()}`;
  };
  const exportHref = `/reports/export?${new URLSearchParams({ from: range.from, to: range.to, pod: podId ?? '', fo: foUserId ?? '' }).toString()}`;
  const week = workWeekRange(today, reportingTimezone());
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

  return (
    <PageFrame className="space-y-5 px-6 pb-8 pt-2">
      <style dangerouslySetInnerHTML={{ __html: REPORT_DOCUMENT_STYLES }} />
      <Surface>
        <ReportToolbar presets={presets} range={{ from: range.from, to: range.to }} pod={podId ?? ''} fo={foUserId ?? ''} pods={pods} users={users} tab={tab} exportHref={exportHref} />
        {range.error ? <div className="mt-3"><Notice tone="error">{range.error}</Notice></div> : null}
      </Surface>

      <ReportDocument reports={reports} previous={previous} range={{ from: range.from, to: range.to }} compared={bundle.previousRange} scope={scope} campaigns={campaigns} breakdown={
        <Surface flush>
          <ViewHeader title="Breakdown" />
          <BreakdownSwitch initial={tab} panels={BREAKDOWNS.map((b) => ({ key: b.key, label: b.label, href: query({ tab: b.key }), node: <BreakdownTable tab={b.key} reports={reports} previous={previous} /> }))} />
        </Surface>
      } />
    </PageFrame>
  );
}
