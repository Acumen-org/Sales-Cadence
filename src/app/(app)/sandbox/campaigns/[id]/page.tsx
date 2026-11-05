import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { canApproveCampaign, canManageCampaigns } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { formatLocalDate } from '@/lib/dates';
import { ActionButton } from '@/components/action-form';
import { Badge, CAMPAIGN_TONE, EmptyState, Surface, ViewHeader, enrollmentStatusLabel, enrollmentTone } from '@/components/ui';
import { approveCampaignAction, pauseCampaignAction, resumeCampaignAction, stopCampaignAction } from '@/lib/actions/campaigns';

/** A sandbox campaign: the engine's campaign, its sandbox contacts, who works each and where they are. */
export default async function SandboxCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { sequence: { select: { name: true } }, pod: { select: { name: true } } } });
  if (!campaign) notFound();
  if (campaign.audience !== 'SANDBOX') redirect(`/campaigns/${id}`);
  const actor = toActor(user);
  const [enrollments, contacts] = await Promise.all([
    prisma.enrollment.findMany({ where: { campaignId: id }, include: { fo: { select: { name: true } }, sandboxContact: { select: { id: true, firstName: true, lastName: true, companyName: true } }, tasks: { where: { state: 'PENDING' }, select: { label: true, dueDate: true }, take: 1 } }, orderBy: [{ startDate: 'asc' }, { id: 'asc' }] }),
    campaign.status === 'ACTIVE' || campaign.status === 'COMPLETED' || campaign.status === 'STOPPED' ? Promise.resolve([]) : prisma.sandboxContact.findMany({ where: { id: { in: campaign.personIds } }, select: { id: true, firstName: true, lastName: true, companyName: true, owner: { select: { name: true } } } }),
  ]);
  const manage = canManageCampaigns(actor, campaign.podId);
  const payload = { campaignId: id };
  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    <Surface flush>
      <ViewHeader
        title={campaign.name}
        meta={<span className="flex items-center gap-2 text-ink-500"><Badge tone={CAMPAIGN_TONE[campaign.status] ?? 'gray'}>{campaign.status.replace(/_/g, ' ').toLowerCase()}</Badge>{campaign.pod.name} · {campaign.sequence.name} · starts {formatLocalDate(campaign.startDate, 'long')}</span>}
        actions={<div className="flex gap-2">
          {campaign.status === 'PENDING_APPROVAL' && canApproveCampaign(actor, campaign.podId) ? <ActionButton action={approveCampaignAction} payload={payload} refresh className="btn-primary btn-sm">Approve</ActionButton> : null}
          {manage && (campaign.status === 'ACTIVE' || campaign.status === 'SCHEDULED') ? <ActionButton action={pauseCampaignAction} payload={payload} refresh>Pause</ActionButton> : null}
          {manage && campaign.status === 'PAUSED' ? <ActionButton action={resumeCampaignAction} payload={payload} refresh>Resume</ActionButton> : null}
          {manage && ['ACTIVE', 'PAUSED', 'SCHEDULED', 'PENDING_APPROVAL'].includes(campaign.status) ? <ActionButton action={stopCampaignAction} payload={payload} refresh confirm="Stop this campaign? Its open steps are cancelled." className="btn-ghost btn-sm">Stop</ActionButton> : null}
        </div>}
      />
      <div className="px-4 py-2 text-[13px] text-ink-500"><Link href="/sandbox?tab=campaigns" className="hover:text-ink-700">Sandbox campaigns</Link></div>
    </Surface>
    <Surface flush>
      {enrollments.length ? <table className="w-full text-[13px]"><thead><tr className="border-b border-line text-left text-ink-500"><th className="px-4 py-2 font-normal">Contact</th><th className="px-4 py-2 font-normal">FO</th><th className="px-4 py-2 font-normal">Started</th><th className="px-4 py-2 font-normal">Status</th><th className="px-4 py-2 font-normal">Next step</th></tr></thead>
        <tbody className="divide-y divide-line">{enrollments.map((e) => <tr key={e.id}>
          <td className="px-4 py-2">{e.sandboxContact ? <Link href={e.personId ? `/people/${e.personId}` : `/sandbox/${e.sandboxContact.id}`} className="text-ink-900 hover:text-brand-700">{`${e.sandboxContact.firstName} ${e.sandboxContact.lastName}`.trim() || 'Contact'}</Link> : '-'}<span className="text-ink-500">{e.sandboxContact?.companyName ? ` · ${e.sandboxContact.companyName}` : ''}</span></td>
          <td className="px-4 py-2">{e.fo.name}</td>
          <td className="px-4 py-2 tabular-nums">{formatLocalDate(e.startDate)}</td>
          <td className="px-4 py-2"><Badge tone={enrollmentTone(e)}>{enrollmentStatusLabel(e)}</Badge></td>
          <td className="px-4 py-2 text-ink-600">{e.tasks[0] ? `${e.tasks[0].label} · ${formatLocalDate(e.tasks[0].dueDate)}` : '-'}</td>
        </tr>)}</tbody></table>
        : contacts.length ? <table className="w-full text-[13px]"><thead><tr className="border-b border-line text-left text-ink-500"><th className="px-4 py-2 font-normal">Contact</th><th className="px-4 py-2 font-normal">Firm</th><th className="px-4 py-2 font-normal">Owner</th></tr></thead>
          <tbody className="divide-y divide-line">{contacts.map((c) => <tr key={c.id}><td className="px-4 py-2"><Link href={`/sandbox/${c.id}`} className="text-ink-900 hover:text-brand-700">{`${c.firstName} ${c.lastName}`.trim()}</Link></td><td className="px-4 py-2">{c.companyName ?? '-'}</td><td className="px-4 py-2">{c.owner?.name ?? 'Unclaimed'}</td></tr>)}</tbody></table>
        : <EmptyState title="Nobody in this campaign" />}
    </Surface>
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
