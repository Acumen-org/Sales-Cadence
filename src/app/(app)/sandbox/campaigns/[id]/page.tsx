import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';

/**
 * A cold campaign has the campaign page every campaign has (B134): stats, per-contact actions, edit
 * and delete. An old link to its separate page lands there.
 */
export default async function SandboxCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  redirect(`/campaigns/${id}`);
}
