'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { applyEnrichmentAction, reviewEnrichmentAction } from '@/lib/actions/enrichment';
import { Badge, DataValue, Notice, Surface, ViewHeader, type BadgeTone } from '@/components/ui';

export type ReviewRow = { id: string; rowNumber: number; recordId: string | null; recordLabel: string | null; changes: Record<string, string | number | null>; original: Record<string, string | number | null>; status: string; error: string | null };
const STATES: Record<string, { label: string; tone: BadgeTone }> = {
  READY: { label: 'Ready', tone: 'green' }, CONFLICT: { label: 'Review replacement', tone: 'amber' }, INVALID: { label: 'Invalid', tone: 'red' },
  APPLIED: { label: 'Verified in CRM', tone: 'green' }, APPLYING: { label: 'Applying', tone: 'blue' }, FAILED: { label: 'Failed', tone: 'red' },
  NO_CHANGE: { label: 'Already current', tone: 'gray' }, SKIPPED: { label: 'Skipped', tone: 'gray' }, DRY_RUN: { label: 'Simulated', tone: 'amber' },
};
const LABELS: Record<string, string> = { firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone', linkedinUrl: 'LinkedIn', jobTitle: 'Job title', city: 'City', domain: 'Website', industry: 'Industry', employees: 'Employees', aum: 'AUM (USD)' };
const SELECTABLE = new Set(['READY', 'CONFLICT', 'FAILED', 'DRY_RUN', 'APPLYING']);

export function EnrichmentBatchReview({ batchId, entity, rows, dryRun }: { batchId: string; entity: string; rows: ReviewRow[]; dryRun: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('');
  const [pending, start] = useTransition();
  const continueRunning = useRef(false);
  useEffect(() => () => { continueRunning.current = false; }, []);
  const counts = rows.reduce<Record<string, number>>((result, row) => ({ ...result, [row.status]: (result[row.status] ?? 0) + 1 }), {});
  const filtered = filter ? rows.filter((row) => row.status === filter) : rows;
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const currentPage = Math.min(page, pages - 1);
  const shown = filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  const review = (decision: 'approve' | 'skip' | 'retry') => start(async () => {
    setError('');
    try {
      const result = await reviewEnrichmentAction(batchId, selected, decision);
      if (!result.ok) { setError(result.error); return; }
      setSelected([]); router.refresh();
    } catch { setError('The review could not be saved. Try again.'); }
  });
  const apply = async () => {
    continueRunning.current = true; setRunning(true); setError('');
    try {
      while (continueRunning.current) {
        const result = await applyEnrichmentAction(batchId);
        router.refresh();
        if (!result.ok) { setError(result.error); break; }
        if (!result.remaining) break;
      }
    } catch { setError('The connection was interrupted. Completed rows are saved; refresh and resume the remaining rows.'); }
    finally { continueRunning.current = false; setRunning(false); }
  };
  const conflictsSelected = selected.some((id) => rows.some((row) => row.id === id && row.status === 'CONFLICT'));
  const retriesSelected = selected.some((id) => rows.some((row) => row.id === id && ['FAILED', 'DRY_RUN', 'APPLYING'].includes(row.status)));
  return (
    <div className="space-y-4">
      <Surface>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <dl className="flex flex-wrap gap-6">{[['READY', 'Ready'], ['CONFLICT', 'Needs review'], ['APPLIED', 'Verified'], ['FAILED', 'Failed'], ['INVALID', 'Invalid']].map(([status, label]) => <div key={status}><dt className="text-[12px] text-ink-500">{label}</dt><dd className="mt-1 text-2xl font-bold tabular-nums text-ink-900">{counts[status] ?? 0}</dd></div>)}</dl>
          {running ? <button type="button" className="btn-secondary" onClick={() => { continueRunning.current = false; }}>Pause after current batch</button> : <button type="button" className="btn-primary" disabled={pending || !counts.READY} onClick={apply}>{dryRun ? 'Simulate ready rows' : 'Apply ready rows'} <strong>{counts.READY ?? 0}</strong></button>}
        </div>
        {running ? <p role="status" className="mt-4 text-[14px] font-bold text-brand-800">Processing the current batch…</p> : null}
      </Surface>
      {dryRun ? <Notice tone="warn">Dry run is enabled. Imports are simulated until write mode is enabled in Settings.</Notice> : null}
      {error ? <Notice tone="error"><span role="alert">{error}</span></Notice> : null}
      <Surface flush>
        <ViewHeader title="Review records" actions={<select className="!w-auto" aria-label="Filter import status" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(0); }}><option value="">All states</option>{Object.entries(STATES).map(([value, state]) => <option key={value} value={value}>{state.label} ({counts[value] ?? 0})</option>)}</select>} />
        <div className="flex flex-wrap items-center gap-2 border-y border-line px-5 py-3">
          <button type="button" className="btn-secondary btn-sm" disabled={running || pending} onClick={() => setSelected([...new Set([...selected, ...shown.filter((row) => SELECTABLE.has(row.status)).map((row) => row.id)])])}>Select this page</button>
          {selected.length ? <><DataValue>{selected.length} selected</DataValue><button type="button" className="btn-ghost btn-sm" onClick={() => setSelected([])}>Clear selection</button><button type="button" className="btn-secondary btn-sm" disabled={running || pending} onClick={() => review('skip')}>Skip selected</button>{conflictsSelected ? <button type="button" className="btn-secondary btn-sm" disabled={running || pending} onClick={() => review('approve')}>Approve selected replacements</button> : null}{retriesSelected ? <button type="button" className="btn-secondary btn-sm" disabled={running || pending} onClick={() => review('retry')}>Queue selected for retry</button> : null}</> : null}
        </div>
        <div className="overflow-x-auto"><table className="table">
          <thead><tr><th><span className="sr-only">Select</span></th><th>Record</th><th>Field changes</th><th>State</th></tr></thead>
          <tbody>{shown.map((row) => {
            const state = STATES[row.status] ?? { label: row.status, tone: 'gray' as const };
            return <tr key={row.id}>
              <td className="!align-top"><input type="checkbox" aria-label={`Select row ${row.rowNumber}`} checked={selected.includes(row.id)} disabled={running || pending || !SELECTABLE.has(row.status)} onChange={(event) => setSelected(event.target.checked ? [...selected, row.id] : selected.filter((id) => id !== row.id))} /></td>
              <td className="!align-top"><div className="min-w-36 space-y-2"><span className="text-[12px] font-normal text-ink-500">Row <DataValue>{row.rowNumber}</DataValue></span>{row.recordId ? <Link href={`/${entity === 'person' ? 'people' : 'accounts'}/${row.recordId}`} className="block font-bold text-brand-700 hover:underline">{row.recordLabel ?? row.recordId}</Link> : <div className="font-normal text-ink-500">Unmatched</div>}</div></td>
              <td className="!align-top"><div className="min-w-[280px] space-y-3">{Object.entries(row.changes).map(([field, value]) => <div key={field}><div className="mb-1 text-[12px] font-normal text-ink-500">{LABELS[field] ?? field}</div><div className="flex flex-wrap items-center gap-2 text-[13px] font-bold text-ink-900"><span className="break-all">{row.original[field] ?? <span className="font-normal text-ink-400">Empty</span>}</span><span aria-label="changes to" className="font-normal text-ink-400">→</span><span className="break-all text-brand-800">{value}</span></div></div>)}{!Object.keys(row.changes).length ? <span className="font-normal text-ink-400">No field changes</span> : null}</div></td>
              <td className="!align-top"><Badge tone={state.tone}>{state.label}</Badge>{row.error ? <p className="mt-2 max-w-xs text-[13px] font-medium text-ink-800">{row.error}</p> : null}</td>
            </tr>;
          })}</tbody>
        </table></div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4"><DataValue>{filtered.length} records</DataValue><div className="flex items-center gap-3"><button type="button" className="btn-secondary btn-sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span className="text-[12px] text-ink-500">Page <DataValue>{currentPage + 1}</DataValue> / <DataValue>{pages}</DataValue></span><button type="button" className="btn-secondary btn-sm" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div></div>
      </Surface>
    </div>
  );
}
