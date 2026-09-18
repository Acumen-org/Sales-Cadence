import { requireUser } from '@/lib/auth/current-user';
import { ENRICHMENT_FIELDS, type EnrichmentEntity } from '@/lib/enrichment';
import { enrichmentQueue, filterEnrichmentQueue, type EnrichmentQueueItem } from '@/lib/enrichment-work';

function cell(value: string) {
  const safe = /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** The vendor's file: ids to match on, what is missing, and a blank column for each value an import can write back. */
function csvFor(entity: EnrichmentEntity, records: EnrichmentQueueItem[]) {
  // Identity columns are for matching, and `deliberate` ones are corrections rather than gaps,
  // so neither is offered as a blank cell somebody feels obliged to fill.
  const fillable = ENRICHMENT_FIELDS[entity].filter((field) => !field.identity && !field.deliberate);
  const headers = ['recordId', 'recordName', 'account', 'informationNeeded', ...fillable.map((field) => field.key)];
  const rows = records.map((item) => [item.id, item.label, item.company ?? '', item.gaps.map((gap) => gap.label).join('; '), ...fillable.map(() => '')]);
  const csv = [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
  return new Response(`﻿${csv}`, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="cadence-${entity === 'person' ? 'contacts' : 'accounts'}-to-enrich.csv"`, 'cache-control': 'no-store' } });
}

/** Everything matching the page's filters. */
export async function GET(request: Request) {
  const user = await requireUser();
  const params = new URL(request.url).searchParams;
  const entity: EnrichmentEntity = params.get('entity') === 'company' ? 'company' : 'person';
  const priority = params.get('priority');
  const campaign = params.get('campaign');
  const records = filterEnrichmentQueue((await enrichmentQueue(user)).filter((item) => item.entity === entity), {
    q: params.get('q') ?? '', fields: params.getAll('field'), sort: params.get('sort') ?? 'name', dir: params.get('dir') ?? undefined,
    pod: params.get('pod') ?? '', fo: params.get('fo') ?? '', tier: params.get('tier') ?? '', type: params.get('type') ?? '', product: params.get('product') ?? '', account: params.get('account') ?? '', tag: params.get('tag') ?? '',
    priority: priority === 'critical' || priority === 'useful' ? priority : '', campaign: campaign === 'any' || campaign === 'none' ? campaign : '', notFound: params.get('marks') === 'notfound',
  });
  return csvFor(entity, records);
}

/** Exactly the chosen rows: ids come in the form body, so a selection of thousands is not a URL. */
export async function POST(request: Request) {
  const user = await requireUser();
  const form = await request.formData();
  const entity: EnrichmentEntity = form.get('entity') === 'company' ? 'company' : 'person';
  const ids = new Set(String(form.get('ids') ?? '').split(/\s+/).filter(Boolean));
  const fields = String(form.get('fields') ?? '').split(/\s+/).filter(Boolean);
  const records = (await enrichmentQueue(user))
    .filter((item) => item.entity === entity && ids.has(item.id))
    .map((item) => ({ ...item, gaps: fields.length ? item.gaps.filter((gap) => fields.includes(gap.field)) : item.gaps }))
    .filter((item) => item.gaps.length);
  return csvFor(entity, records);
}
