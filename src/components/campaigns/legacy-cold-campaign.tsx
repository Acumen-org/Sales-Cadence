import Link from 'next/link';
import type { Campaign } from '@prisma/client';
import { prisma } from '@/lib/db';
import { formatLocalDate, todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { campaignStatusLabel } from '@/lib/campaign-status';
import { coldAudienceIssues } from '@/lib/sandbox/campaigns';
import { COLD_CAMPAIGNS_HREF, coldRef, personRef, subjectHref } from '@/lib/subject';
import { Badge, CAMPAIGN_TONE, Card, Count, Empty, RecordHeader, Stat, enrollmentStatusLabel, enrollmentTone } from '@/components/ui';
import { IconCampaigns } from '@/components/icons';
import { CampaignLifecycle } from './campaign-controls';
import { DeleteCampaign } from './delete-campaign';
import { EnrollmentActions } from './enrollment-actions';
import { ColdCampaignNotes } from './cold-campaign-notes';

/**
 * A cold campaign made before the campaign studio (PLAN 4.4, 9.7 step 14): it has no calendar, so it
 * shows here, on the campaign page, until it ends. The same header, stats, per-contact actions, stop
 * and delete as any campaign (B134); its contacts link to their own pages (8.13), a first step still
 * ahead reads Scheduled and Next step is the earliest open one (B198). It takes no new contacts.
 */
export async function LegacyColdCampaign({ campaign, manager, editor, canDelete, timezone }: { campaign: Campaign & { pod: { name: string }; sequence: { name: string } }; manager: boolean; editor: boolean; canDelete: boolean; timezone: string }) {
  const today = todayIn(workspaceTimezone());
  const enrollments = await prisma.enrollment.findMany({
    where: { campaignId: campaign.id },
    include: { fo: { select: { name: true } }, sandboxContact: { select: { id: true, firstName: true, lastName: true, companyName: true } }, tasks: { where: { state: 'PENDING' }, orderBy: [{ dueDate: 'asc' }, { stepIndex: 'asc' }, { actionIndex: 'asc' }], take: 1, select: { label: true, dueDate: true, snoozedTo: true } } },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
  });
  const launched = enrollments.length > 0;
  const [contacts, issues, done] = await Promise.all([
    launched ? Promise.resolve([]) : prisma.sandboxContact.findMany({ where: { id: { in: campaign.personIds } }, include: { owner: { select: { name: true, active: true } } }, orderBy: [{ sortName: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }] }),
    launched ? Promise.resolve([]) : coldAudienceIssues(campaign.personIds, { podId: campaign.podId, podName: campaign.pod.name, foIds: [], campaignId: campaign.id, anyPod: true }),
    launched ? prisma.task.count({ where: { state: 'DONE', enrollment: { campaignId: campaign.id } } }) : Promise.resolve(0),
  ]);
  const skipped = new Map(issues.map((i) => [i.id, i.reason]));
  const name = (c: { firstName: string; lastName: string } | null) => (c ? `${c.firstName} ${c.lastName}`.trim() || 'Removed contact' : 'Removed contact');
  const replied = enrollments.filter((e) => e.repliedAt).length;
  const meetings = enrollments.filter((e) => e.meetingAt).length;
  return <div className="space-y-5 px-6 pb-8 pt-2">
    <RecordHeader
      name={campaign.name}
      icon={<IconCampaigns size={20} />}
      sub={<span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]"><Link href={COLD_CAMPAIGNS_HREF} className="hover:text-ink-900">Cold outreach · Campaigns</Link><span className="text-ink-300">·</span><span>{campaign.pod.name}</span><span className="text-ink-300">·</span><span>{campaign.sequence.name}</span><span className="text-ink-300">·</span><span>Starts {formatLocalDate(campaign.startDate, 'long')}</span></span>}
      badges={<><Badge tone={CAMPAIGN_TONE[campaign.status] ?? 'gray'}>{campaignStatusLabel(campaign.status)}</Badge><Badge tone="gray">Made before the campaign studio</Badge></>}
      actions={<>{editor && campaign.status === 'DRAFT' && <Link href={`/campaigns/${campaign.id}/edit`} className="btn-primary">Open in the studio</Link>}{manager && <CampaignLifecycle campaignId={campaign.id} status={campaign.status} />}{manager && ['STOPPED', 'COMPLETED'].includes(campaign.status) && <Link className="btn-secondary" href={`/campaigns/new?restart=${campaign.id}`}>Plan another run</Link>}{canDelete && <DeleteCampaign id={campaign.id} name={campaign.name} simple={!launched} />}</>}
    />
    <ColdCampaignNotes campaign={campaign} launched={launched} timezone={timezone} />
    {launched ? <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5"><Stat label="Contacts" value={enrollments.length} /><Stat label="Running" value={enrollments.filter((e) => e.status === 'ACTIVE' || e.status === 'PAUSED').length} /><Stat label="Steps done" value={done} /><Stat label="Replies" value={replied} tone="good" /><Stat label="Meetings" value={meetings} tone="good" /></div>
      <Card title={`Contacts · ${enrollments.length.toLocaleString('en-US')}`}>
        <div className="overflow-x-auto"><table className="table table-dense"><thead><tr><th>Contact</th><th>FO</th><th>Starts</th><th>Status</th><th>Next step</th>{manager && <th>Manage</th>}</tr></thead><tbody>{enrollments.map((e) => {
          const scheduled = e.status === 'ACTIVE' && e.currentStep < 0 && e.startDate > today;
          const next = e.tasks[0];
          const href = e.personId ? subjectHref(personRef(e.personId)) : e.sandboxContactId ? subjectHref(coldRef(e.sandboxContactId)) : null;
          return <tr key={e.id}>
            <td>{href ? <Link href={href} className="text-[13px] font-medium text-ink-900 hover:text-brand-700">{name(e.sandboxContact)}</Link> : name(e.sandboxContact)}{e.sandboxContact?.companyName ? <div className="text-[12px] text-ink-500">{e.sandboxContact.companyName}</div> : null}</td>
            <td className="text-[12.5px]">{e.fo.name}</td>
            <td className="whitespace-nowrap text-[12.5px] tabular-nums">{formatLocalDate(e.startDate)}</td>
            <td><Badge tone={scheduled ? 'purple' : enrollmentTone(e)}>{scheduled ? 'Scheduled' : enrollmentStatusLabel(e)}</Badge></td>
            <td className="text-[12.5px] text-ink-700">{next ? `${next.label} · ${formatLocalDate(next.snoozedTo ?? next.dueDate)}` : <Empty />}</td>
            {manager && <td><EnrollmentActions enrollmentId={e.id} status={e.status} foUserId={e.foUserId} fos={[]} compact /></td>}
          </tr>;
        })}</tbody></table></div>
      </Card>
    </> : <Card title={<>Contacts · <Count value={contacts.length} /></>}>
      {contacts.length ? <div className="overflow-x-auto"><table className="table table-dense"><thead><tr><th>Contact</th><th>Firm</th><th>Owner</th><th>On launch</th></tr></thead><tbody>{contacts.map((c) => <tr key={c.id}>
        <td><Link href={subjectHref(coldRef(c.id))} className="text-[13px] font-medium text-ink-900 hover:text-brand-700">{name(c)}</Link></td>
        <td className="text-[12.5px]">{c.companyName ?? <Empty />}</td>
        <td className="text-[12.5px]">{c.owner?.active ? c.owner.name : <span className="text-amber-800">Unclaimed</span>}</td>
        <td>{skipped.has(c.id) ? <Badge tone="amber">{`Will be left out: ${skipped.get(c.id)}`}</Badge> : <Badge tone="green">Starts</Badge>}</td>
      </tr>)}</tbody></table></div> : <p className="px-5 py-4 text-sm text-ink-500">Nobody is in this campaign.</p>}
    </Card>}
  </div>;
}
