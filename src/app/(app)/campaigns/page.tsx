import { PageFrame } from '@/components/page-frame';
import { requireUser } from '@/lib/auth/current-user';
import { CampaignsScreen, type CampaignsSearch } from '@/components/campaigns/campaigns-screen';

/** Campaigns lists CRM campaigns; Cold outreach > Campaigns is the same screen for cold ones (PLAN 4.4). */
export default async function CampaignsPage({ searchParams }: { searchParams: Promise<CampaignsSearch> }) {
  const user = await requireUser();
  const sp = await searchParams;
  return (
    <PageFrame className="space-y-3 px-6 pb-8 pt-2">
      <CampaignsScreen user={user} sp={sp} audience="CRM" title="All campaigns" base="/campaigns" newHref="/campaigns/new" />
    </PageFrame>
  );
}
