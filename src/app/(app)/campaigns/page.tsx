import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { canEnroll, toActor } from '@/lib/auth/rbac';
import { listCampaigns } from '@/lib/campaigns-query';
import { Badge, CAMPAIGN_TONE, Card, EmptyState, PageHeader } from '@/components/ui';

const pct = (n: number) => `${Math.round(n * 100)}%`;

export default async function CampaignsPage() {
  const user = await requireUser();
  const campaigns = await listCampaigns(user);
  const mayCreate = canEnroll(toActor(user));
  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle="A sequence applied to a set of people in a pod."
        actions={
          mayCreate ? (
            <Link href="/campaigns/new" className="btn-primary">
              New campaign
            </Link>
          ) : null
        }
      />
      <div className="p-6">
        <Card>
          {campaigns.length === 0 ? (
            <EmptyState title="No campaigns yet" hint={mayCreate ? 'Create one from pasted person ids, a CSV export or a saved Twenty view.' : 'Your pod has no campaigns yet.'} />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Pod</th>
                  <th>Sequence</th>
                  <th>Start</th>
                  <th>People</th>
                  <th>Active</th>
                  <th>Replied</th>
                  <th>Meetings</th>
                  <th>Reply rate</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/campaigns/${c.id}`} className="font-medium text-brand-700 hover:underline">
                        {c.name}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {c.sourceType === 'TWENTY_VIEW' ? 'Twenty view' : c.sourceType === 'CSV' ? 'CSV' : 'ids'} · {c.assignmentMode === 'OWNER' ? 'by owner' : 'round robin'}
                        {c.dailyRampPerFo ? ` · ramp ${c.dailyRampPerFo}/FO/day` : ''}
                      </div>
                    </td>
                    <td>
                      <Badge tone={CAMPAIGN_TONE[c.status] ?? 'gray'}>{c.status.toLowerCase()}</Badge>
                    </td>
                    <td>{c.podName}</td>
                    <td>{c.sequenceName}</td>
                    <td>{c.startDate}</td>
                    <td>{c.counts.total}</td>
                    <td>{c.counts.active + c.counts.paused}</td>
                    <td>{c.counts.replied}</td>
                    <td>{c.counts.meeting}</td>
                    <td>{pct(c.replyRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
