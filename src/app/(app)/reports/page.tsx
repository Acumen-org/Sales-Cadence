import { PageFrame } from '@/components/page-frame';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canViewReports, toActor } from '@/lib/auth/rbac';
import { addDays, startOfWeekSunday } from '@/lib/dates';
import { loadReportBundle } from '@/lib/reports-bundle';
import { Field, Notice, Surface, Tabs, ViewHeader } from '@/components/ui';
import { BREAKDOWNS, BreakdownTable, RATES_NOTE, ReportDocument, type BreakdownKey } from '@/components/reports/report-document';

/**
 * One page for one period: the picture leadership reads and exports, then the breakdown by FO,
 * pod, campaign and channel, each beside the period before. The range presets are the ones a
 * leader actually asks for.
 */
type Search = { tab?: string; from?: string; to?: string; pod?: string; fo?: string };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  if (!canViewReports(toActor(user))) redirect('/tasks');
  const sp = await searchParams;
  // Old links: the FO-and-channel table is now the FO breakdown; the retired views fall back to it.
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
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const presets = [
    { label: 'This week', from: startOfWeekSunday(today), to: today },
    { label: 'This month', from: monthStart, to: today },
    { label: 'Last month', from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd },
    // The default window, so it is always one click away.
    { label: '4 weeks', from: addDays(today, -27), to: today },
    { label: '90 days', from: addDays(today, -89), to: today },
  ];

  return (
    <PageFrame className="space-y-5 px-6 pb-8 pt-2">
      <Surface>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="tab" value={tab} />
          <Field label="From" className="min-w-[145px]"><input type="date" name="from" defaultValue={range.from} required /></Field>
          <Field label="Through" className="min-w-[145px]"><input type="date" name="to" defaultValue={range.to} required /></Field>
          <Field label="Pod" className="min-w-[150px]"><select name="pod" defaultValue={podId ?? ''}><option value="">All pods</option>{pods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="FO" className="min-w-[150px]"><select name="fo" defaultValue={foUserId ?? ''}><option value="">All FOs</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          <button type="submit" className="btn-primary">Apply</button>
          <span className="flex flex-wrap gap-1.5">{presets.map((p) => <Link key={p.label} href={query({ from: p.from, to: p.to })} className={range.from === p.from && range.to === p.to ? 'chip' : 'chip-muted'}>{p.label}</Link>)}</span>
          <a href={exportHref} target="_blank" rel="noreferrer" className="btn-secondary ml-auto">Export report</a>
        </form>
        {range.error ? <div className="mt-3"><Notice tone="error">{range.error}</Notice></div> : null}
      </Surface>

      <ReportDocument reports={reports} previous={previous} range={{ from: range.from, to: range.to }} compared={bundle.previousRange} scope={scope} campaigns={campaigns} breakdown={
        <Surface flush>
          <ViewHeader title="Breakdown" />
          <Tabs inset={false} scroll={false} current={tab} tabs={BREAKDOWNS.map((b) => ({ key: b.key, label: b.label, href: query({ tab: b.key }) }))} />
          <div className="p-4"><BreakdownTable tab={tab} reports={reports} previous={previous} />{tab === 'channels' ? null : <p className="mt-3 text-[12px] text-ink-500">{RATES_NOTE}</p>}</div>
        </Surface>
      } />
    </PageFrame>
  );
}
