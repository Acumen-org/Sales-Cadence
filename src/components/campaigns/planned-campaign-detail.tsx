import { DeleteCampaign } from './delete-campaign';
import { diffDays, todayIn, type LocalDate } from '@/lib/dates';
import { IconCampaigns } from '@/components/icons';
import { workspaceTimezone } from '@/lib/workspace';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Campaign } from '@prisma/client';
import type { CampaignDraft } from '@/lib/campaign-planner';
import type { PublishedCalendar } from '@/lib/campaign-planning-service';
import { calendarDateLabel } from '@/lib/campaign-planner';
import { CampaignCalendarView } from './campaign-calendar';
import { CampaignLifecycle, CampaignControls } from './campaign-controls';
import { Badge, Stat, enrollmentStatusLabel } from '@/components/ui';
import { CAMPAIGN_PEOPLE_PAGE, type CampaignPeoplePage } from '@/lib/campaign-people-page';
import { campaignStatusLabel } from '@/lib/campaign-status';

const daysLeft = (from: LocalDate, to: LocalDate) => { const n = diffDays(from, to); return `${n} ${n === 1 ? 'day' : 'days'}`; };

export function PlannedCampaignDetail({ campaign: c, manager, people, q = '', launchError, canDelete = false, addFo }: {
  campaign: Campaign; manager: boolean; people: CampaignPeoplePage; q?: string; canDelete?: boolean; launchError?: string | null; addFo?: ReactNode;
}) {
  const draft = c.plannerDraft as CampaignDraft;
  const plan = c.publishedPlan as unknown as PublishedCalendar | null;
  const editable = ['DRAFT', 'SCHEDULED', 'PENDING_APPROVAL'].includes(c.status) && !people.launched;
  const { completedSteps: completed, late, replies, meetings } = people.stats;
  const pageHref = (page: number) => { const p = new URLSearchParams(); if (q) p.set('q', q); if (page > 1) p.set('page', String(page)); const s = p.toString(); return `/campaigns/${c.id}${s ? `?${s}` : ''}`; };
  const today = todayIn(workspaceTimezone());
  // How far through its dates the campaign is, for the bar in the banner.
  const span = c.endDate ? diffDays(c.startDate, c.endDate) + 1 : 0;
  const elapsed = span ? Math.min(1, Math.max(0, (diffDays(c.startDate, today) + 1) / span)) : 0;
  const first = (people.page - 1) * CAMPAIGN_PEOPLE_PAGE + 1, last = Math.min(people.page * CAMPAIGN_PEOPLE_PAGE, people.total);
  return <div className="space-y-5 px-4 py-5 sm:px-6">
    <header className="relative overflow-hidden rounded-2xl bg-[#203e35] p-6 text-white">
      <div className="focus-art" aria-hidden />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/campaigns" className="text-[12.5px] font-medium text-[#c1d4ca] hover:text-white">← Campaigns</Link>
          <p className="mt-4 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-[#d5e9ad]"><IconCampaigns size={13} /> Campaign<span className={`rounded-full px-2 py-0.5 text-[10.5px] normal-case tracking-normal ${c.status === 'ACTIVE' ? 'bg-[#d5e9ad] text-[#203e35]' : 'bg-white/10 text-white'}`}>{campaignStatusLabel(c.status)}</span></p>
          <h1 className="mt-2 break-words text-[30px] font-semibold leading-tight tracking-[-0.03em]">{c.name}</h1>
        </div>
        <div className="flex flex-wrap gap-2">{manager && editable && <Link className="btn-primary" href={`/campaigns/${c.id}/edit`}>Edit campaign</Link>}{canDelete && <DeleteCampaign id={c.id} name={c.name} simple={!people.launched} />}{manager && ['STOPPED', 'COMPLETED'].includes(c.status) && <Link className="btn-primary" href={`/campaigns/new?restart=${c.id}`}>Plan another run</Link>}{manager && c.status !== 'PENDING_APPROVAL' && <CampaignLifecycle campaignId={c.id} status={c.status} />}</div>
      </div>
      <div className="relative mt-6 grid gap-4 sm:grid-cols-[repeat(3,minmax(0,auto))_minmax(0,1fr)] sm:items-end sm:gap-8">
        <div><span className="block text-[11px] uppercase tracking-[0.08em] text-[#c1d4ca]">Starts</span><span className="text-[15px] font-medium">{calendarDateLabel(c.startDate)}</span></div>
        <div><span className="block text-[11px] uppercase tracking-[0.08em] text-[#c1d4ca]">Ends</span><span className="text-[15px] font-medium">{calendarDateLabel(c.endDate!)}</span></div>
        <div><span className="block text-[11px] uppercase tracking-[0.08em] text-[#c1d4ca]">Outreach groups</span><span className="text-[15px] font-medium tabular-nums">{draft.flows.length}</span></div>
        {c.endDate ? <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-2 text-[12px] text-[#c1d4ca]"><span>{today < c.startDate ? `Starts in ${daysLeft(today, c.startDate)}` : today > c.endDate ? 'Finished' : `Day ${diffDays(c.startDate, today) + 1} of ${span}`}</span>{today >= c.startDate && today <= c.endDate ? <span className="tabular-nums">{daysLeft(today, c.endDate)} left</span> : null}</div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-[#d5e9ad]" style={{ width: `${Math.round(elapsed * 100)}%` }} /></div>
        </div> : null}
      </div>
    </header>
    {launchError && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-semibold">Cadence planner · launch needs attention</h2><p className="mt-2 text-sm">{launchError}</p>{manager && editable && <Link href={`/campaigns/${c.id}/edit`} className="btn-secondary mt-3">Review campaign</Link>}</div>}
    {late > 0 && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-5"><p className="font-medium">{late} {late === 1 ? 'person has an overdue step' : 'people have overdue steps'}</p></div>}
    {people.launched && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="People" value={people.total} /><Stat label="Steps completed" value={completed} /><Stat label="Replies" value={replies} /><Stat label="Meetings" value={meetings} /></div>}
    {addFo}
    {plan && <section className="surface p-5"><CampaignCalendarView draft={draft} calendar={plan} /></section>}
    {manager && people.launched && people.stats.finished > 0 && <CampaignControls calendar campaignId={c.id} status={c.status} sequences={[]} currentSequenceId={c.sequenceId} defaultName={`${c.name} - follow-up`} today={todayIn(workspaceTimezone())} />}
    {(people.total > 0 || q) && <section className="surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 p-5"><h2 className="font-semibold">{people.launched ? 'People and progress' : 'People'} <span className="font-normal tabular-nums text-ink-500">{people.total.toLocaleString('en-US')}</span></h2><form><input name="q" defaultValue={q} placeholder="Search people" aria-label="Search people in the campaign" className="!w-72" /></form></div>
      {people.rows.length ? <div className="overflow-x-auto"><table className="table"><thead><tr><th>Person</th><th>FO</th><th>Outreach</th>{people.launched && <><th>Progress</th><th>Status</th></>}</tr></thead><tbody>{people.rows.map(r => {
        const flow = draft.flows.find(f => f.id === r.flowId) ?? draft.flows[0];
        return <tr key={r.id}><td><Link href={`/people/${r.personId}`} className="font-medium">{r.name}</Link>{r.company ? <div className="text-[12px] text-ink-500">{r.company}</div> : null}</td><td>{r.fo ?? '–'}</td><td>{flow.name}</td>{people.launched && <><td className="tabular-nums">{r.step} of {flow.steps.length}</td><td><Badge>{r.status ? enrollmentStatusLabel({ status: r.status, exitReason: r.exitReason }) : ''}</Badge></td></>}</tr>;
      })}</tbody></table></div> : <p className="px-5 pb-5 text-sm text-ink-500">Nobody matches “{q}”.</p>}
      {people.pages > 1 ? <div className="flex items-center justify-between border-t border-line px-5 py-3 text-[12.5px] text-ink-500"><span className="tabular-nums">{first.toLocaleString('en-US')}–{last.toLocaleString('en-US')} of {people.total.toLocaleString('en-US')}</span><span className="flex items-center gap-2"><span className="tabular-nums">Page {people.page} of {people.pages}</span>{people.page > 1 ? <Link href={pageHref(people.page - 1)} className="btn-secondary btn-sm" scroll={false}>Previous</Link> : null}{people.page < people.pages ? <Link href={pageHref(people.page + 1)} className="btn-secondary btn-sm" scroll={false}>Next</Link> : null}</span></div> : null}
    </section>}
  </div>;
}
