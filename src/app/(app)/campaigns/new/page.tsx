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
import { workspaceTimezone } from '@/lib/workspace';

export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<{ ids?: string; restart?: string }> }) {
  const user = await requireUser();
  if (!canEnroll(user)) redirect('/campaigns');
  const { ids, restart } = await searchParams;
  const data = await campaignWorkspaceData(user);
  // The studio and the planner read the same clock: the workspace's.
  const today = todayIn(workspaceTimezone());
  if (restart) {
    const source = await prisma.campaign.findUnique({ where: { id: restart } });
    if (source?.plannerDraft && canManageCampaigns(user, source.podId) && ['STOPPED', 'COMPLETED'].includes(source.status)) {
      const saved = source.plannerDraft as CampaignDraft & { request?: CampaignDraft };
      const previous = saved.request ?? saved;
      // The next run asks again for everyone the last one was asked for; the planner rechecks them.
      const removed = new Set(saved.personIds.filter(id => !source.personIds.includes(id)));
      const personIds = saved.request ? previous.personIds.filter(id => !removed.has(id)) : source.personIds;
      const initial = { ...previous, name: `${source.name} - next run`.slice(0, 120), startDate: today, endDate: addDays(today, diffDays(previous.startDate, previous.endDate)), personIds, assignments: Object.fromEntries(Object.entries(previous.assignments).filter(([id]) => personIds.includes(id))), foAssignments: undefined, outreachEdited: previous.outreachEdited ?? true };
      return <div className="px-4 py-5 sm:px-6"><CampaignWorkspace today={today} pods={data.pods} products={[...defaultTwentySchema.personValues.productInterest]} initial={initial} /></div>;
    }
    redirect('/campaigns');
  }
  return <div className="px-4 py-5 sm:px-6"><CampaignWorkspace today={today} pods={data.pods} products={[...defaultTwentySchema.personValues.productInterest]} initial={{
    name: '', podId: data.pods[0]?.id ?? '', startDate: today, endDate: addDays(today, 42), defaultBatchSize: 20,
    fos: [], productInterest: [], personIds: [...new Set(ids?.split(',').filter(Boolean) ?? [])], assignments: {},
    flows: [{ id: 'default', name: 'Default', steps: data.defaultSteps }], outreachEdited: false,
  }} /></div>;
}
