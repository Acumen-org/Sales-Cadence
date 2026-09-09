import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canEnroll, toActor, visiblePodIds } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { todayIn } from '@/lib/dates';
import { env } from '@/lib/env';
import { getSettings } from '@/lib/settings';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { CampaignForm } from '@/components/campaigns/campaign-form';
import { PageHeader } from '@/components/ui';

export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const user = await requireUser();
  if (!canEnroll(toActor(user))) redirect('/campaigns');
  const { ids } = await searchParams;
  const initialIds = ids ? ids.split(',').map((s) => s.trim()).filter(Boolean).join('\n') : '';
  const podIds = visiblePodIds(user);
  const [sequences, pods, settings] = await Promise.all([
    prisma.sequence.findMany({ where: { archived: false }, orderBy: { name: 'asc' } }),
    prisma.pod.findMany({ where: podIds === null ? {} : { id: { in: podIds } }, orderBy: { name: 'asc' } }),
    getSettings(),
  ]);
  const mockViews = env().TWENTY_MODE === 'mock' ? getMockTwentyClient().views.map((v) => ({ id: v.id, name: v.name })) : undefined;
  return (
    <>
      <PageHeader title="New campaign" subtitle="Choose the sequence, the pod and the people. Conflicts are shown before anything is created." />
      <div className="max-w-4xl p-6">
        <CampaignForm
          sequences={sequences.map((s) => ({ id: s.id, name: s.name }))}
          pods={pods.map((p) => ({ id: p.id, name: p.name, podOwnerValue: p.podOwnerValue }))}
          defaultStartDate={todayIn(user.timezone)}
          defaultRamp={settings.rules.defaultDailyRampPerFo}
          mockViews={mockViews}
          initialIds={initialIds}
        />
      </div>
    </>
  );
}
