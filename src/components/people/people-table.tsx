'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, DotTimeline, IdentityCell, type BadgeTone, type TimelinePoint } from '@/components/ui';
import { IconPlus } from '@/components/icons';
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
  activity: TimelinePoint[];
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

/** People list with stages, an activity timeline, row actions and bulk "add to sequence". */
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
      {canEnroll && selected.size ? (
        <div className="flex flex-wrap items-center gap-3 border-y border-brand-100 bg-brand-50/70 px-4 py-2 text-[12.5px] text-brand-800">
          <span className="font-medium">{selected.size} selected</span>
          <Link href={bulkHref} className="btn-primary btn-sm">
            <IconPlus size={13} /> Add to a sequence
          </Link>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}
      <div className="overflow-x-auto scroll-thin">
        <table className="table">
          <thead>
            <tr>
              {canEnroll ? (
                <th className="w-9 pl-4 pr-0">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!selectable.length} aria-label="Select people not yet in a sequence" />
                </th>
              ) : null}
              <th>Name</th>
              <th>Stage</th>
              <th>Sequence</th>
              <th>Activity</th>
              <th>Pod</th>
              <th>FO</th>
              <th>Last touch</th>
              {showActions ? <th className="sticky right-0 w-24 bg-white"></th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                {canEnroll ? (
                  <td className="pl-4 pr-0">
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                      disabled={Boolean(p.activeEnrollmentId) || p.dnd || p.optedOut}
                      aria-label={`Select ${p.name}`}
                    />
                  </td>
                ) : null}
                <td>
                  <IdentityCell name={p.name} href={`/people/${p.id}`} shape="circle" sub={[p.jobTitle, p.companyName].filter(Boolean).join(' · ') || null} />
                </td>
                <td>
                  <Badge tone={p.stage.tone} dot>
                    {p.stage.label}
                  </Badge>
                  {p.badEmail || p.badPhone ? (
                    <div className="mt-1 text-[11px] text-amber-700">{[p.badEmail ? 'bad email' : null, p.badPhone ? 'bad phone' : null].filter(Boolean).join(', ')}</div>
                  ) : null}
                </td>
                <td>
                  {p.enrollment ? (
                    <>
                      <Badge tone={p.enrollment.tone}>{p.enrollment.label}</Badge>
                      {p.enrollment.campaignName ? <div className="mt-0.5 truncate text-[11.5px] text-ink-400">{p.enrollment.campaignName}</div> : null}
                    </>
                  ) : (
                    <span className="text-[12px] text-ink-300">-</span>
                  )}
                </td>
                <td>{p.activity.length ? <DotTimeline points={p.activity} width={130} /> : <span className="text-[12px] text-ink-300">no touches</span>}</td>
                <td className="whitespace-nowrap text-[12.5px]">{p.podOwner ?? <span className="text-ink-300">-</span>}</td>
                <td className="whitespace-nowrap text-[12.5px]">{p.enrollment?.foName ?? <span className="text-ink-300">-</span>}</td>
                <td className="text-[12px]">
                  {p.lastTouch ? (
                    <>
                      <div className="max-w-[13rem] truncate text-ink-600">{p.lastTouch.summary}</div>
                      <div className="text-ink-400">{p.lastTouch.at}</div>
                    </>
                  ) : (
                    <span className="text-ink-300">-</span>
                  )}
                </td>
                {showActions ? (
                  <td className="sticky right-0 bg-white text-right shadow-[-8px_0_8px_-8px_rgba(31,35,51,0.12)]">
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
    </div>
  );
}
