import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { SyncNowButton } from '@/components/settings/sync-now-button';
import { listAccounts } from '@/lib/accounts-query';
import { formatInstant } from '@/lib/dates';
import { IconCampaigns } from '@/components/icons';
import { AccountsToolbar } from '@/components/accounts/accounts-toolbar';
import { Badge, Count, Empty, EmptyState, IdentityCell, Stat, StatusDot, Surface, Toolbar, ViewHeader } from '@/components/ui';

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ q?: string; scope?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const scope = sp.scope === 'mine' ? 'mine' : 'all';
  const all = await listAccounts(user, { q });
  const rows = scope === 'mine' ? all.filter((a) => a.mine) : all;
  const mineCount = all.filter((a) => a.mine).length;

  return (
    <div className="space-y-5 px-6 pb-8 pt-2">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Accounts in view" value={rows.length} />
        <Stat label="People" value={rows.reduce((n, a) => n + a.people, 0)} />
        <Stat label="In sequence" value={rows.reduce((n, a) => n + a.inSequence, 0)} />
        <Stat label="Engaged accounts" value={rows.filter((a) => a.replied > 0 || a.meetings > 0).length} tone="good" />
      </div>
      <Surface flush>
        <ViewHeader title={scope === 'mine' ? 'My accounts' : 'All accounts'} caret actions={isAdmin(user) ? <SyncNowButton /> : undefined} />
        <Toolbar>
          <AccountsToolbar q={q} scope={scope} mineCount={mineCount} allCount={all.length} />
        </Toolbar>

        {rows.length === 0 ? (
          <EmptyState
            icon={<IconCampaigns size={20} />}
            title={q ? 'No accounts match' : 'No accounts yet'}
            hint={q ? 'Try a different search.' : undefined}
          />
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Industry</th>
                  <th>City</th>
                  <th>Owner</th>
                  <th className="num">People</th>
                  <th className="num">In sequence</th>
                  <th className="num">Replied</th>
                  <th className="num">Meetings</th>
                  <th>Last touch</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <IdentityCell name={a.name} href={`/accounts/${a.id}`} sub={a.domain} />
                        {a.mine ? <Badge tone="blue">mine</Badge> : null}
                      </div>
                    </td>
                    {/* Industry and city are fields, not a dotted sentence under the name. */}
                    <td className="whitespace-nowrap text-[12.5px]">{a.industry ?? <Empty />}</td>
                    <td className="whitespace-nowrap text-[12.5px]">{a.city ?? <Empty />}</td>
                    <td className="whitespace-nowrap text-[12.5px]">{a.ownerName ?? <Empty>Unassigned</Empty>}</td>
                    <td className="num"><Count value={a.people} /></td>
                    <td className="num">
                      <StatusDot tone={a.inSequence ? 'green' : 'gray'}><Count value={a.inSequence} /></StatusDot>
                    </td>
                    <td className="num"><Count value={a.replied} /></td>
                    <td className="num"><Count value={a.meetings} /></td>
                    <td className="whitespace-nowrap text-[12px] text-ink-500">{a.lastTouchAt ? formatInstant(a.lastTouchAt, user.timezone) : <Empty />}</td>
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
