'use client';

import { tagFilter, tagTone } from '@/lib/crm-tags';
import { useFilterNavigation } from '@/components/filter-navigation';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, IdentityCell, type BadgeTone } from '@/components/ui';
import { optionLabel, optionLabels } from '@/lib/twenty/labels';
import { PillList } from '@/components/pill-list';
import { AddToCampaign, RemoveFromCampaign } from '@/components/campaigns/add-to-campaign';

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
  /** The campaign this row shows: running first, then upcoming, then the latest finished. */
  campaign: { id: string; name: string; label: string; tone: BadgeTone } | null;
  /** The sequence behind it, and where the person is in it. */
  sequence: { id: string; name: string; step: number | null; steps: number } | null;
  foName: string | null;
  activeEnrollmentId: string | null;
  twentyUrl: string | null;
};

type Props = {
  rows: PeopleTableRow[];
  canEnroll: boolean;
  /** Set when the list is filtered to one campaign, so its people can be taken out of it here. */
  campaignFilter?: { id: string; name: string; canManage: boolean } | null;
};

function Tag({ value, field }: { value: string; field?: string }) {
  const navigate = useFilterNavigation();
  const filter = field ? { key: field, value } : tagFilter(value);
  return <button type="button" aria-label={`Filter by ${optionLabel(value)}`} className="rounded-md text-left focus-visible:ring-2 focus-visible:ring-brand-300" onClick={() => navigate(next => { next.set(filter.key, filter.value); next.delete('page'); })}><Badge tone={tagTone(value)}>{optionLabel(value)}</Badge></button>;
}

/** The directory: CRM tags, the campaign and the sequence by name, and a selection to add to a campaign. */
export function PeopleTable({ rows, canEnroll, campaignFilter = null }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectable = rows.filter((r) => !r.dnd && !r.optedOut);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.id)));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const chosen = [...selected];
  const showNext = rows.some((p) => p.next?.action || p.next?.due);
  const removable = Boolean(campaignFilter?.canManage);

  return (
    <div>
      {canEnroll && selected.size ? (
        <div className="flex flex-wrap items-center gap-3 border-y border-brand-100 bg-brand-50/70 px-4 py-2 text-[12.5px] text-brand-800">
          <span className="font-medium">{selected.size} selected</span>
          <AddToCampaign personIds={chosen} onDone={() => setSelected(new Set())} />
          {removable ? <RemoveFromCampaign campaignId={campaignFilter!.id} campaignName={campaignFilter!.name} personIds={chosen} onDone={() => setSelected(new Set())} /> : null}
          <button type="button" className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}
      <div className="overflow-x-auto scroll-thin">
        <table className="table table-people w-full table-fixed">
          {/* Fixed shares that add up to the table, so the list never scrolls sideways; the select column takes the remaining 4%. */}
          <colgroup>
            {canEnroll ? <col className="w-10" /> : null}
            <col style={{ width: showNext ? '24%' : '27%' }} />
            <col style={{ width: showNext ? '20%' : '23%' }} />
            {showNext ? <col style={{ width: '11%' }} /> : null}
            <col style={{ width: showNext ? '15%' : '17%' }} />
            <col style={{ width: showNext ? '14%' : '17%' }} />
            <col style={{ width: '12%' }} />
          </colgroup>
          <thead>
            <tr>
              {canEnroll ? (
                <th className="w-9 pl-4 pr-0">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!selectable.length} aria-label="Select people" />
                </th>
              ) : null}
              <th>Name</th>
              <th>Tags in Twenty</th>
              {showNext ? <th>Next in Twenty</th> : null}
              <th>Campaign</th>
              <th>Sequence</th>
              <th>Pod</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={selected.has(p.id) ? 'bg-brand-50/70' : undefined}>
                {canEnroll ? (
                  <td className="pl-4 pr-0">
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} disabled={p.dnd || p.optedOut} aria-label={`Select ${p.name}`} />
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
                      <div className="truncate text-ink-700">{p.next.action ?? '-'}</div>
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
                  {p.campaign ? (
                    <>
                      <div title={p.campaign.name} className="line-clamp-2 break-words text-[13px] font-medium leading-5 text-ink-900"><Link href={`/campaigns/${p.campaign.id}`} className="hover:text-brand-700 hover:underline">{p.campaign.name}</Link></div>
                      <div className="mt-1 flex items-center gap-2"><Badge tone={p.campaign.tone}>{p.campaign.label}</Badge>{removable && campaignFilter && p.campaign.id === campaignFilter.id ? <RemoveFromCampaign campaignId={campaignFilter.id} campaignName={campaignFilter.name} personIds={[p.id]} className="btn-ghost btn-sm !px-1.5 !text-[11.5px]" /> : null}</div>
                    </>
                  ) : (
                    <span className="text-[12px] text-ink-300">-</span>
                  )}
                </td>
                <td>
                  {p.sequence ? (
                    <>
                      <div title={p.sequence.name} className="truncate text-[13px] text-ink-900"><Link href={`/sequences/${p.sequence.id}`} className="hover:text-brand-700 hover:underline">{p.sequence.name}</Link></div>
                      <div className="mt-0.5 text-[12px] text-ink-500">{p.sequence.step === null ? 'Not started' : `Step ${p.sequence.step + 1} of ${p.sequence.steps}`}{p.foName ? <span className="text-ink-400"> · {p.foName}</span> : null}</div>
                    </>
                  ) : (
                    <span className="text-[12px] text-ink-300">-</span>
                  )}
                </td>
                <td className="break-words text-[12.5px]">
                  {p.podName ?? <span className="text-ink-300">-</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
