'use client';

import { tagFilter, tagTone } from '@/lib/crm-tags';
import { useFilterNavigation } from '@/components/filter-navigation';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, IdentityCell, type BadgeTone, TierBadge } from '@/components/ui';
import { optionLabel, optionLabels } from '@/lib/twenty/labels';
import { PillList } from '@/components/pill-list';
import { AddToCampaign, RemoveFromCampaigns } from '@/components/campaigns/add-to-campaign';
import { SubjectBadges } from '@/components/subject-badges';
import { UndoMoveButton } from '@/components/sandbox/move-undo';
import { ColdBulkActions, type ColdBulkOptions } from '@/components/sandbox/cold-bulk-actions';
import { BULK_ACTS, type ColdTableRow } from '@/lib/sandbox/list-view';
import { MipStars } from './mip-stars';
import { NextActionButton } from './next-action-form';

export type PeopleTableRow = {
  id: string;
  name: string;
  jobTitle: string | null;
  companyName: string | null;
  /** The CRM account they work at, for the Account column's link. */
  companyId: string | null;
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
  /** Twenty's Next Action and its due date: set in Twenty, or by a next action set here. */
  next: { action: string | null; due: string | null; step: string | null; overdue: boolean } | null;
  dnd: boolean;
  optedOut: boolean;
  /** The campaign this row shows: running first, then upcoming, then the latest finished. */
  campaign: { id: string; name: string; label: string; tone: BadgeTone; canRemove: boolean } | null;
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
  variant?: 'crm';
  rows: PeopleTableRow[];
  /** Whether this reader may move people in or out of campaigns; Biz Ops only reads. */
  canMove?: boolean;
  /** Whether this reader sets next actions, and to whom they can give them. */
  nextActions?: { canSet: boolean; canAssign: boolean; fos: { id: string; name: string }[]; today: string };
};

function Tag({ value, field }: { value: string; field?: string }) {
  const navigate = useFilterNavigation();
  const filter = field ? { key: field, value } : tagFilter(value);
  return <button type="button" aria-label={`Filter by ${optionLabel(value)}`} className="rounded-md text-left focus-visible:ring-2 focus-visible:ring-brand-300" onClick={() => navigate(next => { next.set(filter.key, filter.value); next.delete('page'); })}>{field === 'tier' ? <TierBadge tier={value} /> : <Badge tone={tagTone(value)}>{optionLabel(value)}</Badge>}</button>;
}

/** The selected ids still on screen: a filter, a page or a refresh that hides a row takes it out of the selection (B056). */
export function shownSelection(selected: Set<string>, rows: { id: string }[]): Set<string> {
  const kept = new Set([...selected].filter((id) => rows.some((r) => r.id === id)));
  return kept.size === selected.size ? selected : kept;
}

/** A selection of rows that only ever holds rows on screen, so an action only reaches who is shown. */
function useRowSelection(rows: { id: string }[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected((s) => shownSelection(s, rows));
  }, [rows]);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return { selected, setSelected, toggle };
}

/** The bar over a selection: how many, the actions that fit, and Clear (unless the actions place it themselves). */
function SelectionBar({ count, onClear, children }: { count: number; onClear?: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-y border-brand-100 bg-brand-50/70 px-4 py-2 text-[12.5px] text-brand-800">
      <span className="font-medium">{count} selected</span>
      {children}
      {onClear ? (
        <button type="button" className="btn-ghost btn-sm" onClick={onClear}>
          Clear
        </button>
      ) : null}
    </div>
  );
}

/**
 * The directory: CRM people, or with `variant: 'cold'` Cold outreach's contacts (PLAN 4.1). Both share
 * the selection, which keeps only rows on screen (B056), the selection bar and the identity cell.
 */
export function PeopleTable(props: Props | ColdProps) {
  return props.variant === 'cold' ? <ColdPeopleTable {...props} /> : <CrmPeopleTable {...props} />;
}

