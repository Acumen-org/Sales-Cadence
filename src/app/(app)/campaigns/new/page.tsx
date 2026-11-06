import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canCreateCampaign } from '@/lib/auth/rbac';
import { campaignWorkspaceData } from '@/lib/campaign-workspace-data';
import { addDays, todayIn } from '@/lib/dates';
import { defaultTwentySchema } from '@/lib/twenty/twenty-schema';
import { CampaignWorkspace } from '@/components/campaigns/campaign-workspace';
import { ActiveSection } from '@/components/active-section';
import { ColdOutreachTabs, seesPushes } from '@/components/sandbox/section-tabs';
import { prisma } from '@/lib/db';
import { canManageCampaigns } from '@/lib/auth/rbac';
import type { CampaignDraft } from '@/lib/campaign-planner';
import { diffDays } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { COLD_CAMPAIGNS_HREF, COLD_CONTACT_BASE } from '@/lib/subject';

/**
 * The campaign studio. `?audience=cold` makes a cold campaign (PLAN 4.4): Cold outreach's New
 * campaign and Start campaign open it so; the Campaigns section's New campaign never does. A
 * campaign's kind is fixed from here on (B045).
 */
export async function generateMetadata({ searchParams }: { searchParams: Promise<{ audience?: string }> }) {
  return { title: (await searchParams).audience === 'cold' ? 'New campaign · Campaigns · Cold outreach' : 'New campaign · Campaigns' };
}

export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<{ ids?: string; restart?: string; audience?: string }> }) {
  const user = await requireUser();
  if (!canCreateCampaign(user)) redirect('/campaigns');
  const { ids, restart, audience: asked } = await searchParams;
  const data = await campaignWorkspaceData(user);
  // The studio and the planner read the same clock: the workspace's.
  const today = todayIn(workspaceTimezone());
  const studio = (audience: 'CRM' | 'SANDBOX', initial: CampaignDraft) => {
    const cold = audience === 'SANDBOX';
    return <div className="px-4 py-5 sm:px-6">
      {cold && <><ActiveSection href={COLD_CONTACT_BASE} /><div className="mb-4 surface"><ColdOutreachTabs current="campaigns" pushes={seesPushes(user)} /></div></>}
      <CampaignWorkspace today={today} pods={data.pods} products={[...defaultTwentySchema.personValues.productInterest]} initial={initial} audience={audience} {...(cold ? { contactBase: COLD_CONTACT_BASE, section: { label: 'Cold outreach · Campaigns', href: COLD_CAMPAIGNS_HREF } } : {})} />
    </div>;
  };
  if (restart) {
    const source = await prisma.campaign.findUnique({ where: { id: restart } });
    if (source && canManageCampaigns(user, source.podId) && ['STOPPED', 'COMPLETED'].includes(source.status)) {
      if (source.plannerDraft) {
        const saved = source.plannerDraft as CampaignDraft & { request?: CampaignDraft };
        const previous = saved.request ?? saved;
        // The next run asks again for everyone the last one was asked for; the planner rechecks them.
        const removed = new Set(saved.personIds.filter(id => !source.personIds.includes(id)));
        const personIds = saved.request ? previous.personIds.filter(id => !removed.has(id)) : source.personIds;
        return studio(source.audience, { ...previous, name: `${source.name} - next run`.slice(0, 120), startDate: today, endDate: addDays(today, diffDays(previous.startDate, previous.endDate)), personIds, assignments: Object.fromEntries(Object.entries(previous.assignments).filter(([id]) => personIds.includes(id))), foAssignments: undefined, outreachEdited: previous.outreachEdited ?? true });
      }
    }
    redirect('/campaigns');
  }
  return studio(asked === 'cold' ? 'SANDBOX' : 'CRM', {
    name: '', podId: data.pods[0]?.id ?? '', startDate: today, endDate: addDays(today, 42), defaultBatchSize: 20,
    fos: [], productInterest: [], personIds: [...new Set(ids?.split(',').filter(Boolean) ?? [])], assignments: {},
    flows: [{ id: 'default', name: 'Default', steps: data.defaultSteps }], outreachEdited: false,
  });
}
