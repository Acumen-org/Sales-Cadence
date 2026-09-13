'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { Badge, DotTimeline, IdentityCell, TierBadge, touchTitle, type BadgeTone, type TimelinePoint } from '@/components/ui';
import { optionLabel, optionLabels } from '@/lib/twenty/labels';
import { ActionIcon, IconPlus } from '@/components/icons';

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
  lastTouch: { summary: string; at: string; channel: 'EMAIL' | 'CALL' | 'LINKEDIN' | 'MEETING'; inbound: boolean } | null;
  activity: TimelinePoint[];
  twentyUrl: string | null;
};

type Props = {
  rows: PeopleTableRow[];
  canEnroll: boolean;
  /** The render's clock, from the server, so the activity window is the same on both sides. */
  now: number;
};

/** People list with stages, an activity timeline, row actions and bulk "add to sequence". */
/**
 * The CRM tags left to show. Twenty carries the same fact as both a field and a tag - a person
 * marked do-not-contact has the flag and the tag, a person with no address has the flag and
 * MISSING_EMAIL - and the badges above are built from the fields. Rendering both put the same
 * word in the cell twice, so anything already said is dropped here.
 */
const MAX_PILLS = 2;

/** Tags expand in the row, accessible by keyboard and touch as well as a pointer. */
function Pills({ items }: { items: { label: string; node: React.ReactNode }[] }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const unique = items.filter((item, index) => items.findIndex((other) => other.label.toLowerCase() === item.label.toLowerCase()) === index);
  const shown = expanded ? unique : unique.slice(0, MAX_PILLS);
  const remaining = unique.length - MAX_PILLS;
  return (
    <div id={id} className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
      {shown.map((item) => <span className="min-w-0 max-w-full" key={item.label}>{item.node}</span>)}
      {remaining > 0 ? <button type="button" aria-expanded={expanded} aria-controls={id} aria-label={expanded ? 'Show fewer tags' : `Show ${remaining} more tags`} onClick={() => setExpanded(!expanded)} className="rounded-md px-1.5 py-1 text-[11.5px] font-semibold text-ink-600 hover:bg-brand-50 hover:text-brand-800 focus-visible:ring-2 focus-visible:ring-brand-300">{expanded ? 'Less' : `+${remaining}`}</button> : null}
    </div>
  );
}

function distinctTags(p: PeopleTableRow): string[] {
  const shown = new Set(
    [p.standing.label, p.listCategory ? optionLabel(p.listCategory) : null, ...p.warnings.map((w) => w.label)]
      .filter((label): label is string => Boolean(label))
      .map((label) => label.toLowerCase()),
  );
  return p.tags.filter((tag) => !shown.has(optionLabel(tag).toLowerCase()));
}

export function PeopleTable({ rows, canEnroll, now }: Props) {
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
        <table className="table table-people min-w-[1040px] table-fixed">
          <colgroup>
            {canEnroll ? <col className="w-10" /> : null}
            <col style={{ width: showNext ? '23%' : '26%' }} />
            <col style={{ width: '20%' }} />
            {showNext ? <col style={{ width: '12%' }} /> : null}
            <col style={{ width: showNext ? '16%' : '20%' }} />
            <col style={{ width: '12%' }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              {canEnroll ? (
                <th className="w-9 pl-4 pr-0">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!selectable.length} aria-label="Select people not yet in a sequence" />
                </th>
              ) : null}
              <th>Name</th>
              <th>In Twenty</th>
              {showNext ? <th>Next in Twenty</th> : null}
              <th>Campaign / sequence</th>
              <th>Pod</th>
              <th>Recent activity</th>
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
                {/* Everything Twenty says about the person, each value once. Standing, tier and
                    the data-quality flags are derived from fields Twenty also carries as tags, so
                    a tag already shown as a badge is dropped rather than repeated. */}
                <td title={p.leadSource.length ? `Lead source: ${optionLabels(p.leadSource)}` : undefined}>
                  <div className="mb-2"><Badge tone={p.standing.tone} dot>{p.standing.label}</Badge></div>
                  <Pills
                    items={[
                      ...(p.tier ? [{ label: p.tier, node: <TierBadge tier={p.tier} /> }] : []),
                      ...(p.listCategory ? [{ label: optionLabel(p.listCategory), node: <Badge tone="gray">{optionLabel(p.listCategory)}</Badge> }] : []),
                      ...p.warnings.map((w) => ({ label: w.label, node: <Badge tone={w.tone}>{w.label}</Badge> })),
                      ...distinctTags(p).map((tag) => ({ label: optionLabel(tag), node: <Badge tone="gray">{optionLabel(tag)}</Badge> })),
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
                <td className="text-[12px]">
                  {p.lastTouch ? (
                    <>
                      <div className="flex min-w-0 max-w-[13rem] items-center gap-1.5" title={p.lastTouch.summary}>
                        <span className={p.lastTouch.inbound ? 'shrink-0 text-emerald-700' : 'shrink-0 text-ink-400'}><ActionIcon action={p.lastTouch.channel} size={13} /></span>
                        <span className="min-w-0 truncate text-ink-600">{touchTitle(p.lastTouch.summary)}</span>
                      </div>
                      <div className="mt-0.5 font-medium text-ink-700">{p.lastTouch.at}</div>
                    </>
                  ) : (
                    <span className="text-ink-300">-</span>
                  )}
                  {p.activity.length ? <div className="mt-1 overflow-hidden"><DotTimeline points={p.activity} now={now} width={110} /></div> : null}
                </td>

              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
