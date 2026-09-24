import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { canEnrich } from '@/lib/enrichment';
import { formatInstant } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { Surface, ViewHeader } from '@/components/ui';
import { EnrichmentImportForm } from '@/components/enrichment/import-form';

/** How a row's status reads in a one-line summary of an upload. */
const STATUS_WORDS: [string, string][] = [['READY', 'ready'], ['CONFLICT', 'to review'], ['FAILED', 'failed'], ['INVALID', 'invalid'], ['APPLYING', 'being applied'], ['APPLIED', 'verified in the CRM'], ['DRY_RUN', 'simulated'], ['NO_CHANGE', 'already current'], ['SKIPPED', 'skipped']];

/**
 * An enriched file comes back in here, and every earlier upload is listed under the form so it
 * can be reopened, reviewed and applied: the other end of Export to enrich.
 */
export default async function ImportEnrichmentPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const user = await requireUser();
  if (!canEnrich(user)) redirect('/enrichment');
  const sp = await searchParams;
  const batches = await prisma.enrichmentBatch.findMany({ where: isAdmin(user) ? {} : { createdById: user.id }, orderBy: { createdAt: 'desc' }, take: 25, include: { _count: { select: { rows: true } } } });
  const [counts, authors] = await Promise.all([
    prisma.enrichmentRow.groupBy({ by: ['batchId', 'status'], where: { batchId: { in: batches.map((b) => b.id) } }, _count: { _all: true } }),
    prisma.user.findMany({ where: { id: { in: [...new Set(batches.map((b) => b.createdById))] } }, select: { id: true, name: true } }),
  ]);
  const summary = (id: string) => STATUS_WORDS.flatMap(([status, words]) => { const n = counts.find((c) => c.batchId === id && c.status === status)?._count._all ?? 0; return n ? [`${n.toLocaleString('en-US')} ${words}`] : []; }).join(' · ');
  return <div className="space-y-4 px-6 pb-8 pt-2">
    <Link href="/enrichment" className="btn-ghost btn-sm">Back to data readiness</Link>
    <EnrichmentImportForm initialEntity={sp.entity === 'company' ? 'company' : 'person'} />
    <Surface flush>
      <ViewHeader title="Earlier uploads" />
      {batches.length ? <div className="overflow-x-auto"><table className="table table-dense">
        <thead><tr><th>Upload</th><th>Type</th><th className="num">Rows</th><th>Where it stands</th><th>Uploaded</th></tr></thead>
        <tbody>{batches.map((b) => <tr key={b.id}>
          <td><Link href={`/enrichment/${b.id}`} className="font-medium text-brand-700 hover:underline">{b.name}</Link></td>
          <td className="text-ink-700">{b.entity === 'company' ? 'Accounts' : 'People'}</td>
          <td className="num tabular-nums">{b._count.rows.toLocaleString('en-US')}</td>
          <td className="text-[12.5px] text-ink-700">{summary(b.id) || '–'}</td>
          <td className="whitespace-nowrap text-[12.5px] text-ink-600">{formatInstant(b.createdAt, workspaceTimezone())} · {authors.find((a) => a.id === b.createdById)?.name ?? 'Someone'}</td>
        </tr>)}</tbody>
      </table></div> : <p className="px-5 pb-5 text-sm text-ink-500">Nothing uploaded yet. Export the records to enrich, fill in the file, and upload it here.</p>}
    </Surface>
  </div>;
}