/** The directory: CRM tags, the campaign and the sequence by name, and a selection to add to a campaign. */
function CrmPeopleTable({ rows, canMove = true, nextActions }: Props) {
  const { selected, setSelected, toggle } = useRowSelection(rows);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 8000); return () => clearTimeout(timer); }, [notice]);
  // Somebody who can do nothing with a selection (Biz Ops) gets no checkboxes.
  const canSelect = canMove || Boolean(nextActions?.canSet);
  const selectable = rows.filter((r) => !r.dnd && !r.optedOut);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.id)));
  const chosen = rows.filter(r => selected.has(r.id)).map(r => r.id);
  const chosenRows = rows.filter((r) => selected.has(r.id));
  const inCampaigns = chosenRows.filter((r) => r.inCampaign && r.campaign?.canRemove).map((r) => ({ id: r.id, campaignId: r.campaign!.id, campaignName: r.campaign!.name }));
  const showNext = rows.some((p) => p.next?.action || p.next?.due);

  return (
    <div>
      {notice && <div role="status" className="fixed bottom-6 right-6 z-50 max-w-[min(90vw,28rem)] rounded-lg bg-ink-900 px-4 py-3 text-sm text-white shadow-lg">{notice}<button type="button" aria-label="Dismiss campaign notification" className="ml-3" onClick={() => setNotice(null)}>&times;</button></div>}
      {chosen.length ? (
        <SelectionBar count={chosen.length} onClear={() => setSelected(new Set())}>
          {canMove ? <><AddToCampaign personIds={chosenRows.filter(r => !r.inCampaign).map(r => r.id)} alreadyIn={chosenRows.filter(r => r.inCampaign).length} onDone={(message) => { setSelected(new Set()); if (message) setNotice(message); }} disabled={chosenRows.every((r) => r.inCampaign)} disabledTitle={chosenRows.every((r) => r.inCampaign) ? (chosen.length === 1 ? 'Already in a campaign' : 'Everyone chosen is already in a campaign') : undefined} />{chosenRows.every((r) => r.inCampaign) ? <span className="text-brand-800/80">{chosen.length === 1 ? 'Already in a campaign' : 'Everyone chosen is already in a campaign'}</span> : null}
          <RemoveFromCampaigns people={inCampaigns} onDone={message => { setSelected(new Set()); setNotice(message ?? 'People removed from campaign.'); }} /></> : null}
          {nextActions?.canSet ? <NextActionButton personIds={chosen} today={nextActions.today} fos={nextActions.fos} canAssign={nextActions.canAssign} onDone={(message) => { setSelected(new Set()); setNotice(message); }} /> : null}
        </SelectionBar>
      ) : null}
      <div className="overflow-x-auto scroll-thin">
        <table className="table table-people w-full table-fixed">
          {/* Fixed shares that add up to the table, so the list never scrolls sideways; the select column takes the remaining 4%. */}
          <colgroup>
            <col className="w-10" />
            <col style={{ width: showNext ? '19%' : '21%' }} />
            <col style={{ width: showNext ? '14%' : '15%' }} />
            <col style={{ width: showNext ? '16%' : '18%' }} />
            {showNext ? <col style={{ width: '11%' }} /> : null}
            <col style={{ width: showNext ? '13%' : '15%' }} />
            <col style={{ width: showNext ? '9%' : '11%' }} />
            <col style={{ width: showNext ? '10%' : '12%' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="w-9 pl-4 pr-0">
                {canSelect ? <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!selectable.length} aria-label="Select people" /> : null}
              </th>
              <th>Name</th>
              <th>Account</th>
              <th>Tags in the CRM</th>
              {showNext ? <th>Next in the CRM</th> : null}
              <th>Campaign</th>
              <th>MIP</th>
              <th>Pod</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className={selected.has(p.id) ? 'bg-brand-50/70' : undefined}>
                <td className="pl-4 pr-0">
                  {canSelect ? <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} disabled={p.dnd || p.optedOut} aria-label={`Select ${p.name}`} /> : null}
                </td>
                <td>
                  <IdentityCell name={p.name} href={`/people/${p.id}`} shape="circle" sub={p.jobTitle || null} />
                </td>
                <td data-label="Account" className="break-words text-[12.5px]">
                  {p.companyId && p.companyName ? <Link href={`/accounts/${p.companyId}`} className="text-brand-700 hover:underline">{p.companyName}</Link> : p.companyName ? <span className="text-ink-700">{p.companyName}</span> : <span className="text-ink-300">-</span>}
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

type ColdProps = {
  variant: 'cold';
  rows: ColdTableRow[];
  /** Whether this reader may change cold contacts at all; Biz Ops reads only and gets no checkboxes. */
  canSelect: boolean;
  /** What the bulk bar needs: who to assign to, pods, and the date's working days. */
  bulk: ColdBulkOptions;
};

/** Each column's share of the row, so the table never scrolls sideways at 1024px; hidden columns give theirs back. */
const COLD_SHARES = { name: 23, owner: 14, status: 24, next: 13, lastCall: 14, source: 12 } as const;
/** Cells a little tighter than People's, so every column keeps its words whole at 1024px. */
const COLD_CELL = '!px-2';
/** Badges wrap in this table rather than end in "…" (B153). */
const WRAP_BADGES = '[&_.badge]:whitespace-normal [&_.truncate]:overflow-visible [&_.truncate]:whitespace-normal';
type ColdColumn = keyof typeof COLD_SHARES;

/**
 * Cold outreach's contacts (PLAN 4.1): name with title and firm, owner or amber "Unclaimed", one
 * status badge with its warning chips, what comes next (red when overdue, N083), the last call, and
 * the source with its date on hover. A column empty on every row hides, and nothing is cut off at
 * 1280px or 1024px: names and firms wrap (B153). A row's checkbox shows only what the reader may act
 * on, and the bar offers only the actions that fit (B118, B151).
 */
function ColdPeopleTable({ rows, canSelect, bulk }: ColdProps) {
  const { selected, setSelected, toggle } = useRowSelection(rows);
  const actionable = (r: ColdTableRow) => BULK_ACTS.some((a) => r.allows[a] === true);
  const selectable = canSelect ? rows.filter(actionable) : [];
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const chosen = rows.filter((r) => selected.has(r.id));
  const columns = (Object.keys(COLD_SHARES) as ColdColumn[]).filter((c) =>
    c === 'owner' ? rows.some((r) => r.owner || r.unclaimed) : c === 'next' ? rows.some((r) => r.next) : c === 'lastCall' ? rows.some((r) => r.lastCall) : true);
  const total = columns.reduce((sum, c) => sum + COLD_SHARES[c], 0);
  const share = (c: ColdColumn) => `${((COLD_SHARES[c] / total) * 96).toFixed(2)}%`;
  const has = (c: ColdColumn) => columns.includes(c);

  return (
    <div>
      {chosen.length ? (
        <SelectionBar count={chosen.length}>
          <ColdBulkActions rows={chosen} {...bulk} onDone={() => setSelected(new Set())} onClear={() => setSelected(new Set())} />
        </SelectionBar>
      ) : null}
      <div className="overflow-x-auto scroll-thin">
        <table className="table table-people w-full min-w-[720px] table-fixed">
          <colgroup>
            <col className="w-10" />
            {columns.map((c) => <col key={c} style={{ width: share(c) }} />)}
          </colgroup>
          <thead>
            <tr>
              <th className="w-9 pl-4 pr-0">
                {canSelect ? <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.id)))} disabled={!selectable.length} aria-label="Select contacts" /> : null}
              </th>
              <th className={COLD_CELL}>Name</th>
              {has('owner') ? <th className={COLD_CELL}>Owner</th> : null}
              <th className={COLD_CELL}>Status</th>
              {has('next') ? <th className={COLD_CELL}>Next</th> : null}
              {has('lastCall') ? <th className={COLD_CELL}>Last call</th> : null}
              <th className={COLD_CELL}>Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={selected.has(r.id) ? 'bg-brand-50/70' : undefined}>
                <td className="pl-4 pr-0">
                  {canSelect ? <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} disabled={!actionable(r)} title={actionable(r) ? undefined : 'Nothing you can do to this contact from the list'} aria-label={`Select ${r.name}`} /> : null}
                </td>
                <td className={COLD_CELL}>
                  <IdentityCell name={r.name} href={r.href} shape="circle" size={28} sub={r.sub} wrap />
                </td>
                {has('owner') ? <td className={`${COLD_CELL} ${WRAP_BADGES} break-words text-[12.5px]`}>
                  {r.unclaimed ? <><Badge tone="amber">Unclaimed</Badge>{r.ownerLeft && r.owner ? <div className="mt-1 text-[12px] text-ink-500">{r.owner} left</div> : null}</> : r.owner ? <span className="text-ink-700">{r.owner}</span> : <span className="text-ink-300">-</span>}
                </td> : null}
                <td className={`${COLD_CELL} ${WRAP_BADGES}`}>
                  <SubjectBadges badge={r.badge} chips={r.chips} limit={2} />
                  {r.move?.undo ? <div className="mt-1"><UndoMoveButton itemIds={[r.move.undo.itemId]} confirm={r.move.undo.confirm} campaigns={r.move.undo.campaigns} /></div> : null}
                  {r.move?.failed ? <div className={`mt-1 break-words text-[12px] ${r.move.failed.retrying ? 'text-amber-800' : 'text-red-700'}`}>{r.move.failed.retrying ? 'Not in the CRM yet' : 'Move failed'}: {r.move.failed.error}. <Link href={r.move.failed.href} className="underline">{r.move.failed.label}</Link></div> : null}
                </td>
                {has('next') ? <td className={`${COLD_CELL} break-words text-[12px]`}>
                  {r.next ? (
                    <>
                      <div className="text-ink-700">{r.next.label}</div>
                      <div className={r.next.overdue ? 'font-medium text-red-600' : 'text-ink-500'}>{r.next.overdue ? `Overdue · ${r.next.day}` : r.next.day}</div>
                    </>
                  ) : (
                    <span className="text-ink-300">-</span>
                  )}
                </td> : null}
                {has('lastCall') ? <td className={`${COLD_CELL} break-words text-[12px]`}>
                  {r.lastCall ? (
                    <>
                      <div className="text-ink-700">{r.lastCall.outcome}</div>
                      <div className="text-ink-500">{r.lastCall.day}</div>
                    </>
                  ) : (
                    <span className="text-ink-300">-</span>
                  )}
                </td> : null}
                <td className={`${COLD_CELL} break-words text-[12px] text-ink-600`}>
                  <span title={r.source.title}>{r.source.label}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
