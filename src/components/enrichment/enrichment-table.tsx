'use client';

import Link from 'next/link';
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { markEnrichmentAction, unmarkEnrichmentAction } from '@/lib/actions/enrichment';
import type { EnrichmentEntity } from '@/lib/enrichment';
import { Badge, IdentityCell, Notice } from '@/components/ui';
import { IconExternal } from '@/components/icons';

export type EnrichmentRow = {
  id: string;
  entity: EnrichmentEntity;
  label: string;
  company: string | null;
  href: string;
  twentyUrl: string | null;
  owner: string | null;
  critical: boolean;
  gaps: { field: string; label: string; priority: 'critical' | 'useful'; fixInTwenty?: boolean; assignee: string | null; markedBy: string | null; markedAt: string | null; suggestion: { id: string; name: string } | null }[];
};

type Props = {
  entity: EnrichmentEntity;
  rows: EnrichmentRow[];
  /** Kinds of missing information in this view, for the "not found" chooser. */
  fields: { field: string; label: string }[];
  assignees: { id: string; name: string }[];
  canMark: boolean;
  /** The view shows gaps marked not found; the bar offers to reopen them. */
  notFound: boolean;
};

/**
 * The queue with a selection. The bar above it acts on exactly the chosen rows: export them for a
 * vendor, hand their gaps to somebody to research, or record that a value could not be found.
 * Every gap badge says where it stands - who is on it, or that an import cannot write it.
 */
export function EnrichmentTable({ entity, rows, fields, assignees, canMark, notFound }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignee, setAssignee] = useState('');
  const [field, setField] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const exportForm = useRef<HTMLFormElement>(null);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = [...selected];
  const req = () => ({ entity, ids: chosen, fields: field ? [field] : null });
  const run = (work: () => Promise<{ ok: boolean; error?: string }>) => start(async () => {
    setError('');
    try {
      const result = await work();
      if (!result.ok) { setError(result.error ?? 'The mark could not be saved.'); return; }
      setSelected(new Set());
      router.refresh();
    } catch { setError('The mark could not be saved. Check your connection and retry.'); }
  });
  const sub = (r: EnrichmentRow) => [r.company, r.owner].filter(Boolean).join(' · ') || null;

  return (
    <div>
      {selected.size ? (
        <div className="flex flex-wrap items-center gap-3 border-y border-brand-100 bg-brand-50/70 px-4 py-2 text-[12.5px] text-brand-800">
          <span className="font-medium">{selected.size} selected</span>
          <form ref={exportForm} method="post" action="/enrichment/export" className="contents">
            <input type="hidden" name="entity" value={entity} />
            <input type="hidden" name="ids" value={chosen.join('\n')} />
            <input type="hidden" name="fields" value={field} />
            <button type="submit" className="btn-secondary btn-sm">Export {selected.size}</button>
          </form>
          {canMark ? (
            <>
              <select value={field} onChange={(e) => setField(e.target.value)} aria-label="Which missing information" className="!w-auto !py-1.5 !text-[12.5px]">
                <option value="">Every missing field</option>
                {fields.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
              </select>
              {notFound ? (
                <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => unmarkEnrichmentAction(req(), 'not_found'))}>Reopen</button>
              ) : (
                <>
                  <span className="inline-flex items-center gap-1.5">
                    <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assign research to" className="!w-auto !py-1.5 !text-[12.5px]">
                      <option value="">Assign research to…</option>
                      {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    <button type="button" className="btn-secondary btn-sm" disabled={pending || !assignee} onClick={() => run(() => markEnrichmentAction(req(), 'assigned', assignee))}>Assign</button>
                  </span>
                  <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => unmarkEnrichmentAction(req(), 'assigned'))}>Unassign</button>
                  <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => markEnrichmentAction(req(), 'not_found', null))}>Not found</button>
                </>
              )}
            </>
          ) : null}
          <button type="button" className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      ) : null}
      {error ? <div className="px-4 pt-3"><Notice tone="error"><span role="alert">{error}</span></Notice></div> : null}
      <table className="table w-full table-fixed">
        <colgroup>
          <col className="w-10" />
          <col style={{ width: '30%' }} />
          <col style={{ width: '52%' }} />
          <col style={{ width: '10%' }} />
          <col className="w-12" />
        </colgroup>
        <thead>
          <tr>
            <th className="w-9 pl-4 pr-0"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!rows.length} aria-label={entity === 'person' ? 'Select people' : 'Select accounts'} /></th>
            <th>{entity === 'person' ? 'Person' : 'Account'}</th>
            <th>{notFound ? 'Marked not found' : 'Information needed'}</th>
            <th>Priority</th>
            <th><span className="sr-only">Open in Twenty</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={selected.has(r.id) ? 'bg-brand-50/70' : undefined}>
              <td className="pl-4 pr-0"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.label}`} /></td>
              <td><IdentityCell name={r.label} sub={sub(r)} href={r.href} shape={r.entity === 'person' ? 'circle' : 'square'} /></td>
              <td>
                <div className="flex flex-wrap gap-1.5">
                  {!r.gaps.length ? <span className="text-ink-500">Nothing missing</span> : null}{r.gaps.map((gap) => {
                    const title = [gap.fixInTwenty ? 'A relation or an assignment: an import cannot write it. Link it on the record in Twenty.' : null, gap.assignee ? `Researching: ${gap.assignee}` : null, gap.markedBy && gap.markedAt ? `Marked by ${gap.markedBy}, ${gap.markedAt}` : null].filter(Boolean).join(' ');
                    return (
                      <span key={gap.field} className="inline-flex items-center gap-1" title={title || undefined}>
                        <Badge tone={gap.assignee && !notFound ? 'blue' : 'gray'}>
                          {gap.label}{gap.assignee ? ` · ${gap.assignee}` : ''}
                        </Badge>
                        {gap.suggestion ? <Link href={`/accounts/${gap.suggestion.id}`} className="text-[12px] text-brand-700 hover:underline" title="The account whose website matches this email">looks like {gap.suggestion.name}</Link> : null}
                      </span>
                    );
                  })}
                </div>
              </td>
              <td className="whitespace-nowrap text-[12.5px]">{!r.gaps.length ? null : r.critical ? <span className="font-medium text-red-700">Critical</span> : <span className="text-ink-500">Nice to have</span>}</td>
              <td className="pr-4 text-right">{r.twentyUrl ? <a href={r.twentyUrl} target="_blank" rel="noreferrer" className="btn-ghost btn-sm !px-1.5" aria-label={`Open ${r.label} in Twenty`} title="Open in Twenty"><IconExternal size={14} /></a> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
