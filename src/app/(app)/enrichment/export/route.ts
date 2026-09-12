import { requireUser } from '@/lib/auth/current-user';
import { ENRICHMENT_FIELDS, enrichmentQueue, filterEnrichmentQueue, type EnrichmentEntity } from '@/lib/enrichment';

function cell(value: string) {
  const safe = /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
export async function GET(request: Request) {
  const user = await requireUser();
  const params = new URL(request.url).searchParams;
  const entity: EnrichmentEntity = params.get('entity') === 'company' ? 'company' : 'person';
  const records = filterEnrichmentQueue((await enrichmentQueue(user)).filter((item) => item.entity === entity), params.get('q') ?? '', params.getAll('field'), params.get('sort') ?? 'name');
  // Identity columns are for matching, and `deliberate` ones are corrections rather than gaps,
  // so neither is offered as a blank cell somebody feels obliged to fill.
  const fillable = ENRICHMENT_FIELDS[entity].filter((field) => !field.identity && !field.deliberate);
  const headers = ['recordId', 'recordName', 'informationNeeded', ...fillable.map((field) => field.key)];
  const rows = records.map((item) => [item.id, item.label, item.gaps.map((gap) => gap.label).join('; '), ...fillable.map(() => '')]);
  const csv = [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
  return new Response(`\uFEFF${csv}`, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="cadence-${entity === 'person' ? 'contacts' : 'accounts'}-to-enrich.csv"`, 'cache-control': 'no-store' } });
}
