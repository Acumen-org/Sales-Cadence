import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { canEnrich, enrichmentQueue } from '@/lib/enrichment';
import { formatInstant } from '@/lib/dates';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { Badge, DataValue, EmptyState, Field, IdentityCell, Stat, Surface, Tabs, ViewHeader } from '@/components/ui';

type Search = { tab?: string; q?: string; page?: string; field?: string | string[]; sort?: string };
const SORTS = ['name', 'company', 'gaps'] as const;
export default async function EnrichmentPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = ['contacts', 'accounts', 'imports'].includes(sp.tab ?? '') ? sp.tab! : 'contacts';
  const [queue, batches] = await Promise.all([
    enrichmentQueue(user),
    prisma.enrichmentBatch.findMany({ where: isAdmin(user) ? {} : { createdById: user.id }, orderBy: { createdAt: 'desc' }, take: 100, include: { _count: { select: { rows: true } } } }),
  ]);
  const contacts = queue.filter((item) => item.entity === 'person');
  const accounts = queue.filter((item) => item.entity === 'company');
  const selected = tab === 'accounts' ? accounts : contacts;
  const fields = [...new Map(selected.flatMap((item) => item.gaps.map((gap) => [gap.field, gap.label.replace(/ missing$| needs verification$| incomplete$/, '')] as const))).entries()];
  // Several kinds of missing information at once: a record shows when it lacks any of them.
  const wanted = (Array.isArray(sp.field) ? sp.field : sp.field ? [sp.field] : []).filter((f) => fields.some(([field]) => field === f));
  const sort = SORTS.includes(sp.sort as (typeof SORTS)[number]) ? (sp.sort as (typeof SORTS)[number]) : 'name';
  const filtered = selected
    .filter((item) => (!sp.q || `${item.label} ${item.company ?? ''}`.toLowerCase().includes(sp.q.toLowerCase())) && (!wanted.length || item.gaps.some((gap) => wanted.includes(gap.field))))
    .sort((a, b) => sort === 'gaps' ? b.gaps.length - a.gaps.length || a.label.localeCompare(b.label) : sort === 'company' ? (a.company ?? '').localeCompare(b.company ?? '') || a.label.localeCompare(b.label) : a.label.localeCompare(b.label));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
  const page = Math.min(Math.max(Number.parseInt(sp.page ?? '1', 10) || 1, 1), pageCount);
  const pageHref = (next: number) => {
    const params = new URLSearchParams({ tab, page: String(next) });
    if (sp.q) params.set('q', sp.q);
    for (const f of wanted) params.append('field', f);
    if (sort !== 'name') params.set('sort', sort);
    return `/enrichment?${params.toString()}`;
  };
  return (
    <div className="space-y-5 px-6 pb-8 pt-2">
      <div className="grid gap-3 sm:grid-cols-3"><Stat label="Contacts to enrich" value={contacts.length} tone={contacts.length ? 'warn' : 'good'} /><Stat label="Accounts to enrich" value={accounts.length} /><Stat label="Imports" value={batches.length} /></div>
      <Surface flush>
        <ViewHeader title="Data readiness" actions={canEnrich(user) ? <Link href={`/enrichment/import?entity=${tab === 'accounts' ? 'company' : 'person'}`} className="btn-primary">Import enrichment</Link> : undefined} />
        <Tabs inset={false} current={tab} tabs={[{ key: 'contacts', label: 'Contacts', count: contacts.length, href: '/enrichment?tab=contacts' }, { key: 'accounts', label: 'Accounts', count: accounts.length, href: '/enrichment?tab=accounts' }, { key: 'imports', label: 'Imports', count: batches.length, href: '/enrichment?tab=imports' }]} />
        {tab === 'imports' ? batches.length ? <div className="overflow-x-auto"><table className="table data-table"><thead><tr><th>Import</th><th>Record type</th><th>Rows</th><th>Created</th></tr></thead><tbody>{batches.map((batch) => <tr key={batch.id}><td><Link href={`/enrichment/${batch.id}`} className="font-medium text-brand-700 hover:underline">{batch.name}</Link></td><td>{batch.entity === 'person' ? 'Contacts' : 'Accounts'}</td><td>{batch._count.rows}</td><td>{formatInstant(batch.createdAt, WORKSPACE_TIMEZONE)}</td></tr>)}</tbody></table></div> : <EmptyState title="No imports yet" hint="Export the records that need work, have them enriched, then bring the file back here." action={canEnrich(user) ? <Link href="/enrichment/import?entity=person" className="btn-primary">Import enrichment</Link> : undefined} /> : <>
          <form method="get" className="flex flex-wrap items-end gap-3 p-5">
            <input type="hidden" name="tab" value={tab} />
            <Field label="Search" className="min-w-[170px] flex-1"><input name="q" defaultValue={sp.q ?? ''} placeholder="Name or account" /></Field>
            <fieldset className="min-w-0"><legend className="mb-1.5 block text-[12px] font-medium text-ink-500">Missing information</legend><div className="flex flex-wrap gap-1.5">{fields.map(([field, label]) => <label key={field} className={wanted.includes(field) ? 'chip cursor-pointer' : 'chip-muted cursor-pointer'}><input type="checkbox" name="field" value={field} defaultChecked={wanted.includes(field)} className="sr-only" />{label}</label>)}</div></fieldset>
            <Field label="Sort" className="min-w-[150px]"><select name="sort" defaultValue={sort}><option value="name">Name</option><option value="company">Company</option><option value="gaps">Most missing</option></select></Field>
            <button type="submit" className="btn-secondary">Apply filters</button><Link href={`/enrichment?tab=${tab}`} className="btn-ghost">Reset</Link>
            <a href={`/enrichment/export?entity=${tab === 'accounts' ? 'company' : 'person'}`} className="btn-secondary">Export to enrich</a>
          </form>
          {!filtered.length ? <EmptyState title={sp.q || wanted.length ? 'No records match these filters' : 'Nothing is missing'} hint={undefined} action={sp.q || wanted.length ? <Link href={`/enrichment?tab=${tab}`} className="btn-secondary">Clear filters</Link> : undefined} /> : <div className="overflow-x-auto"><table className="table"><thead><tr><th>{tab === 'accounts' ? 'Account' : 'Contact'}</th><th>Information needed</th><th>Priority</th></tr></thead><tbody>{filtered.slice((page - 1) * 50, page * 50).map((item) => <tr key={item.id}><td><IdentityCell name={item.label} sub={item.company} href={item.href} shape={item.entity === 'person' ? 'circle' : 'square'} /></td><td><div className="flex max-w-xl flex-wrap gap-2">{item.gaps.map((gap) => <span key={gap.field} title={gap.fixInTwenty ? 'A relation or an assignment: an import cannot write it. Link it on the record in Twenty.' : undefined}><Badge tone={gap.priority === 'critical' ? 'amber' : 'gray'}>{gap.fixInTwenty ? `${gap.label} - link it in Twenty` : gap.label}</Badge></span>)}</div></td><td><Badge tone={item.gaps.some((gap) => gap.priority === 'critical') ? 'amber' : 'blue'}>{item.gaps.some((gap) => gap.priority === 'critical') ? 'Critical' : 'Useful'}</Badge></td></tr>)}</tbody></table></div>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4"><DataValue>{filtered.length} records</DataValue><div className="flex items-center gap-3">{page > 1 ? <Link href={pageHref(page - 1)} className="btn-secondary btn-sm">Previous</Link> : null}<span className="text-[12px] text-ink-500">Page <DataValue>{page}</DataValue> / <DataValue>{pageCount}</DataValue></span>{page < pageCount ? <Link href={pageHref(page + 1)} className="btn-secondary btn-sm">Next</Link> : null}</div></div>
        </>}
      </Surface>
    </div>
  );
}
