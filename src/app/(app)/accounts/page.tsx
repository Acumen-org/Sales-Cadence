import { requireUser } from '@/lib/auth/current-user';
import { filterParam, sectionDefaults } from '@/lib/default-filters';
import { defaultTwentySchema } from '@/lib/twenty/twenty-schema';
import { prisma } from '@/lib/db';
import { isAdmin, visiblePodIds } from '@/lib/auth/rbac';
import { SyncNowButton } from '@/components/settings/sync-now-button';
import Link from 'next/link';
import { ACCOUNT_SORTS, ACCOUNTS_PAGE_SIZE, DEFAULT_ACCOUNT_SORT, listAccounts, type AccountSort } from '@/lib/accounts-query';
import { formatInstant } from '@/lib/dates';
import { IconCampaigns } from '@/components/icons';
import { AccountsToolbar } from '@/components/accounts/accounts-toolbar';
import { Badge, Count, Empty, EmptyState, IdentityCell, Stat, StatusDot, Surface, Toolbar, ViewHeader } from '@/components/ui';

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ q?: string; scope?: string; pod?: string; fo?: string; product?: string; sort?: string; page?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const scope = sp.scope === 'mine' ? 'mine' : 'all';
  const defaults = await sectionDefaults(user);
  const pod = filterParam(sp.pod, defaults.podOwnerValue);
  const foUserId = filterParam(sp.fo, null);
  const values = defaultTwentySchema.personValues;
  const product = sp.product && (values.productInterest as readonly string[]).includes(sp.product) ? sp.product : null;
  const sort: AccountSort = ACCOUNT_SORTS.includes(sp.sort as AccountSort) ? (sp.sort as AccountSort) : DEFAULT_ACCOUNT_SORT;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const visible = visiblePodIds(user);
  const [list, podRows] = await Promise.all([
    listAccounts(user, { q, pod, foUserId, product, sort, scope, page }),
    prisma.pod.findMany({ where: { archived: false, ...(visible === null ? {} : { id: { in: visible } }) }, orderBy: { name: 'asc' }, include: { users: { include: { user: { select: { id: true, name: true, active: true } } } } } }),
  ]);
  const fos = [...new Map(podRows.flatMap((x) => x.users.filter((up) => up.user.active).map((up) => [up.user.id, { id: up.user.id, name: up.user.name }] as const))).values()].sort((a, b) => a.name.localeCompare(b.name));
  const rows = list.rows;
  const pages = Math.max(1, Math.ceil(list.total / ACCOUNTS_PAGE_SIZE));
  const pageHref = (n: number) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (scope === 'mine') p.set('scope', 'mine');
    p.set('pod', pod ?? '');
    if (foUserId) p.set('fo', foUserId);
    if (product) p.set('product', product);
    if (sort !== DEFAULT_ACCOUNT_SORT) p.set('sort', sort);
    p.set('page', String(n));
    return `/accounts?${p.toString()}`;
  };

  return (
    <div className="space-y-5 px-6 pb-8 pt-2">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Accounts in view" value={list.total} />
        <Stat label="People" value={list.people} />
        <Stat label="In sequence" value={list.inSequence} />
        <Stat label="Engaged accounts" value={list.engaged} tone="good" />
      </div>
      <Surface flush>
        <ViewHeader title={scope === 'mine' ? 'My accounts' : 'All accounts'} caret actions={isAdmin(user) ? <SyncNowButton /> : undefined} />
        <Toolbar>
          <AccountsToolbar q={q} scope={scope} mineCount={list.mine} allCount={list.total} pods={podRows.map((x) => ({ podOwnerValue: x.podOwnerValue, name: x.name }))} fos={fos} products={[...values.productInterest]} pod={pod ?? ''} fo={foUserId ?? ''} product={product ?? ''} sort={sort} />
        </Toolbar>

        {rows.length === 0 ? (
          <EmptyState
            icon={<IconCampaigns size={20} />}
            title={q || pod || foUserId || product ? 'No accounts match' : 'No accounts yet'}
            hint={q || pod || foUserId || product ? 'Try a different search or filter.' : undefined}
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
      {pages > 1 ? (
        <div className="flex items-center justify-between text-[13px] text-ink-500">
          <span>
            Page <span className="font-medium text-ink-900">{page}</span> of <span className="font-medium text-ink-900">{pages}</span>
          </span>
          <div className="flex gap-2">
            {page > 1 ? <Link href={pageHref(page - 1)} className="btn-secondary btn-sm">Previous</Link> : null}
            {page < pages ? <Link href={pageHref(page + 1)} className="btn-secondary btn-sm">Next</Link> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
