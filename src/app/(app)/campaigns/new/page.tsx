import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canEnroll, isAdmin, toActor } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { addDays, todayIn } from '@/lib/dates';
import { defaultTwentySchema } from '@/lib/twenty/twenty-schema';
import { CampaignForm } from '@/components/campaigns/campaign-form';
import { PageHeader } from '@/components/ui';

export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const user = await requireUser();
  if (!canEnroll(toActor(user))) redirect('/campaigns');
  const { ids } = await searchParams;
  const initialIds = ids ? ids.split(',').map((s) => s.trim()).filter(Boolean) : [];
  // A campaign is run in a pod, so the choice is the pods this user runs: every pod for an admin,
  // their own for a leader. Reading other pods is allowed everywhere else; starting work in them is not.
  const podIds = isAdmin(user) ? null : user.podIds;
  const [sequences, pods] = await Promise.all([
    prisma.sequence.findMany({ where: { archived: false }, orderBy: { name: 'asc' }, select: { id: true, name: true, durationDays: true, steps: true } }),
    // An archived pod cannot take a campaign, so it is never offered as one.
    prisma.pod.findMany({ where: { archived: false, ...(podIds === null ? {} : { id: { in: podIds } }) }, orderBy: { name: 'asc' } }),
  ]);
  const today = todayIn(user.timezone);
  return (
    <>
      <PageHeader title="New campaign" />
      <div className="px-6 pb-8 pt-2">
        <CampaignForm
          sequences={sequences.map((s) => ({ id: s.id, name: s.name, durationDays: s.durationDays ?? Math.max(1, ...((s.steps as { day?: number }[] | null) ?? []).map((step) => step.day ?? 1)) }))}
          pods={pods.map((p) => ({ id: p.id, name: p.name, podOwnerValue: p.podOwnerValue }))}
          products={[...defaultTwentySchema.personValues.productInterest]}
          defaultStartDate={today}
          defaultEndDate={addDays(today, 42)}
          initialIds={initialIds}
        />
      </div>
    </>
  );
}
