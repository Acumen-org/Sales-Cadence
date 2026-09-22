import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canEnroll } from '@/lib/auth/rbac';
import { campaignWorkspaceData } from '@/lib/campaign-workspace-data';
import { addDays, todayIn } from '@/lib/dates';
import { defaultTwentySchema } from '@/lib/twenty/twenty-schema';
import { CampaignWorkspace } from '@/components/campaigns/campaign-workspace';
import { prisma } from '@/lib/db';
import { canManageCampaigns } from '@/lib/auth/rbac';
import type { CampaignDraft } from '@/lib/campaign-planner';
import { diffDays } from '@/lib/dates';

export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<{ ids?: string; restart?: string }> }) {
  const user = await requireUser();
  if (!canEnroll(user)) redirect('/campaigns');
  const { ids, restart } = await searchParams;
  const data = await campaignWorkspaceData(user);
  const today = todayIn(user.timezone);
  if (restart) {
    const source = await prisma.campaign.findUnique({ where: { id: restart } });
    if (source?.plannerDraft && canManageCampaigns(user, source.podId) && ['STOPPED', 'COMPLETED'].includes(source.status)) {
      const previous = source.plannerDraft as CampaignDraft;
      const initial = { ...previous, name: `${source.name} - next run`.slice(0, 120), startDate: today, endDate: addDays(today, diffDays(previous.startDate, previous.endDate)), personIds: source.personIds, assignments: Object.fromEntries(Object.entries(previous.assignments).filter(([id]) => source.personIds.includes(id))) };
      return <div className="px-4 py-5 sm:px-6"><CampaignWorkspace pods={data.pods} products={[...defaultTwentySchema.personValues.productInterest]} initial={initial} /></div>;
    }
    redirect('/campaigns');
  }
  return <div className="px-4 py-5 sm:px-6"><CampaignWorkspace pods={data.pods} products={[...defaultTwentySchema.personValues.productInterest]} initial={{
    name: '', podId: data.pods[0]?.id ?? '', startDate: today, endDate: addDays(today, 42), defaultBatchSize: 20,
    fos: [], productInterest: [], personIds: [...new Set(ids?.split(',').filter(Boolean) ?? [])], assignments: {},
    flows: [{ id: 'default', name: 'Default', steps: data.defaultSteps }],
  }} /></div>;
}
