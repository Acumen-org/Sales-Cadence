import { sortDirection } from '@/lib/sorting';
import { optionLabel } from '@/lib/twenty/labels';
import { PageFrame } from '@/components/page-frame';
import { needsPod } from '@/lib/auth/rbac';
import { requireUser } from '@/lib/auth/current-user';
import { filterParam, sectionDefaults } from '@/lib/default-filters';
import { defaultTwentySchema } from '@/lib/twenty/twenty-schema';
import { foPeopleWhere, peopleScopeWhere } from '@/lib/people-scope';
import { prisma } from '@/lib/db';
import { isAdmin, visiblePodIds } from '@/lib/auth/rbac';
import { SyncNowButton } from '@/components/settings/sync-now-button';
import Link from 'next/link';
import { ACCOUNT_SORTS, ACCOUNTS_PAGE_SIZE, DEFAULT_ACCOUNT_SORT, listAccounts, peopleWithoutAccountWhere, type AccountSort } from '@/lib/accounts-query';
import { formatInstant } from '@/lib/dates';
import { IconCampaigns } from '@/components/icons';
import { AccountsToolbar } from '@/components/accounts/accounts-toolbar';
import { PillList } from '@/components/pill-list';
import { SortableHeader } from '@/components/sort-control';
import { Badge, Count, Empty, EmptyState, IdentityCell, Stat, Surface, Toolbar, ViewHeader } from '@/components/ui';

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ q?: string; scope?: string; pod?: string; fo?: string; product?: string; campaign?: string; sort?: string; dir?: string; page?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const defaults = await sectionDefaults(user);
  const pod = filterParam(sp.pod, defaults.podOwnerValue);
  const foUserId = filterParam(sp.fo, defaults.foUserId);
  const values = defaultTwentySchema.personValues;
  const product = sp.product && (values.productInterest as readonly string[]).includes(sp.product) ? sp.product : null;
  const campaign = sp.campaign === 'any' || sp.campaign === 'all' || sp.campaign === 'none' ? sp.campaign : null;
  const sort: AccountSort = ACCOUNT_SORTS.includes(sp.sort as AccountSort) ? (sp.sort as AccountSort) : DEFAULT_ACCOUNT_SORT;
  const dir = sortDirection(sp.dir, sort === 'name' ? 'asc' : 'desc');
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const visible = visiblePodIds(user);
  const [list, podRows, withoutAccount] = await Promise.all([
    listAccounts(user, { q, pod, foUserId, product, campaign, sort, dir, page }),
    prisma.pod.findMany({ where: { archived: false, ...(visible === null ? {} : { id: { in: visible } }) }, orderBy: { name: 'asc' }, include: { users: { include: { user: { select: { id: true, name: true, active: true, role: true } } } } } }),
    // The other half of the CRM: people under no account here. Counted here so the two people
    // figures on Accounts and People add up in the open.
    prisma.personCache.count({ where: { AND: [await peopleScopeWhere(user), await peopleWithoutAccountWhere(), ...(pod ? [{ podOwner: pod }] : []), ...(foUserId ? [foPeopleWhere(foUserId, (await prisma.user.findUnique({ where: { id: foUserId }, select: { twentyMemberId: true } }))?.twentyMemberId)] : [])] } }),
  ]);
  const fos = [...new Map(podRows.flatMap((x) => x.users.filter((up) => up.user.active && needsPod(up.user.role)).map((up) => [up.user.id, { id: up.user.id, name: up.user.name }] as const))).values()].sort((a, b) => a.name.localeCompare(b.name));
  const rows = list.rows;
  const pages = Math.max(1, Math.ceil(list.total / ACCOUNTS_PAGE_SIZE));
  const pageHref = (n: number) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    p.set('pod', pod ?? '');
    p.set('fo', foUserId ?? '');
    p.set('dir', dir);
    if (product) p.set('product', product);
    if (campaign) p.set('campaign', campaign);
    if (sort !== DEFAULT_ACCOUNT_SORT) p.set('sort', sort);
    p.set('page', String(n));
    return `/accounts?${p.toString()}`;
  };

  return (
    <PageFrame className="space-y-5 px-6 pb-8 pt-2">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Stat label="Accounts in view" value={list.total} />
        <Stat label="People with an account" value={list.people} />
        <Link href={`/people?pod=${encodeURIComponent(pod ?? '')}&fo=${encodeURIComponent(foUserId ?? '')}&account=none`} className="block rounded-[14px] focus-visible:ring-4 focus-visible:ring-brand-100"><Stat label="People without an account" value={withoutAccount} /></Link>
        <Stat label="Accounts with someone in a campaign" value={list.inCampaign} />
        <Stat label="Engaged accounts" value={list.engaged} tone="good" />
      </div>
      <Surface flush>
        <ViewHeader title="All accounts" caret actions={isAdmin(user) ? <SyncNowButton /> : undefined} />
        <Toolbar>
          <AccountsToolbar q={q} pods={podRows.map((x) => ({ podOwnerValue: x.podOwnerValue, name: x.name }))} fos={fos} products={[...values.productInterest]} pod={pod ?? ''} fo={foUserId ?? ''} product={product ?? ''} campaign={campaign ?? ''} sort={sort} dir={dir} />
        </Toolbar>

        {rows.length === 0 ? (
          <EmptyState
            icon={<IconCampaigns size={20} />}
            title={q || pod || foUserId || product || campaign ? 'No accounts match' : 'No accounts yet'}
            hint={q || pod || foUserId || product || campaign ? 'Try a different search or filter.' : undefined}
          />
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="table table-dense w-full table-fixed">
              <colgroup>
                {['19%', '13%', '12.5%', '10.5%', '9%', '9.5%', '8.5%', '8%', '10%'].map((width, index) => <col key={index} style={{ width }} />)}
              </colgroup>
              <thead>
                <tr>
                  <SortableHeader field="name" label="Account" sort={sort} dir={dir} defaultValue={DEFAULT_ACCOUNT_SORT} defaultDir="asc" />
                  <th>PODs</th>
                  <th>FOs</th>
                  <th>Product</th>
                  <SortableHeader field="people" label="People at account" sort={sort} dir={dir} defaultValue={DEFAULT_ACCOUNT_SORT} className="num" />
                  <SortableHeader field="inSequence" label="In a campaign" sort={sort} dir={dir} defaultValue={DEFAULT_ACCOUNT_SORT} />
                  <SortableHeader field="replied" label="Replied" sort={sort} dir={dir} defaultValue={DEFAULT_ACCOUNT_SORT} className="num" />
                  <th className="num">Meetings</th>
                  <SortableHeader field="lastTouch" label="Last touch" sort={sort} dir={dir} defaultValue={DEFAULT_ACCOUNT_SORT} />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <IdentityCell name={a.name} href={`/accounts/${a.id}`} />
                    </td>
                    {[a.pods, a.fos, a.products].map((items, index) =>
                      <td key={index}>
                        {items.length ? (
                          <PillList
                            max={1}
                            noun={index === 0 ? 'pods' : index === 1 ? 'FOs' : 'products'}
                            items={items.map((value) => ({ label: optionLabel(value), node: <Badge tone={index === 0 ? 'purple' : index === 1 ? 'blue' : 'green'}>{optionLabel(value)}</Badge> }))}
                          />
                        ) : <Empty />}
                      </td>
                    )}
                    <td className="num"><Count value={a.people} /></td>
                    <td className="text-[12.5px]">
                      {/* Part of an account can be in a campaign: the count against everyone there, and a bar for the share. */}
                      {a.people ? (
                        <div className="min-w-0">
                          <div className="tabular-nums text-ink-800"><span className={a.inSequence ? 'text-ink-900' : 'text-ink-400'}>{a.inSequence.toLocaleString('en-US')}</span> <span className="text-ink-400">of {a.people.toLocaleString('en-US')}</span></div>
                          <div className="mt-1 h-1 w-full max-w-[6rem] overflow-hidden rounded-full bg-ink-100"><div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, Math.round((a.inSequence / a.people) * 100))}%` }} /></div>
                        </div>
                      ) : <Empty />}
                    </td>
                    <td className="num"><Count value={a.replied} /></td>
                    <td className="num"><Count value={a.meetings} /></td>
                    <td className="text-[12px] text-ink-500">{a.lastTouchAt ? formatInstant(a.lastTouchAt, user.timezone) : <Empty />}</td>
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
    </PageFrame>
  );
}
