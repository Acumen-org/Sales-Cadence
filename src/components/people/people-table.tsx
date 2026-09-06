'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui';
import { PersonRowActions } from './person-row-actions';

export type PeopleTableRow = {
  id: string;
  name: string;
  jobTitle: string | null;
  companyName: string | null;
  podOwner: string | null;
  eventSource: string | null;
  stage: { label: string; tone: BadgeTone };
  dnd: boolean;
  optedOut: boolean;
  badEmail: boolean;
  badPhone: boolean;
  enrollment: { status: string; label: string; tone: BadgeTone; campaignName: string | null; foName: string } | null;
  activeEnrollmentId: string | null;
  activeCanExit: boolean;
  lastTouch: { summary: string; at: string } | null;
  twentyUrl: string | null;
};

type Props = {
  rows: PeopleTableRow[];
  showActions: boolean;
  canEnroll: boolean;
  sequences: { id: string; name: string }[];
  pods: { id: string; name: string; podOwnerValue: string; fos: { id: string; name: string }[] }[];
  podIdByOwner: Record<string, string>;
};

/** People list with Outreach-style stages, row actions, and bulk "add to sequence". */
export function PeopleTable({ rows, showActions, canEnroll, sequences, pods, podIdByOwner }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectable = rows.filter((r) => !r.activeEnrollmentId && !r.dnd && !r.optedOut);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.id)));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const bulkHref = `/campaigns/new?ids=${encodeURIComponent([...selected].join(','))}`;

  return (
    <div>
      {canEnroll ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs">
          <label className="inline-flex items-center gap-1.5 font-normal text-slate-600">
            <input type="checkbox" className="h-3.5 w-3.5 rounded" checked={allSelected} onChange={toggleAll} disabled={!selectable.length} /> {selected.size ? `${selected.size} selected` : 'Select people not yet in a sequence'}
          </label>
          {selected.size ? (
            <Link href={bulkHref} className="btn-primary btn-sm">
              Add {selected.size} to a sequence
            </Link>
          ) : null}
        </div>
      ) : null}
      <table className="table">
        <thead>
          <tr>
            {canEnroll ? <th></th> : null}
            <th>Name</th>
            <th>Company</th>
            <th>Stage</th>
            <th>Pod</th>
            <th>Sequence</th>
            <th>FO</th>
            <th>Last touch</th>
            <th>Where we met</th>
            {showActions ? <th></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              {canEnroll ? (
                <td>
                  <input type="checkbox" className="h-3.5 w-3.5 rounded" checked={selected.has(p.id)} onChange={() => toggle(p.id)} disabled={Boolean(p.activeEnrollmentId) || p.dnd || p.optedOut} aria-label={`Select ${p.name}`} />
                </td>
              ) : null}
              <td>
                <Link href={`/people/${p.id}`} className="font-medium text-slate-900 hover:underline">
                  {p.name}
                </Link>
                <div className="text-xs text-slate-500">{p.jobTitle}</div>
              </td>
              <td>{p.companyName}</td>
              <td>
                <Badge tone={p.stage.tone}>{p.stage.label}</Badge>
                {p.badEmail || p.badPhone ? <div className="mt-0.5 text-[11px] text-amber-700">{[p.badEmail ? 'bad email' : null, p.badPhone ? 'bad phone' : null].filter(Boolean).join(', ')}</div> : null}
              </td>
              <td>{p.podOwner}</td>
              <td>
                {p.enrollment ? (
                  <>
                    <Badge tone={p.enrollment.tone}>{p.enrollment.label}</Badge>
                    {p.enrollment.campaignName ? <div className="text-xs text-slate-500">{p.enrollment.campaignName}</div> : null}
                  </>
                ) : (
                  <span className="text-xs text-slate-400">-</span>
                )}
              </td>
              <td>{p.enrollment?.foName ?? ''}</td>
              <td className="text-xs">
                {p.lastTouch ? (
                  <>
                    <div className="text-slate-700">{p.lastTouch.summary}</div>
                    <div className="text-slate-400">{p.lastTouch.at}</div>
                  </>
                ) : (
                  <span className="text-slate-400">-</span>
                )}
              </td>
              <td>{p.eventSource}</td>
              {showActions ? (
                <td className="text-right">
                  <PersonRowActions
                    personId={p.id}
                    activeEnrollmentId={p.activeEnrollmentId}
                    dnd={p.dnd || p.optedOut}
                    canEnroll={canEnroll}
                    canExit={p.activeCanExit}
                    sequences={sequences}
                    pods={pods}
                    defaultPodId={p.podOwner ? podIdByOwner[p.podOwner] ?? null : null}
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
