import { DeleteCampaign } from './delete-campaign';
import { todayIn } from '@/lib/dates';
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

export function PlannedCampaignDetail({ campaign: c, manager, people, q = '', launchError, canDelete = false, addFo }: {
  campaign: Campaign; manager: boolean; people: CampaignPeoplePage; q?: string; canDelete?: boolean; launchError?: string | null; addFo?: ReactNode;
}) {
  const draft = c.plannerDraft as CampaignDraft;
  const plan = c.publishedPlan as unknown as PublishedCalendar | null;
  const editable = ['DRAFT', 'SCHEDULED', 'PENDING_APPROVAL'].includes(c.status) && !people.launched;
  const { completedSteps: completed, late, replies, meetings } = people.stats;
  const pageHref = (page: number) => { const p = new URLSearchParams(); if (q) p.set('q', q); if (page > 1) p.set('page', String(page)); const s = p.toString(); return `/campaigns/${c.id}${s ? `?${s}` : ''}`; };
  const first = (people.page - 1) * CAMPAIGN_PEOPLE_PAGE + 1, last = Math.min(people.page * CAMPAIGN_PEOPLE_PAGE, people.total);
  return <div className="space-y-5 px-4 py-5 sm:px-6">
    <header className="rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 via-white to-violet-50 p-6"><div className="flex flex-wrap items-center justify-between gap-4"><div><Link href="/campaigns" className="text-sm font-medium text-brand-700">← Campaigns</Link><h1 className="mt-3 text-2xl font-semibold">{c.name}</h1><div className="mt-3"><Badge tone={c.status === 'ACTIVE' ? 'green' : 'blue'}>{campaignStatusLabel(c.status)}</Badge></div></div><div className="flex flex-wrap gap-2">{manager && editable && <Link className="btn-primary" href={`/campaigns/${c.id}/edit`}>Edit campaign</Link>}{canDelete && <DeleteCampaign id={c.id} name={c.name} simple={!people.launched} />}{manager && ['STOPPED', 'COMPLETED'].includes(c.status) && <Link className="btn-primary" href={`/campaigns/new?restart=${c.id}`}>Plan another run</Link>}{manager && c.status !== 'PENDING_APPROVAL' && <CampaignLifecycle campaignId={c.id} status={c.status} />}</div></div><div className="mt-5 flex flex-wrap gap-6 text-sm"><div><span className="block text-xs text-ink-500">Starts</span><strong>{calendarDateLabel(c.startDate)}</strong></div><div><span className="block text-xs text-ink-500">Ends</span><strong>{calendarDateLabel(c.endDate!)}</strong></div><div><span className="block text-xs text-ink-500">Outreach groups</span><strong>{draft.flows.length}</strong></div></div></header>
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
