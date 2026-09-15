'use client';

import { tagFilter, tagTone } from '@/lib/crm-tags';
import { useFilterNavigation } from '@/components/filter-navigation';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, IdentityCell, type BadgeTone } from '@/components/ui';
import { optionLabel, optionLabels } from '@/lib/twenty/labels';
import { IconPlus } from '@/components/icons';
import { PillList } from '@/components/pill-list';

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
  twentyUrl: string | null;
};

type Props = {
  rows: PeopleTableRow[];
  canEnroll: boolean;
};

/** CRM tags and campaign membership with bulk selection. */

function Tag({ value, field }: { value: string; field?: string }) {
  const navigate = useFilterNavigation();
  const filter = field ? { key: field, value } : tagFilter(value);
  return <button type="button" aria-label={`Filter by ${optionLabel(value)}`} className="rounded-md text-left focus-visible:ring-2 focus-visible:ring-brand-300" onClick={() => navigate(next => { next.set(filter.key, filter.value); next.delete('page'); })}><Badge tone={tagTone(value)}>{optionLabel(value)}</Badge></button>;
}

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

  const showNext = rows.some((p) => p.next?.action || p.next?.due);
  return (
    <div>
      {canEnroll && selected.size ? (
        <div className="flex flex-wrap items-center gap-3 border-y border-brand-100 bg-brand-50/70 px-4 py-2 text-[12.5px] text-brand-800">
          <span className="font-medium">{selected.size} selected</span>
          <Link href={bulkHref} className="btn-primary btn-sm">
            <IconPlus size={13} /> Create campaign
          </Link>
          <button type="button" className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}
      <div className="overflow-x-auto scroll-thin">
        <table className="table table-people w-full table-fixed">
          {/* Fixed widths that add up to the table, so the list never scrolls sideways: the
              select column takes the remaining 4%. */}
          <colgroup>
            {canEnroll ? <col className="w-10" /> : null}
            <col style={{ width: showNext ? '26%' : '32%' }} />
            <col style={{ width: showNext ? '25%' : '27%' }} />
            {showNext ? <col style={{ width: '12%' }} /> : null}
            <col style={{ width: showNext ? '21%' : '25%' }} />
            <col style={{ width: '12%' }} />
          </colgroup>
          <thead>
            <tr>
              {canEnroll ? (
                <th className="w-9 pl-4 pr-0">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!selectable.length} aria-label="Select people not yet in a sequence" />
                </th>
              ) : null}
              <th>Name</th>
              <th>Tags in Twenty</th>
              {showNext ? <th>Next in Twenty</th> : null}
              <th>Campaign / sequence</th>
              <th>Pod</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={selected.has(p.id) ? 'bg-brand-50/70' : undefined}>
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
                <td title={p.leadSource.length ? `Lead source: ${optionLabels(p.leadSource)}` : undefined}>
                  <PillList
                    items={[
                      ...(p.tier ? [{ label: optionLabel(p.tier), node: <Tag value={p.tier} field="tier" /> }] : []),
                      ...(p.listCategory ? [{ label: optionLabel(p.listCategory), node: <Tag value={p.listCategory} field="listCategory" /> }] : []),
                      ...p.tags.map(tag => ({ label: optionLabel(tag), node: <Tag value={tag} /> })),
                    ]}
                  />
                </td>
                {showNext ? <td className="text-[12px]">
                  {p.next?.action || p.next?.due ? (
                    <>
                      <div className="max-w-[11rem] truncate text-ink-700">{p.next.action ?? '-'}</div>
                      {p.next.due ? (
                        <div className={p.next.overdue ? 'font-medium text-red-600' : ' text-ink-500'}>
                          {p.next.due}
                          {p.next.step ? ` · ${optionLabel(p.next.step)}` : ''}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-ink-300">-</span>
                  )}
                </td> : null}
                <td>
                  {p.enrollment ? (
                    <>
                      <Badge tone={p.enrollment.tone}>{p.enrollment.label}</Badge>
                      <div title={p.enrollment.campaignName ?? undefined} className="mt-1 truncate font-medium text-ink-900">{p.enrollment.campaignId ? <Link href={`/campaigns/${p.enrollment.campaignId}`} className="hover:text-brand-700 hover:underline">{p.enrollment.campaignName}</Link> : 'Direct enrollment'}</div><div title={p.enrollment.sequenceName} className="mt-0.5 truncate text-xs text-ink-500">{p.enrollment.sequenceName}</div>
                    </>
                  ) : (
                    <span className="text-[12px] text-ink-300">-</span>
                  )}
                </td>
                <td className="break-words text-[12.5px]">
                  {p.podName ?? <span className="text-ink-300">-</span>}
                  {p.enrollment?.foName ? <div className="text-[11px] text-ink-500"><span className="text-ink-400">FO</span> {p.enrollment.foName}</div> : null}
                </td>

              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
