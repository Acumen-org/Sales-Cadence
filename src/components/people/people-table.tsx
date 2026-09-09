'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, DotTimeline, IdentityCell, TierBadge, type BadgeTone, type TimelinePoint } from '@/components/ui';
import { optionLabel, optionLabels } from '@/lib/twenty/labels';
import { IconPlus } from '@/components/icons';

export type PeopleTableRow = {
  id: string;
  name: string;
  jobTitle: string | null;
  companyName: string | null;
  podName: string | null;
  /** The Cadence pod this person's podOwner maps to, for the row's "add to sequence". */
  podId: string | null;
  /** What Twenty says the person is, and the tags that carry a consequence. */
  standing: { label: string; tone: BadgeTone };
  tier: string | null;
  listCategory: string | null;
  leadSource: string[];
  tags: string[];
  warnings: { label: string; tone: BadgeTone }[];
  /** Twenty's own plan for this person, which Cadence never overwrites. */
  next: { action: string | null; due: string | null; step: string | null; overdue: boolean } | null;
  dnd: boolean;
  optedOut: boolean;
  enrollment: { status: string; label: string; tone: BadgeTone; campaignName: string | null; campaignId: string | null; sequenceName: string; foName: string } | null;
  activeEnrollmentId: string | null;
  lastTouch: { summary: string; at: string } | null;
  activity: TimelinePoint[];
  twentyUrl: string | null;
};

type Props = {
  rows: PeopleTableRow[];
  canEnroll: boolean;
};

/** People list with stages, an activity timeline, row actions and bulk "add to sequence". */
export function PeopleTable({ rows, canEnroll }: Props) {
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
          <span className="font-bold">{selected.size} selected</span>
          <Link href={bulkHref} className="btn-primary btn-sm">
            <IconPlus size={13} /> Create campaign
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
              <th>In Twenty</th>
              <th>Next in Twenty</th>
              <th>Campaign / sequence</th>
              <th>Activity</th>
              <th>Owner</th>
              <th>Last touch</th>
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
                {/* Everything Twenty says about the person in one cell: standing, tier, how
                    often they should be touched, and anything wrong with their details. */}
                <td title={p.leadSource.length ? `Lead source: ${optionLabels(p.leadSource)}` : undefined}>
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge tone={p.standing.tone} dot>
                      {p.standing.label}
                    </Badge>
                    <TierBadge tier={p.tier} />
                  </div>
                  <div className="mt-0.5 whitespace-nowrap text-[11px] font-semibold text-ink-700">
                    {p.listCategory ? optionLabel(p.listCategory) : null}
                    {p.warnings.length ? <span className="text-amber-700">{p.listCategory ? ' · ' : ''}{p.warnings.map((w) => w.label).join(' · ')}</span> : null}
                  </div>
                  {p.tags.length ? <div className="mt-1 flex flex-wrap gap-1">{p.tags.map((tag) => <Badge key={tag} tone="gray">{optionLabel(tag)}</Badge>)}</div> : null}
                </td>
                <td className="text-[12px]">
                  {p.next?.action || p.next?.due ? (
                    <>
                      <div className="max-w-[11rem] truncate text-ink-700">{p.next.action ?? '-'}</div>
                      {p.next.due ? (
                        <div className={p.next.overdue ? 'font-medium text-red-600' : 'font-semibold text-ink-700'}>
                          {p.next.due}
                          {p.next.step ? ` · ${optionLabel(p.next.step)}` : ''}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-ink-300">-</span>
                  )}
                </td>
                <td>
                  {p.enrollment ? (
                    <>
                      <Badge tone={p.enrollment.tone}>{p.enrollment.label}</Badge>
                      <div className="mt-1 font-semibold text-ink-900">{p.enrollment.campaignId ? <Link href={`/campaigns/${p.enrollment.campaignId}`} className="hover:text-brand-700 hover:underline">{p.enrollment.campaignName}</Link> : 'Direct enrollment'}</div><div className="mt-0.5 text-xs font-semibold text-ink-700">{p.enrollment.sequenceName}</div>
                    </>
                  ) : (
                    <span className="text-[12px] text-ink-300">-</span>
                  )}
                </td>
                <td>{p.activity.length ? <DotTimeline points={p.activity} width={130} /> : <span className="text-[12px] text-ink-300">no touches</span>}</td>
                <td className="whitespace-nowrap text-[12.5px]">
                  {p.podName ?? <span className="text-ink-300">-</span>}
                  {p.enrollment?.foName ? <div className="text-[11px] font-semibold text-ink-700">{p.enrollment.foName}</div> : null}
                </td>
                <td className="text-[12px]">
                  {p.lastTouch ? (
                    <>
                      <div className="max-w-[13rem] truncate font-semibold text-ink-800">{p.lastTouch.summary}</div>
                      <div className="font-semibold text-ink-700">{p.lastTouch.at}</div>
                    </>
                  ) : (
                    <span className="text-ink-300">-</span>
                  )}
                </td>

              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
