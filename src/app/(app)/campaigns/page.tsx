import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { canEnroll, toActor } from '@/lib/auth/rbac';
import { listCampaigns } from '@/lib/campaigns-query';
import { formatLocalDate } from '@/lib/dates';
import { IconCampaigns, IconPlus } from '@/components/icons';
import { Badge, CAMPAIGN_TONE, EmptyState, IdentityCell, StatusDot, Surface, ViewHeader } from '@/components/ui';

const pct = (n: number) => `${Math.round(n * 100)}%`;

export default async function CampaignsPage() {
  const user = await requireUser();
  const campaigns = await listCampaigns(user);
  const mayCreate = canEnroll(toActor(user));
  return (
    <div className="px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader
          title="All campaigns"
          caret
          meta={`${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'}`}
          actions={
            mayCreate ? (
              <Link href="/campaigns/new" className="btn-secondary btn-sm">
                <IconPlus size={13} /> New campaign
              </Link>
            ) : null
          }
        />
        {campaigns.length === 0 ? (
          <EmptyState
            icon={<IconCampaigns size={20} />}
            title="No campaigns yet"
            hint={mayCreate ? 'Create one from pasted person ids, a CSV export or a saved Twenty view.' : 'Your pod has no campaigns yet.'}
            action={
              mayCreate ? (
                <Link href="/campaigns/new" className="btn-primary">
                  <IconPlus size={15} /> New campaign
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="overflow-x-auto scroll-thin">
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
                      <IdentityCell
                        name={c.name}
                        href={`/campaigns/${c.id}`}
                        sub={`${c.sourceType === 'TWENTY_VIEW' ? 'Twenty view' : c.sourceType === 'CSV' ? 'CSV' : 'ids'} · ${c.assignmentMode === 'OWNER' ? 'by owner' : 'round robin'}${c.dailyRampPerFo ? ` · ramp ${c.dailyRampPerFo}/day` : ''}`}
                      />
                    </td>
                    <td>
                      <Badge tone={CAMPAIGN_TONE[c.status] ?? 'gray'} dot>
                        {c.status.toLowerCase()}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap text-[12.5px]">{c.podName}</td>
                    <td className="max-w-[12rem] truncate text-[12.5px]">{c.sequenceName}</td>
                    <td className="whitespace-nowrap text-[12.5px]">{formatLocalDate(c.startDate)}</td>
                    <td>{c.counts.total}</td>
                    <td>
                      <StatusDot tone={c.counts.active + c.counts.paused ? 'green' : 'gray'}>{c.counts.active + c.counts.paused} Active</StatusDot>
                    </td>
                    <td>{c.counts.replied}</td>
                    <td>{c.counts.meeting}</td>
                    <td className="font-medium text-ink-900">{pct(c.replyRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>
    </div>
  );
}
