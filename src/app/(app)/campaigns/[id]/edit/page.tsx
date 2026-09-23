import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth/current-user';
import { canManageCampaigns, canApproveCampaign } from '@/lib/auth/rbac';
import { campaignWorkspaceData } from '@/lib/campaign-workspace-data';
import { CampaignWorkspace } from '@/components/campaigns/campaign-workspace';
import type { CampaignDraft } from '@/lib/campaign-planner';
import { defaultTwentySchema } from '@/lib/twenty/twenty-schema';
import { parseSteps } from '@/lib/sequences/steps';
import { addDays } from '@/lib/dates';

export default async function EditCampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ add?: string }> }) {
  const user = await requireUser(), { id } = await params;
  const c = await prisma.campaign.findUnique({ where: { id }, include: { sequence: true, _count: { select: { enrollments: true } } } });
  if (!c) notFound();
  if (!canManageCampaigns(user, c.podId) || !['DRAFT', 'SCHEDULED', 'PENDING_APPROVAL'].includes(c.status) || c._count.enrollments) redirect(`/campaigns/${id}`);
  const data = await campaignWorkspaceData(user);
  // A published campaign keeps the owner's request beside the plan; the editor reopens the request.
  const saved = c.plannerDraft as (CampaignDraft & { request?: CampaignDraft }) | null;
  const draft = saved ? { ...(saved.request ?? saved) } : null;
  const extra = (await searchParams).add?.split(',').filter(Boolean) ?? [];
  if (draft && extra.length) draft.personIds = [...new Set([...draft.personIds, ...extra])];
  return <div className="px-4 py-5 sm:px-6"><CampaignWorkspace status={c.status} canPublish={!c.followupSourceId || canApproveCampaign(user, c.podId)} campaignId={id} revision={c.updatedAt.toISOString()} pods={data.pods} products={[...defaultTwentySchema.personValues.productInterest]} initial={draft ?? {
    name: c.name, podId: c.podId, startDate: c.startDate, endDate: c.endDate ?? addDays(c.startDate, 42), productInterest: c.productInterest,
    defaultBatchSize: c.startsPerFoPerDay ?? 20, fos: [], personIds: c.personIds, assignments: {}, flows: [{ id: 'default', name: 'Default', steps: parseSteps(c.sequence.steps) }], outreachEdited: true,
  }} /></div>;
}
