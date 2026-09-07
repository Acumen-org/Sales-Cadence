import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canManageCampaigns, toActor } from '@/lib/auth/rbac';
import { campaignDetail } from '@/lib/campaigns-query';
import { prisma } from '@/lib/db';
import { formatLocalDate, todayIn } from '@/lib/dates';
import { cachedPersonName } from '@/lib/person-cache';
import { CampaignControls } from '@/components/campaigns/campaign-controls';
import { EnrollmentActions } from '@/components/campaigns/enrollment-actions';
import { Badge, CAMPAIGN_TONE, Card, ENROLLMENT_TONE, enrollmentStatusLabel, IdentityCell, RecordHeader, Stat } from '@/components/ui';

const pct = (n: number) => `${Math.round(n * 100)}%`;

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const today = todayIn(user.timezone);
  const detail = await campaignDetail(id, today);
  if (!detail) notFound();
  const { campaign, enrollments, summary, byStep, byFo, podFos } = detail;
  if (!canManageCampaigns(toActor(user), campaign.podId)) redirect('/campaigns');
  const sequences = await prisma.sequence.findMany({ where: { archived: false }, select: { id: true, name: true }, orderBy: { name: 'asc' } });

  return (
    <>
      <div className="px-6 pt-2">
        <RecordHeader
          name={campaign.name}
          shape="square"
          sub={
            <>
              {campaign.pod.name} ·{' '}
              <Link href={`/sequences/${campaign.sequenceId}`} className="text-brand-700 hover:underline">
                {campaign.sequence.name}
              </Link>{' '}
              v{campaign.sequence.activeVersion?.version ?? '-'} · starts {formatLocalDate(campaign.startDate, 'long')} · {campaign.assignmentMode === 'OWNER' ? 'assigned by owner' : 'round robin'}
              {campaign.dailyRampPerFo ? ` · ramp ${campaign.dailyRampPerFo}/FO/day` : ''}
              {campaign.sourceRef ? ` · source: ${campaign.sourceRef}` : ''}
            </>
          }
          badges={
            <Badge tone={CAMPAIGN_TONE[campaign.status] ?? 'gray'} dot>
              {campaign.status.toLowerCase()}
            </Badge>
          }
          actions={
            <Link href="/campaigns" className="btn-secondary btn-sm">
              All campaigns
            </Link>
          }
        />
      </div>
      <div className="space-y-3 px-6 pb-8 pt-3">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="People" value={summary.counts.total} />
          <Stat label="Active" value={summary.counts.active + summary.counts.paused} hint={summary.counts.paused ? `${summary.counts.paused} paused` : undefined} />
          <Stat label="Replied" value={summary.counts.replied} tone="good" />
          <Stat label="Meetings" value={summary.counts.meeting} tone="good" />
          <Stat label="Reply rate" value={pct(summary.replyRate)} hint="replied + meetings / not exited" />
          <Stat label="Meeting rate" value={pct(summary.meetingRate)} />
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <Card title="Funnel by step">
            <table className="table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Reached</th>
                  <th>At step</th>
                  <th>Done</th>
                  <th>Replied</th>
                  <th>Meetings</th>
                  <th>Overdue</th>
                </tr>
              </thead>
              <tbody>
                {byStep.map((s) => (
                  <tr key={s.index}>
                    <td>
                      <span className="text-xs text-ink-400">Day {s.day} · </span>
                      {s.label}
                    </td>
                    <td>{s.reached}</td>
                    <td>{s.active}</td>
                    <td>{s.done}</td>
                    <td>{s.replied}</td>
                    <td>{s.meeting}</td>
                    <td className={s.overdue ? 'font-medium text-red-600' : undefined}>{s.overdue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="By FO">
            <table className="table">
              <thead>
                <tr>
                  <th>FO</th>
                  <th>People</th>
                  <th>Active</th>
                  <th>Replied</th>
                  <th>Meetings</th>
                  <th>Tasks done</th>
                  <th>Overdue</th>
                </tr>
              </thead>
              <tbody>
                {byFo.map((f) => (
                  <tr key={f.id}>
                    <td className="font-medium">{f.name}</td>
                    <td>{f.total}</td>
                    <td>{f.active}</td>
                    <td>{f.replied}</td>
                    <td>{f.meeting}</td>
                    <td>{f.doneTasks}</td>
                    <td className={f.overdue ? 'font-medium text-red-600' : undefined}>{f.overdue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>

        <CampaignControls
          campaignId={campaign.id}
          status={campaign.status}
          sequences={sequences}
          currentSequenceId={campaign.sequenceId}
          defaultName={`${campaign.name} - follow-up`}
          today={today}
        />

        <Card title={`Enrollments (${enrollments.length})`}>
          <table className="table">
            <thead>
              <tr>
                <th>Person</th>
                <th>FO</th>
                <th>Status</th>
                <th>Started</th>
                <th>Step</th>
                <th>Version</th>
                <th>Next / last task</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {enrollments.map((e) => {
                const pending = e.tasks.filter((t) => t.state === 'PENDING').sort((a, b) => (a.snoozedTo ?? a.dueDate).localeCompare(b.snoozedTo ?? b.dueDate));
                const next = pending[0];
                const last = [...e.tasks].filter((t) => t.state !== 'PENDING').sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0];
                return (
                  <tr key={e.id}>
                    <td>
                      <IdentityCell
                        name={cachedPersonName(e.person)}
                        href={`/people/${e.personId}`}
                        shape="circle"
                        size={28}
                        sub={[e.person.jobTitle, e.person.companyName].filter(Boolean).join(' · ') || null}
                      />
                    </td>
                    <td className="whitespace-nowrap">{e.fo.name}</td>
                    <td>
                      <Badge tone={ENROLLMENT_TONE[e.status] ?? 'gray'} dot>
                        {enrollmentStatusLabel(e)}
                      </Badge>
                      {e.exitReason ? <div className="text-xs text-ink-500">{e.exitReason}</div> : null}
                      {e.pauseReason ? <div className="text-xs text-ink-500">{e.pauseReason}</div> : null}
                    </td>
                    <td>{e.startDate}</td>
                    <td>
                      {e.currentStep + 1} / {detail.steps.length}
                      {e.shiftDays ? <div className="text-xs text-ink-500">shifted {e.shiftDays}d</div> : null}
                    </td>
                    <td>v{e.sequenceVersion.version}</td>
                    <td className="text-xs">
                      {next ? (
                        <span className={(next.snoozedTo ?? next.dueDate) < today ? 'text-red-600' : 'text-ink-700'}>
                          {next.label} · {next.snoozedTo ?? next.dueDate}
                        </span>
                      ) : last ? (
                        <span className="text-ink-500">
                          {last.label} · {last.state.toLowerCase()}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>
                      <EnrollmentActions enrollmentId={e.id} status={e.status} foUserId={e.foUserId} fos={podFos} compact />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
