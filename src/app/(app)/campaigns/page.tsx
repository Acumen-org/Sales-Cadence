import { requireUser } from '@/lib/auth/current-user';
import { EmptyState, PageHeader } from '@/components/ui';

export default async function CampaignsPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Campaigns" subtitle="A sequence applied to a set of people in a pod." />
      <EmptyState title="No campaigns yet" hint="Campaign creation, conflict preview and funnels arrive in phase 5." />
    </>
  );
}
