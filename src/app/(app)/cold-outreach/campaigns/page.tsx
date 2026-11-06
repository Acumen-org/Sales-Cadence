import { PageFrame } from '@/components/page-frame';
import { requireUser } from '@/lib/auth/current-user';
import { COLD_CAMPAIGNS_HREF } from '@/lib/subject';
import { CampaignsScreen, type CampaignsSearch } from '@/components/campaigns/campaigns-screen';
import { ColdOutreachHeader } from '@/components/sandbox/section-tabs';

export const metadata = { title: 'Campaigns · Cold outreach' };

/** Cold outreach > Campaigns: the Campaigns screen for cold campaigns, with its tabs, filters and New campaign (B134, B200). */
export default async function ColdCampaignsPage({ searchParams }: { searchParams: Promise<CampaignsSearch> }) {
  const user = await requireUser();
  const sp = await searchParams;
  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    <ColdOutreachHeader user={user} current="campaigns" />
    <CampaignsScreen user={user} sp={sp} audience="SANDBOX" title="Cold campaigns" base={COLD_CAMPAIGNS_HREF} newHref="/campaigns/new?audience=cold" />
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
