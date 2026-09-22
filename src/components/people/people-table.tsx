'use client';

import { tagFilter, tagTone } from '@/lib/crm-tags';
import { useFilterNavigation } from '@/components/filter-navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, IdentityCell, type BadgeTone, TierBadge } from '@/components/ui';
import { optionLabel, optionLabels } from '@/lib/twenty/labels';
import { PillList } from '@/components/pill-list';
import { AddToCampaign, RemoveFromCampaigns } from '@/components/campaigns/add-to-campaign';
import { MipStars } from './mip-stars';

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
  /** In an upcoming or running campaign right now. */
  inCampaign: boolean;
  /** Twenty's MIP tag, and the pod's stars on it. */
  mip: boolean;
  stars: number;
  canRate: boolean;
  foName: string | null;
  activeEnrollmentId: string | null;
  twentyUrl: string | null;
};

type Props = {
  rows: PeopleTableRow[];
};

function Tag({ value, field }: { value: string; field?: string }) {
  const navigate = useFilterNavigation();
  const filter = field ? { key: field, value } : tagFilter(value);
  return <button type="button" aria-label={`Filter by ${optionLabel(value)}`} className="rounded-md text-left focus-visible:ring-2 focus-visible:ring-brand-300" onClick={() => navigate(next => { next.set(filter.key, filter.value); next.delete('page'); })}>{field === 'tier' ? <TierBadge tier={value} /> : <Badge tone={tagTone(value)}>{optionLabel(value)}</Badge>}</button>;
}

/** The directory: CRM tags, the campaign and the sequence by name, and a selection to add to a campaign. */
export function PeopleTable({ rows }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 8000); return () => clearTimeout(timer); }, [notice]);
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
  const chosen = rows.filter(r => selected.has(r.id)).map(r => r.id);
  const chosenRows = rows.filter((r) => selected.has(r.id));
  const inCampaigns = chosenRows.filter((r) => r.inCampaign && r.campaign).map((r) => ({ id: r.id, campaignId: r.campaign!.id, campaignName: r.campaign!.name }));
  const showNext = rows.some((p) => p.next?.action || p.next?.due);

  return (
    <div>
      {notice && <div role="status" className="fixed bottom-6 right-6 z-50 max-w-[min(90vw,28rem)] rounded-lg bg-ink-900 px-4 py-3 text-sm text-white shadow-lg">{notice}<button type="button" aria-label="Dismiss campaign notification" className="ml-3" onClick={() => setNotice(null)}>&times;</button></div>}
      {selected.size ? (
        <div className="flex flex-wrap items-center gap-3 border-y border-brand-100 bg-brand-50/70 px-4 py-2 text-[12.5px] text-brand-800">
          <span className="font-medium">{selected.size} selected</span>
          <AddToCampaign personIds={chosenRows.filter(r => !r.inCampaign).map(r => r.id)} onDone={() => setSelected(new Set())} disabled={chosenRows.every((r) => r.inCampaign)} disabledTitle={chosenRows.every((r) => r.inCampaign) ? (chosen.length === 1 ? 'Already in a campaign' : 'Everyone chosen is already in a campaign') : undefined} />
          <RemoveFromCampaigns people={inCampaigns} onDone={message => { setSelected(new Set()); setNotice(message ?? 'People removed from campaign.'); }} />
          <button type="button" className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}
      <div className="overflow-x-auto scroll-thin">
        <table className="table table-people w-full table-fixed">
          {/* Fixed shares that add up to the table, so the list never scrolls sideways; the select column takes the remaining 4%. */}
          <colgroup>
            <col className="w-10" />
            <col style={{ width: showNext ? '24%' : '27%' }} />
            <col style={{ width: showNext ? '20%' : '23%' }} />
            {showNext ? <col style={{ width: '11%' }} /> : null}
            <col style={{ width: showNext ? '15%' : '17%' }} />
            <col style={{ width: showNext ? '10%' : '12%' }} />
            <col style={{ width: '12%' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="w-9 pl-4 pr-0">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!selectable.length} aria-label="Select people" />
              </th>
              <th>Name</th>
              <th>Tags in Twenty</th>
              {showNext ? <th>Next in Twenty</th> : null}
              <th>Campaign</th>
              <th>MIP</th>
              <th>Pod</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={selected.has(p.id) ? 'bg-brand-50/70' : undefined}>
                <td className="pl-4 pr-0">
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} disabled={p.dnd || p.optedOut} aria-label={`Select ${p.name}`} />
                </td>
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
                    max={1}
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
                      <div className="mt-1 flex items-center gap-2"><Badge tone={p.campaign.tone}>{p.campaign.label}</Badge></div>
                    </>
                  ) : (
                    <span className="text-[12px] text-ink-300">-</span>
                  )}
                </td>
                <td>
                  {p.mip ? <MipStars personId={p.id} name={p.name} stars={p.stars} canRate={p.canRate} /> : <span className="text-[12px] text-ink-300">-</span>}
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
