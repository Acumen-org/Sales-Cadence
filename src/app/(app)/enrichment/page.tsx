import { sortDirection } from '@/lib/sorting';
import { PageFrame } from '@/components/page-frame';
import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { canSeeAllPods, needsPod, visiblePodIds } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { canEnrich, enrichmentPeopleScope, listableAccountCount } from '@/lib/enrichment';
import { defaultEnrichmentDirection, ENRICHMENT_SORTS, enrichmentFilterOptions, enrichmentQueue, enrichmentScorecard, filterEnrichmentQueue, type EnrichmentFilters } from '@/lib/enrichment-work';
import { formatInstant } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { DataValue, EmptyState, Stat, Surface, Tabs, ViewHeader } from '@/components/ui';
import { EnrichmentToolbar } from '@/components/enrichment/enrichment-toolbar';
import { EnrichmentTable, type EnrichmentRow } from '@/components/enrichment/enrichment-table';
import { EnrichmentScorecard } from '@/components/enrichment/scorecard';

type Search = { records?: string; tab?: string; q?: string; page?: string; field?: string | string[]; dir?: string; sort?: string; pod?: string; fo?: string; tier?: string; type?: string; product?: string; tag?: string; account?: string; priority?: string; campaign?: string; marks?: string };
const TABS = ['contacts', 'accounts', 'scorecard'] as const;
const PAGE = 50;

/**
 * Data quality as work: what is missing and for whom, scored by field against last week, and
 * moved along with a selection - export, assign, not found.
 */
