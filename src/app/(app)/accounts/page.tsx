import { requireUser } from '@/lib/auth/current-user';
import { listAccounts } from '@/lib/accounts-query';
import { formatInstant } from '@/lib/dates';
import { IconCampaigns } from '@/components/icons';
import { AccountsToolbar } from '@/components/accounts/accounts-toolbar';
import { Badge, EmptyState, IdentityCell, StatusDot, Surface, Toolbar, ViewHeader } from '@/components/ui';

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ q?: string; scope?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const scope = sp.scope === 'mine' ? 'mine' : 'all';
  const all = await listAccounts(user, { q });
  const rows = scope === 'mine' ? all.filter((a) => a.mine) : all;
  const mineCount = all.filter((a) => a.mine).length;

  return (
    <div className="px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader title={scope === 'mine' ? 'My accounts' : 'All accounts'} caret meta={`${rows.length} account${rows.length === 1 ? '' : 's'}`} />
        <Toolbar>
          <AccountsToolbar q={q} scope={scope} mineCount={mineCount} allCount={all.length} />
        </Toolbar>

        {rows.length === 0 ? (
          <EmptyState
            icon={<IconCampaigns size={20} />}
            title={q ? 'No accounts match' : 'No accounts yet'}
            hint={q ? 'Try a different search.' : 'Accounts are Twenty companies. Sync people from Twenty and their companies appear here.'}
          />
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Owner</th>
                  <th>People</th>
                  <th>In sequence</th>
                  <th>Replied</th>
                  <th>Meetings</th>
                  <th>Last touch</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <IdentityCell name={a.name} href={`/accounts/${a.id}`} sub={[a.industry, a.city, a.domain].filter(Boolean).join(' · ') || null} />
                        {a.mine ? <Badge tone="blue">mine</Badge> : null}
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-[12.5px]">{a.ownerName ?? <span className="text-ink-300">unassigned</span>}</td>
                    <td>{a.people}</td>
                    <td>
                      <StatusDot tone={a.inSequence ? 'green' : 'gray'}>{a.inSequence} Active</StatusDot>
                    </td>
                    <td>{a.replied}</td>
                    <td>{a.meetings}</td>
                    <td className="whitespace-nowrap text-[12px] text-ink-500">{a.lastTouchAt ? formatInstant(a.lastTouchAt, user.timezone) : <span className="text-ink-300">never</span>}</td>
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
