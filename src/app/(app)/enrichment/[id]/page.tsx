import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canEnrich, getEnrichmentBatch } from '@/lib/enrichment';
import { formatInstant } from '@/lib/dates';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { getTwentyConnection } from '@/lib/settings';
import { EnrichmentBatchReview, type ReviewRow } from '@/components/enrichment/batch-review';
import { Badge, RecordFields, Surface } from '@/components/ui';
export default async function EnrichmentBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!canEnrich(user)) redirect('/enrichment');
  const { id } = await params;
  const [batch, connection] = await Promise.all([getEnrichmentBatch(user, id), getTwentyConnection()]);
  if (!batch) notFound();
  return <div className="space-y-4 px-6 pb-8 pt-2">
    <Link href="/enrichment?tab=imports" className="btn-ghost btn-sm">Back to imports</Link>
    <Surface><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-[22px] font-semibold tracking-tight text-ink-900">{batch.name}</h2><Badge tone={connection.mode === 'mock' ? 'amber' : 'green'}>{connection.mode === 'mock' ? 'Demo CRM' : 'Twenty CRM'}</Badge></div><RecordFields items={[{ label: 'Records', value: batch.rows.length }, { label: 'Type', value: batch.entity === 'person' ? 'Contacts' : 'Accounts' }, { label: 'Created', value: formatInstant(batch.createdAt, WORKSPACE_TIMEZONE) }]} /></Surface>
    <EnrichmentBatchReview batchId={id} entity={batch.entity} dryRun={connection.dryRun} rows={batch.rows.map((row) => ({ id: row.id, rowNumber: row.rowNumber, recordId: row.recordId, recordLabel: row.recordLabel, changes: row.changes as ReviewRow['changes'], original: row.original as ReviewRow['original'], status: row.status, error: row.error }))} />
  </div>;
}
