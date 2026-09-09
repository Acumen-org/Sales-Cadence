import { requireUser } from '@/lib/auth/current-user';
import { ENRICHMENT_FIELDS, enrichmentQueue, type EnrichmentEntity } from '@/lib/enrichment';

function cell(value: string) {
  const safe = /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
export async function GET(request: Request) {
  const user = await requireUser();
  const entity: EnrichmentEntity = new URL(request.url).searchParams.get('entity') === 'company' ? 'company' : 'person';
  const records = (await enrichmentQueue(user)).filter((item) => item.entity === entity);
  const headers = ['recordId', 'recordName', 'informationNeeded', ...ENRICHMENT_FIELDS[entity].filter((field) => !field.identity).map((field) => field.key)];
  const rows = records.map((item) => [item.id, item.label, item.gaps.map((gap) => gap.label).join('; '), ...ENRICHMENT_FIELDS[entity].filter((field) => !field.identity).map(() => '')]);
  const csv = [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
  return new Response(`\uFEFF${csv}`, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="cadence-${entity === 'person' ? 'contacts' : 'accounts'}-to-enrich.csv"`, 'cache-control': 'no-store' } });
}
