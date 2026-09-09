'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { inspectEnrichmentUploadAction, previewEnrichmentAction } from '@/lib/actions/enrichment';
import type { EnrichmentEntity, EnrichmentField } from '@/lib/enrichment';
import { DataValue, Field, Notice, Surface, ViewHeader } from '@/components/ui';

export function EnrichmentImportForm({ initialEntity = 'person' }: { initialEntity?: EnrichmentEntity }) {
  const router = useRouter();
  const [entity, setEntity] = useState<EnrichmentEntity>(initialEntity);
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [sample, setSample] = useState<Record<string, string>[]>([]);
  const [fields, setFields] = useState<EnrichmentField[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [count, setCount] = useState(0);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const inspect = (text: string, selected: EnrichmentEntity) => start(async () => {
    setError('');
    try {
    const result = await inspectEnrichmentUploadAction(selected, text);
    if (!result.ok) { setError(result.error); return; }
    setHeaders(result.headers); setSample(result.sample); setFields(result.fields); setMapping(result.mapping); setCount(result.rowCount);
    } catch { setError('The file could not be checked. Check your connection and choose it again.'); }
  });
  const preview = () => start(async () => {
    setError('');
    try {
    const result = await previewEnrichmentAction(entity, name, source, mapping);
    if (!result.ok) { setError(result.error); return; }
    router.push(`/enrichment/${result.id}`);
    } catch { setError('The preview could not be saved. Check your connection and retry.'); }
  });
  return (
    <div className="space-y-5">
      <Surface flush>
        <ViewHeader title="Upload enrichment" />
        <div className="grid gap-5 px-5 pb-5 sm:grid-cols-2">
          <Field label="Record type"><select value={entity} disabled={pending} onChange={(event) => { const selected = event.target.value as EnrichmentEntity; setEntity(selected); setHeaders([]); if (source) inspect(source, selected); }}><option value="person">Contacts</option><option value="company">Accounts</option></select></Field>
          <Field label="Import name"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} /></Field>
          <div className="rounded-xl border border-dashed border-brand-200 bg-brand-50/30 p-6 sm:col-span-2">
            <Field label="CSV or JSON file" hint="Up to 5,000 rows / 4 MB. Blank cells leave existing data unchanged.">
              <input type="file" accept=".csv,.tsv,.json,text/csv,application/json" disabled={pending} onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 4_000_000) { setError('Files can be up to 4 MB.'); return; }
                try { const text = await file.text(); setSource(text); setName(file.name); setHeaders([]); inspect(text, entity); } catch { setError('The file could not be read. Choose it again.'); }
              }} />
            </Field>
          </div>
        </div>
      </Surface>
      {error ? <Notice tone="error"><span role="alert">{error}</span></Notice> : null}
      {headers.length ? <Surface flush>
        <ViewHeader title="Map columns" meta={<><DataValue>{count}</DataValue> rows</>} />
        <div className="overflow-x-auto"><table className="table">
          <thead><tr><th>File column</th><th>Sample data</th><th>Destination</th></tr></thead>
          <tbody>{headers.map((header) => <tr key={header}>
            <td>{header}</td><td><span className="block max-w-md truncate" title={sample[0]?.[header]}>{sample[0]?.[header] || <span className="font-normal text-ink-400">Empty</span>}</span></td>
            <td><select aria-label={`Map ${header}`} value={mapping[header] ?? ''} onChange={(event) => setMapping({ ...mapping, [header]: event.target.value })}><option value="">Ignore column</option>{fields.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}</select></td>
          </tr>)}</tbody>
        </table></div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-5"><span className="text-[13px] text-ink-500">Match with a Twenty ID or an existing {entity === 'person' ? 'email' : 'domain'}.</span><button type="button" className="btn-primary" disabled={pending} onClick={preview}>{pending ? 'Checking records…' : 'Validate and preview'}</button></div>
      </Surface> : pending ? <div role="status" className="p-5 text-[14px] font-bold text-ink-900">Reading file…</div> : null}
    </div>
  );
}
