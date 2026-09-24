import { DeleteCampaign } from './delete-campaign';
import { todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import Link from 'next/link';
import type { Campaign, Enrollment, PersonCache, Task, User } from '@prisma/client';
import type { CampaignDraft } from '@/lib/campaign-planner';
import type { PublishedCalendar } from '@/lib/campaign-planning-service';
import { calendarDateLabel } from '@/lib/campaign-planner';
import { CampaignCalendarView } from './campaign-calendar';
import { CampaignLifecycle, CampaignControls } from './campaign-controls';
import { Badge, Stat } from '@/components/ui';
import { cachedPersonName } from '@/lib/person-cache';

export function PlannedCampaignDetail({ campaign: c, manager, enrollments, launchError, admin = false }: {
  campaign: Campaign; manager: boolean; admin?: boolean; launchError?: string | null;
  enrollments: (Enrollment & { person: PersonCache; fo: User; tasks: Task[] })[];
}) {
  const draft = c.plannerDraft as CampaignDraft;
  const plan = c.publishedPlan as unknown as PublishedCalendar | null;
  const editable = ['DRAFT', 'SCHEDULED', 'PENDING_APPROVAL'].includes(c.status) && !enrollments.length;
  const completed = new Set(enrollments.flatMap(e => {
    const done: string[] = [];
    for (const step of new Set(e.tasks.map(t => t.stepId))) if (e.tasks.filter(t => t.stepId === step).every(t => t.state === 'DONE')) done.push(`${e.id}:${step}`);
    return done;
  })).size;
  const late = enrollments.filter(e => e.tasks.some(t => t.state === 'PENDING' && t.dueDate < todayIn(workspaceTimezone()))).length;
  return <div className="space-y-5 px-4 py-5 sm:px-6">
    <header className="rounded-2xl border border-brand-200 bg-gradient-to-br from-brand-50 via-white to-violet-50 p-6"><div className="flex flex-wrap items-center justify-between gap-4"><div><Link href="/campaigns" className="text-sm font-medium text-brand-700">← Campaigns</Link><h1 className="mt-3 text-2xl font-semibold">{c.name}</h1><div className="mt-3"><Badge tone={c.status === 'ACTIVE' ? 'green' : 'blue'}>{c.status.replace(/_/g, ' ')}</Badge></div></div><div className="flex flex-wrap gap-2">{manager && editable && <Link className="btn-primary" href={`/campaigns/${c.id}/edit`}>Edit campaign</Link>}{admin && ['STOPPED', 'COMPLETED', 'DRAFT'].includes(c.status) && <DeleteCampaign id={c.id} name={c.name} />}{manager && ['STOPPED', 'COMPLETED'].includes(c.status) && <Link className="btn-primary" href={`/campaigns/new?restart=${c.id}`}>Plan another run</Link>}{manager && c.status !== 'PENDING_APPROVAL' && <CampaignLifecycle campaignId={c.id} status={c.status} />}</div></div><div className="mt-5 flex flex-wrap gap-6 text-sm"><div><span className="block text-xs text-ink-500">Starts</span><strong>{calendarDateLabel(c.startDate)}</strong></div><div><span className="block text-xs text-ink-500">Ends</span><strong>{calendarDateLabel(c.endDate!)}</strong></div><div><span className="block text-xs text-ink-500">Outreach groups</span><strong>{draft.flows.length}</strong></div></div></header>
    {launchError && <div role="alert" className="rounded-xl border-l-4 border-amber-500 bg-amber-50 p-5"><h2 className="font-semibold">Cadence planner · launch needs attention</h2><p className="mt-2 text-sm">{launchError}</p>{manager && editable && <Link href={`/campaigns/${c.id}/edit`} className="btn-secondary mt-3">Review campaign</Link>}</div>}
    {late > 0 && <div role="status" className="rounded-xl border-l-4 border-amber-500 bg-amber-50 p-5"><strong>{late} people have overdue touchpoints</strong><p className="mt-1 text-sm">Their next touchpoint waits for the current one. Published dates remain visible; missed work is not silently moved into another batch.</p></div>}
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="People" value={c.personIds.length} /><Stat label="Steps completed" value={completed} /><Stat label="Replies" value={enrollments.filter(e => e.repliedAt).length} /><Stat label="Meetings" value={enrollments.filter(e => e.meetingAt).length} /></div>
    {plan ? <section className="surface p-5"><CampaignCalendarView draft={draft} calendar={plan} /><p className="mt-4 text-sm text-ink-600">Published schedule. Replies, opt-outs and removals stop further outreach; they do not create replacement tasks.</p></section> : <div className="surface p-6"><h2 className="font-semibold">This draft has not been published</h2><p className="mt-2 text-sm text-ink-600">Review the calendar to check coverage before outreach begins.</p></div>}
    {manager && enrollments.length > 0 && <CampaignControls calendar campaignId={c.id} status={c.status} sequences={[]} currentSequenceId={c.sequenceId} defaultName={`${c.name} - follow-up`} today={todayIn(workspaceTimezone())} />}
    {enrollments.length > 0 && <section className="surface overflow-hidden"><h2 className="p-5 font-semibold">People and progress</h2><div className="overflow-x-auto"><table className="table"><thead><tr><th>Person</th><th>FO</th><th>Outreach</th><th>Progress</th><th>Status</th></tr></thead><tbody>{enrollments.map(e => {
      const flow = draft.flows.find(f => f.id === (draft.assignments[e.personId] ?? 'default'))!;
      return <tr key={e.id}><td><Link href={`/people/${e.personId}`} className="font-medium">{cachedPersonName(e.person)}</Link></td><td>{e.fo.name}</td><td>{flow.name}</td><td><strong>{Math.max(0, e.currentStep + 1)}</strong> / <strong>{flow.steps.length}</strong></td><td><Badge>{e.status.replace(/_/g, ' ')}</Badge></td></tr>;
    })}</tbody></table></div></section>}
  </div>;
}