export default async function EnrichmentPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = TABS.includes(sp.tab as (typeof TABS)[number]) ? (sp.tab as (typeof TABS)[number]) : 'contacts';
  const visible = visiblePodIds(user);
  const [queue, pods, users, peopleTotal, accountsTotal] = await Promise.all([
    enrichmentQueue(user, sp.records === 'all'),
    prisma.pod.findMany({ where: visible === null ? {} : { id: { in: visible } }, select: { id: true, podOwnerValue: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.user.findMany({ where: { active: true, ...(visible === null ? {} : { OR: [{ id: user.id }, { pods: { some: { podId: { in: visible } } } }] }) }, select: { id: true, name: true, role: true, twentyMemberId: true }, orderBy: { name: 'asc' } }),
    prisma.personCache.count({ where: await enrichmentPeopleScope(user) }),
    listableAccountCount(user),
  ]);
  const contacts = queue.filter((item) => item.entity === 'person' && item.gaps.length);
  const accounts = queue.filter((item) => item.entity === 'company' && item.gaps.length);
  const entity = tab === 'accounts' ? 'company' : 'person';
  const pool = queue.filter((item) => item.entity === entity);
  const options = enrichmentFilterOptions(pool);
  const fos = users.filter((u) => u.twentyMemberId && needsPod(u.role));
  const foMember = fos.find((u) => u.id === sp.fo)?.twentyMemberId ?? '';
  // Only values present in the queue are accepted, so a hand-edited URL cannot filter on nonsense.
  const pick = (v: string | undefined, allowed: string[]) => (v && allowed.includes(v) ? v : '');
  const values = {
    pod: pick(sp.pod, pods.map((p) => p.podOwnerValue)), fo: foMember ? sp.fo! : '', tier: pick(sp.tier, options.tiers), type: pick(sp.type, options.types), product: pick(sp.product, options.products), tag: pick(sp.tag, options.tags),
    account: pick(sp.account, options.accounts.map((a) => a.id)), priority: '', campaign: pick(sp.campaign, ['any', 'none']), marks: pick(sp.marks, ['notfound']),
  };
  // Several kinds of missing information at once: a record shows when it lacks any of them.
  const wanted = (Array.isArray(sp.field) ? sp.field : sp.field ? [sp.field] : []).filter((f) => options.fields.some((o) => o.field === f));
  const sort = ENRICHMENT_SORTS.includes(sp.sort as (typeof ENRICHMENT_SORTS)[number]) ? (sp.sort as (typeof ENRICHMENT_SORTS)[number]) : 'name';
  const dir = sortDirection(sp.dir, defaultEnrichmentDirection(sort));
  const filters: EnrichmentFilters = { includeComplete: sp.records === 'all', q: sp.q, fields: wanted, sort, dir, pod: values.pod, fo: foMember, tier: values.tier, type: values.type, product: values.product, account: values.account, tag: values.tag, priority: values.priority as EnrichmentFilters['priority'], campaign: values.campaign as EnrichmentFilters['campaign'], notFound: values.marks === 'notfound' };
  const filtered = filterEnrichmentQueue(pool, filters);
  const total = filtered.length;
  const hiddenCount = pool.filter((item) => item.hidden.length).length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.min(Math.max(Number.parseInt(sp.page ?? '1', 10) || 1, 1), pageCount);
  const params = () => {
    const p = new URLSearchParams({ tab });
    if (sp.records === 'all') p.set('records', 'all');
    if (sp.q) p.set('q', sp.q);
    for (const f of wanted) p.append('field', f);
    for (const [k, v] of Object.entries(values)) if (v) p.set(k, v);
    p.set('dir', dir);
    if (sort !== 'name') p.set('sort', sort);
    return p;
  };
  const pageHref = (next: number) => { const p = params(); p.set('page', String(next)); return `/enrichment?${p.toString()}`; };
  const exportParams = params();
  exportParams.delete('tab'); exportParams.set('entity', entity); exportParams.set('sort', sort);
  if (foMember) exportParams.set('fo', foMember);
  const anyFilter = Boolean(sp.q || wanted.length || Object.values(values).some(Boolean));
  const scorecard = tab === 'scorecard' ? await enrichmentScorecard(user) : null;
  const rows: EnrichmentRow[] = filtered.slice((page - 1) * PAGE, page * PAGE).map((item) => ({
    id: item.id, entity: item.entity, label: item.label, company: item.company, href: item.href, twentyUrl: item.twentyUrl, owner: item.owner,
    critical: item.gaps.some((gap) => gap.priority === 'critical'), synced: formatInstant(item.syncedAt, workspaceTimezone()),
    gaps: item.gaps.map((gap) => ({ field: gap.field, label: gap.label, priority: gap.priority, fixInTwenty: gap.fixInTwenty, assignee: gap.mark?.kind === 'assigned' ? gap.mark.assigneeName : null, markedBy: gap.mark?.byName ?? null, markedAt: gap.mark ? formatInstant(gap.mark.at, workspaceTimezone()) : null, suggestion: gap.suggestion ?? null })),
  }));
  const assignees = users.filter((u) => canSeeAllPods(user) || needsPod(u.role) || u.id === user.id).map((u) => ({ id: u.id, name: u.name }));
  const withFilters = (
    <EnrichmentToolbar tab={tab} q={sp.q ?? ''} fields={options.fields} wanted={wanted} pods={pods.map((p) => ({ value: p.podOwnerValue, name: p.name }))} fos={fos.map((f) => ({ id: f.id, name: f.name }))} tiers={options.tiers} types={options.types} products={options.products} tags={options.tags} accounts={options.accounts} values={values} sort={sort} dir={dir} exportHref={`/enrichment/export?${exportParams.toString()}`} contacts={tab !== 'accounts'} />
  );
  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4"><span className="flex items-center gap-3"><DataValue>{total} records</DataValue>{values.marks ? <Link href={`/enrichment?tab=${tab}`} className="text-[12px] text-brand-700 hover:underline">Back to enrichment</Link> : hiddenCount ? <Link href={`/enrichment?tab=${tab}&marks=notfound`} className="text-[12px] text-brand-700 hover:underline">{hiddenCount} marked not found</Link> : null}</span><div className="flex items-center gap-3">{page > 1 ? <Link href={pageHref(page - 1)} className="btn-secondary btn-sm">Previous</Link> : null}<span className="text-[12px] text-ink-500">Page <DataValue>{page}</DataValue> / <DataValue>{pageCount}</DataValue></span>{page < pageCount ? <Link href={pageHref(page + 1)} className="btn-secondary btn-sm">Next</Link> : null}</div></div>
  );
  const empty = <EmptyState title={anyFilter ? 'No records match these filters' : 'Nothing is missing'} action={anyFilter ? <Link href={`/enrichment?tab=${tab}`} className="btn-secondary">Clear filters</Link> : undefined} />;

  return (
    <PageFrame className="space-y-5 px-6 pb-8 pt-2">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="People to enrich" value={contacts.length} />
        <Stat label="Accounts to enrich" value={accounts.length} />
        <Stat label="People complete" value={peopleTotal ? `${Math.round(((peopleTotal - contacts.length) / peopleTotal) * 100)}%` : '–'} />
        <Stat label="Accounts complete" value={accountsTotal ? `${Math.round(((accountsTotal - accounts.length) / accountsTotal) * 100)}%` : '–'} />
      </div>
      <Surface flush>
        <ViewHeader title="Data readiness" />
        <Tabs inset={false} current={tab} tabs={[
          { key: 'contacts', label: 'People', count: contacts.length, href: '/enrichment?tab=contacts' },
          { key: 'accounts', label: 'Accounts', count: accounts.length, href: '/enrichment?tab=accounts' },
          { key: 'scorecard', label: 'Scorecard', href: '/enrichment?tab=scorecard' },
        ]} />
        {tab === 'scorecard' && scorecard ? (
          scorecard.contacts.length || scorecard.accounts.length ? <EnrichmentScorecard scorecard={scorecard} foUserByMember={Object.fromEntries(users.flatMap((u) => (u.twentyMemberId ? [[u.twentyMemberId, u.id]] : [])))} /> : <EmptyState title="No records to score yet" />
        ) : (
          <>
            {withFilters}
            {rows.length ? <EnrichmentTable entity={entity} rows={rows} fields={options.fields} assignees={assignees} canMark={canEnrich(user)} notFound={filters.notFound === true} /> : empty}
            {footer}
          </>
        )}
      </Surface>
    </PageFrame>
  );
}
