import { DeleteCampaign } from '@/components/campaigns/delete-campaign';
import { PlannedCampaignDetail } from '@/components/campaigns/planned-campaign-detail';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canManageCampaigns, canApproveCampaign, canDeleteCampaign, canSeeAllPods } from '@/lib/auth/rbac';
import { campaignDetail, touchesPerPerson } from '@/lib/campaigns-query';
import { campaignPeoplePage } from '@/lib/campaign-people-page';
import { addFoCandidates, addFoWindow } from '@/lib/campaign-add-fo';
import { AddFoPanel } from '@/components/campaigns/add-fo-panel';
import type { CampaignDraft } from '@/lib/campaign-planner';
import { prisma } from '@/lib/db';
import { addDays, diffDays, formatLocalDate, todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { cachedPersonName } from '@/lib/person-cache';
import { planCampaignCapacity } from '@/lib/engine/capacity';
import { previewEnrollment, type EnrollConflict } from '@/lib/engine/enrollment';
import { userActor } from '@/lib/audit';
import { optionLabel } from '@/lib/twenty/labels';
import { campaignStatusLabel, enrollConflictLabel } from '@/lib/campaign-status';
import { CampaignControls, CampaignLifecycle, HardStopToggle } from '@/components/campaigns/campaign-controls';
import { EnrollmentActions } from '@/components/campaigns/enrollment-actions';
import { IconCampaigns } from '@/components/icons';
import { Badge, CAMPAIGN_TONE, Card, Count, ENROLLMENT_TONE, Empty, RecordHeader, Stat, enrollmentStatusLabel } from '@/components/ui';

const AUDIENCE_PAGE = 50;

/**
 * One campaign: its window drawn as a bar with today on it, what happened inside that window,
 * who is in it (a page at a time), and how each FO's room is being used.
 */
export default async function CampaignDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string; q?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const today = todayIn(user.timezone);
  const detail = await campaignDetail(id, today);
  if (!detail) notFound();
  const { campaign, history, summary, byStep, byFo, podFos, enrollments } = detail;
  if (!canSeeAllPods(user) && !user.podIds.includes(campaign.podId)) redirect('/campaigns');
  const manager = canManageCampaigns(user, campaign.podId);
  if (campaign.plannerDraft) {
    const people = await campaignPeoplePage(campaign, sp.page, sp.q);
    // On the start day of a running campaign, the pod's leaders can still bring in a new FO.
    // Rendered all start day, even once nobody is left to add, so the last "joined" message stays.
    const joinable = manager && addFoWindow(campaign).open ? await addFoCandidates(id) : null;
    const addFo = joinable ? <AddFoPanel campaignId={id} campaignName={campaign.name} podId={campaign.podId} candidates={joinable.map((f) => ({ id: f.id, name: f.name }))} defaultPace={(campaign.plannerDraft as unknown as CampaignDraft).defaultBatchSize || 10} today={todayIn(workspaceTimezone())} /> : undefined;
    const failed = campaign.status === 'SCHEDULED' ? await prisma.auditLog.findFirst({ where: { entityType: 'campaign', entityId: id, action: 'launch_failed' }, orderBy: { createdAt: 'desc' } }) : null;
    const launchError = failed?.details && typeof failed.details === 'object' && 'error' in failed.details ? String(failed.details.error) : null;
    return <PlannedCampaignDetail canDelete={canDeleteCampaign(user, { status: campaign.status, podId: campaign.podId, everLaunched: people.launched })} campaign={campaign} manager={manager} people={people} q={sp.q ?? ''} launchError={launchError} addFo={addFo} />;
  }
  const proposed = ['PENDING_APPROVAL', 'SCHEDULED', 'DRAFT'].includes(campaign.status);
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const q = (sp.q ?? '').trim().toLowerCase();

  // The window and its capacity; for a running campaign, room left from today.
  const windowStart = campaign.endDate && campaign.status === 'ACTIVE' && today > campaign.startDate ? today : campaign.startDate;
  const plan = campaign.endDate ? await planCampaignCapacity({ sequenceId: campaign.sequenceId, podId: campaign.podId, startDate: windowStart, endDate: campaign.endDate, maxRate: campaign.startsPerFoPerDay }) : null;
  const capacity = plan && !('error' in plan) ? plan : null;

  const [sequences, audienceAll, preview, replies, meetings] = await Promise.all([
    prisma.sequence.findMany({ where: { archived: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    proposed ? prisma.personCache.findMany({ where: { id: { in: campaign.personIds } }, orderBy: [{ sortName: { sort: 'asc', nulls: 'last' } }], select: { id: true, firstName: true, lastName: true, companyName: true, email: true } }) : Promise.resolve([]),
    // The same preview the launch will run, so an approver sees who would be left out and why.
    proposed ? previewEnrollment({ personIds: campaign.personIds, sequenceId: campaign.sequenceId, podId: campaign.podId, campaignId: id, startDate: campaign.startDate, assignment: { mode: 'OWNER' }, dailyRampByFo: capacity ? Object.fromEntries(capacity.perFo.map((f) => [f.id, f.rate])) : null, lastStartDate: capacity?.lastStart ?? null, actor: userActor(user) }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })) : Promise.resolve(null),
    // Replies and meetings that happened inside the window, for the people in the campaign.
    enrollments.length ? prisma.touch.count({ where: { direction: 'INBOUND', personId: { in: enrollments.map((e) => e.personId) }, occurredAt: { gte: new Date(`${campaign.startDate}T00:00:00Z`), ...(campaign.endDate ? { lte: new Date(`${addDays(campaign.endDate, 1)}T00:00:00Z`) } : {}) } } }) : Promise.resolve(0),
    enrollments.length ? prisma.meeting.count({ where: { attendees: { some: { personId: { in: enrollments.map((e) => e.personId) } } }, occurredAt: { gte: new Date(`${campaign.startDate}T00:00:00Z`), ...(campaign.endDate ? { lte: new Date(`${addDays(campaign.endDate, 1)}T00:00:00Z`) } : {}) } } }) : Promise.resolve(0),
  ]);
  const previewError = preview && 'error' in preview ? preview.error : campaign.sequence.archived ? 'The sequence is archived; restore it or pick another before launch.' : null;
  const ready = preview && !('error' in preview) ? preview : null;
  const conflictFor = new Map<string, EnrollConflict>((ready?.conflicts ?? []).map((c) => [c.personId, c]));
  const foFor = new Map<string, string>((ready?.candidates ?? []).map((c) => [c.personId, c.foName]));

  // Audience, paginated and searchable, before launch; enrollment history after.
  const audienceFiltered = audienceAll.filter((p) => !q || `${cachedPersonName(p)} ${p.companyName ?? ''} ${p.email ?? ''}`.toLowerCase().includes(q));
  const audiencePages = Math.max(1, Math.ceil(audienceFiltered.length / AUDIENCE_PAGE));
  const audience = audienceFiltered.slice((page - 1) * AUDIENCE_PAGE, page * AUDIENCE_PAGE);
  const historyFiltered = history.filter((e) => !q || `${cachedPersonName(e.person)} ${e.person.companyName ?? ''}`.toLowerCase().includes(q));
  const historyPages = Math.max(1, Math.ceil(historyFiltered.length / AUDIENCE_PAGE));
  const historyPage = historyFiltered.slice((page - 1) * AUDIENCE_PAGE, page * AUDIENCE_PAGE);
  const pageHref = (n: number) => `/campaigns/${id}?${new URLSearchParams({ ...(q ? { q } : {}), page: String(n) }).toString()}`;

  // The bar: start, last start, today, end.
  const total = campaign.endDate ? diffDays(campaign.startDate, campaign.endDate) + 1 : null;
  const dayOf = (d: string) => diffDays(campaign.startDate, d) + 1;
  const todayDay = dayOf(today);
  const pct = (d: number) => (total ? Math.min(100, Math.max(0, Math.round(((d - 1) / Math.max(1, total - 1)) * 100))) : 0);
  const ranOver = campaign.endDate && campaign.endDate < today ? enrollments.filter((e) => e.status === 'ACTIVE' || e.status === 'PAUSED').length : 0;
  // This run only, the way the list counts it. Somebody live owes the whole sequence; somebody
  // finished owes what was generated before they finished; before launch, everyone on the list owes it all.
  const touchesDone = enrollments.reduce((n, e) => n + e.tasks.filter((t) => t.state === 'DONE').length, 0);
  const perPerson = touchesPerPerson(campaign.sequence.steps);
  const touchesPlanned = proposed
    ? campaign.personIds.length * perPerson
    : enrollments.reduce((n, e) => n + (e.status === 'ACTIVE' || e.status === 'PAUSED' ? perPerson : e.tasks.filter((t) => t.state === 'DONE' || t.state === 'SKIPPED').length), 0);

  return (
    <div className="space-y-5 px-6 pb-8 pt-2">
      <RecordHeader
        name={campaign.name}
        icon={<IconCampaigns size={20} />}
        sub={<span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]"><span>{campaign.pod.name}</span><span className="text-ink-300">·</span><Link href={`/sequences/${campaign.sequenceId}`} className="text-brand-700 hover:underline">{campaign.sequence.name}</Link>{campaign.productInterest.length ? <><span className="text-ink-300">·</span><span>{campaign.productInterest.map(optionLabel).join(', ')}</span></> : null}</span>}
        badges={<><Badge tone={CAMPAIGN_TONE[campaign.status] ?? 'gray'}>{campaignStatusLabel(campaign.status)}</Badge>{ranOver ? <Badge tone="amber">{ranOver} ran over</Badge> : null}{campaign.hardStopAtEnd ? <Badge tone="gray">Stops at end date</Badge> : null}</>}
        actions={<>{manager && ['DRAFT','SCHEDULED','PENDING_APPROVAL'].includes(campaign.status) && !history.length && <Link href={`/campaigns/${id}/edit`} className="btn-primary">Edit campaign</Link>}{manager && <CampaignLifecycle campaignId={id} status={campaign.status} canApprove={canApproveCampaign(user, campaign.podId)} />}{canDeleteCampaign(user, { status: campaign.status, podId: campaign.podId, everLaunched: history.length > 0 }) && <DeleteCampaign id={id} name={campaign.name} simple={!history.length && ['DRAFT', 'PENDING_APPROVAL'].includes(campaign.status)} />}<Link href="/campaigns" className="btn-ghost btn-sm">All campaigns</Link></>}
      />

      {/* The window. */}
      <div className="surface px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3 text-[12.5px] text-ink-600">
          <span><span className="font-medium text-ink-900">{formatLocalDate(campaign.startDate, 'long')}</span>{campaign.endDate ? <> → <span className="font-medium text-ink-900">{formatLocalDate(campaign.endDate, 'long')}</span> · {total} days</> : null}</span>
          {total ? <span>{todayDay < 1 ? `Starts in ${1 - todayDay} days` : todayDay > total ? `Ended ${todayDay - total} days ago` : <>Day <span className="font-medium tabular-nums text-ink-900">{todayDay}</span> of {total}</>}</span> : null}
        </div>
        {total ? (
          <div className="relative mt-3 h-2 w-full rounded-full bg-ink-100">
            <div className="absolute inset-y-0 left-0 rounded-full bg-brand-500" style={{ width: `${pct(Math.min(todayDay, total))}%` }} />
            {todayDay >= 1 && todayDay <= total ? <div className="absolute -top-1.5 h-5 w-0.5 bg-ink-900" style={{ left: `${pct(todayDay)}%` }} title="Today" /> : null}
          </div>
        ) : null}
        {total ? <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-500"><span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-brand-500" />elapsed</span><span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-ink-900" />today</span></div> : null}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="People" value={proposed ? campaign.personIds.length : summary.counts.total} />
        <Stat label="Started" value={summary.counts.total} />
        <Stat label="Touches done" value={touchesDone} hint={touchesPlanned ? <>of <span className="font-medium text-ink-900">{touchesPlanned.toLocaleString('en-US')}</span> planned</> : undefined} />
        <Stat label="Replies in window" value={replies} tone="good" />
        <Stat label="Meetings in window" value={meetings} tone="good" />
        <Stat label="Reply rate" value={summary.counts.total ? `${Math.round(summary.replyRate * 100)}%` : '0%'} />
      </div>

      {campaign.description ? <div className="surface px-5 py-4 text-[13px] text-ink-700 whitespace-pre-wrap">{campaign.description}</div> : null}

      {capacity ? (
        <Card title={campaign.status === 'ACTIVE' ? 'Room left in the window' : 'Room in the window'} actions={manager && campaign.endDate ? <HardStopToggle campaignId={id} on={campaign.hardStopAtEnd} /> : undefined}>
          {capacity.tooShort ? <div className="px-5 py-4 text-[13px] text-red-700">The sequence spans {capacity.durationDays} days; nobody can finish it before {formatLocalDate(campaign.endDate!)}.</div> : (
            <div className="overflow-x-auto"><table className="table table-dense"><thead><tr><th>FO</th><th className="num">Starts a day</th><th className="num">Daily cap</th><th className="num">{campaign.status === 'ACTIVE' ? 'Room left' : 'Capacity'}</th><th className="num">In this campaign</th></tr></thead><tbody>
              {capacity.perFo.map((f) => <tr key={f.id}><td className="text-[13px]">{f.name}</td><td className="num"><Count value={f.rate} /></td><td className="num"><Count value={f.cap} /></td><td className="num"><Count value={f.capacity} /></td><td className="num"><Count value={byFo.find((b) => b.id === f.id)?.total ?? 0} /></td></tr>)}
              <tr><td className="text-[13px] font-medium">Pod</td><td /><td /><td className="num font-medium"><Count value={capacity.total} /></td><td className="num font-medium"><Count value={summary.counts.total} /></td></tr>
            </tbody></table></div>
          )}
        </Card>
      ) : null}

      {manager && <CampaignControls campaignId={id} status={campaign.status} sequences={sequences} currentSequenceId={campaign.sequenceId} defaultName={campaign.name + ' — follow-up'} today={today} />}

      {proposed && audienceAll.length > 0 ? (
        <Card title={`Audience · ${audienceAll.length.toLocaleString('en-US')}`} actions={<span className="flex items-center gap-2 text-[12px] text-ink-500">{previewError ? <Badge tone="red">Preview unavailable</Badge> : ready ? <><Badge tone="green">{ready.candidates.length} will start</Badge>{ready.conflicts.length ? <Badge tone="amber">{ready.conflicts.length} skipped</Badge> : null}</> : null}</span>}>
          {previewError ? <div className="border-b border-line px-5 py-3 text-[13px] text-red-700">{previewError}</div> : null}
          {ready?.warnings.length ? <div className="border-b border-line px-5 py-3 text-[13px] text-amber-800">{ready.warnings.join(' ')}</div> : null}
          <form className="border-b border-line px-5 py-3"><input name="q" defaultValue={sp.q ?? ''} placeholder="Search the audience" aria-label="Search the audience" className="!w-72" /></form>
          <div className="overflow-x-auto"><table className="table table-dense"><thead><tr><th>Person</th><th>Company</th><th>Email</th><th>FO</th><th>On launch</th></tr></thead><tbody>
            {audience.map((p) => { const c = conflictFor.get(p.id); return <tr key={p.id}><td><Link href={'/people/' + p.id} className="text-[13px] font-medium text-ink-900 hover:text-brand-700">{cachedPersonName(p)}</Link></td><td className="text-[12.5px]">{p.companyName ?? <Empty />}</td><td className="text-[12.5px]">{p.email ?? <Empty />}</td><td className="text-[12.5px]">{foFor.get(p.id) ?? <Empty />}</td><td>{c ? <span className="flex flex-wrap items-center gap-1.5"><Badge tone={c.reason === 'no_room' || c.reason === 'dnd' ? 'red' : 'amber'}>{enrollConflictLabel(c.reason)}</Badge>{c.detail && manager ? <span className="text-[12px] text-ink-500">{c.detail}</span> : null}</span> : ready ? <Badge tone="green">Starts</Badge> : <Empty />}</td></tr>; })}
          </tbody></table></div>
          {audiencePages > 1 ? <div className="flex items-center justify-between border-t border-line px-5 py-3 text-[12.5px] text-ink-500"><span>Page {page} of {audiencePages}</span><span className="flex gap-2">{page > 1 ? <Link href={pageHref(page - 1)} className="btn-secondary btn-sm">Previous</Link> : null}{page < audiencePages ? <Link href={pageHref(page + 1)} className="btn-secondary btn-sm">Next</Link> : null}</span></div> : null}
        </Card>
      ) : null}

      {history.length > 0 && <>
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Step results"><div className="overflow-x-auto"><table className="table table-dense"><thead><tr><th>Day</th><th>Touchpoint</th><th className="num">Reached</th><th className="num">Done</th><th className="num">Replied</th><th className="num">Meetings</th></tr></thead><tbody>{byStep.map((s) => <tr key={s.index}><td className="tabular-nums">{s.day}</td><td className="text-[13px]">{s.label}</td><td className="num"><Count value={s.reached} /></td><td className="num"><Count value={s.done} /></td><td className="num"><Count value={s.replied} /></td><td className="num"><Count value={s.meeting} /></td></tr>)}</tbody></table></div></Card>
          <Card title="Team results"><div className="overflow-x-auto"><table className="table table-dense"><thead><tr><th>FO</th><th className="num">People</th><th className="num">Replied</th><th className="num">Meetings</th><th className="num">Actions done</th></tr></thead><tbody>{byFo.map((f) => <tr key={f.id}><td className="text-[13px]">{f.name}</td><td className="num"><Count value={f.total} /></td><td className="num"><Count value={f.replied} /></td><td className="num"><Count value={f.meeting} /></td><td className="num"><Count value={f.doneTasks} /></td></tr>)}</tbody></table></div></Card>
        </div>
        <Card title={`People in the campaign · ${history.length.toLocaleString('en-US')}`}>
          <form className="border-b border-line px-5 py-3"><input name="q" defaultValue={sp.q ?? ''} placeholder="Search people" aria-label="Search people in the campaign" className="!w-72" /></form>
          <div className="overflow-x-auto"><table className="table table-dense"><thead><tr><th>Person</th><th>FO</th><th>Run</th><th>Status</th><th>Started</th><th>Step</th>{manager && <th>Manage</th>}</tr></thead><tbody>{historyPage.map((e) => <tr key={e.id}><td><Link href={'/people/' + e.personId} className="text-[13px] font-medium text-ink-900 hover:text-brand-700">{cachedPersonName(e.person)}</Link></td><td className="text-[12.5px]">{e.fo.name}</td><td className="tabular-nums">{e.campaignRun}</td><td><Badge tone={ENROLLMENT_TONE[e.status] ?? 'gray'}>{enrollmentStatusLabel(e)}</Badge></td><td className="whitespace-nowrap text-[12.5px]">{formatLocalDate(e.startDate)}</td><td className="text-[12.5px]">{e.currentStep < 0 ? 'Not started' : `${e.currentStep + 1} of ${detail.steps.length}`}</td>{manager && <td><EnrollmentActions enrollmentId={e.id} status={e.status} foUserId={e.foUserId} fos={podFos} compact /></td>}</tr>)}</tbody></table></div>
          {historyPages > 1 ? <div className="flex items-center justify-between border-t border-line px-5 py-3 text-[12.5px] text-ink-500"><span>Page {page} of {historyPages}</span><span className="flex gap-2">{page > 1 ? <Link href={pageHref(page - 1)} className="btn-secondary btn-sm">Previous</Link> : null}{page < historyPages ? <Link href={pageHref(page + 1)} className="btn-secondary btn-sm">Next</Link> : null}</span></div> : null}
        </Card>
      </>}
    </div>
  );
}
