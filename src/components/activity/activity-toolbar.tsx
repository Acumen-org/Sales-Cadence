'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import type { ActivityKind } from '@/lib/activity-query';
import { ActionIcon, IconFilter, IconSearch } from '@/components/icons';
import { useFilterNavigation } from '@/components/filter-navigation';
import { useSearchBox } from '@/components/search-box';

const EVENT_TYPES: { value: ActivityKind; label: string }[] = [
  { value: 'touch', label: 'Outreach' }, { value: 'task', label: 'Task updates' },
  { value: 'enrollment', label: 'Enrollment updates' }, { value: 'meeting', label: 'Meetings' },
  { value: 'campaign', label: 'Campaign updates' }, { value: 'sequence', label: 'Sequence edits' },
  { value: 'person', label: 'Contact updates' },
];
const CHANNELS = [
  { value: '', label: 'All activity' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'CALL', label: 'Calls' },
  { value: 'LINKEDIN', label: 'LinkedIn' },
];

type Props = {
  users: { id: string; name: string; podIds: string[] }[];
  pods: { id: string; name: string }[];
  actorId: string | null;
  podId: string | null;
  kinds: ActivityKind[];
  channel: string | null;
  q: string;
  from: string;
  to: string;
  /** The range the page opened on, so Reset can go back to it. */
  defaultRange: { from: string; to: string };
};

/**
 * One row: the channel, search, pod and team member, then a Filters button for the dates and the
 * event type. Every change applies at once through the shared navigation; an empty pod or member
 * is kept in the URL as the reader's choice of All, not the default.
 */
export function ActivityToolbar({ users, pods, actorId, podId, kinds, channel, q, from, to, defaultRange }: Props) {
  const navigate = useFilterNavigation();
  const panelId = useId();
  const kind = kinds.length === 1 ? kinds[0] : '';
  const rangeChanged = from !== defaultRange.from || to !== defaultRange.to;
  const more = [rangeChanged ? 'range' : '', kind].filter(Boolean).length;
  const [showMore, setShowMore] = useState(() => more > 0);
  const set = (patch: Record<string, string | null>) => navigate((next) => {
    for (const [key, value] of Object.entries(patch)) { if (value === null) next.delete(key); else next.set(key, value); }
    next.delete('page');
  });
  const { text, setText, reset } = useSearchBox(q, (value) => set({ q: value || null }));
  const availableUsers = podId ? users.filter((user) => user.podIds.includes(podId)) : users;
  const active = Boolean(q || actorId || podId || channel || more);

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Activity channels" className="flex flex-wrap gap-1">
          {CHANNELS.map((item) => (
            <button key={item.value} type="button" onClick={() => set({ channel: item.value || null })} aria-pressed={(channel ?? '') === item.value} className={(channel ?? '') === item.value ? 'chip' : 'chip-muted'}>
              {item.value ? <ActionIcon action={item.value} size={16} /> : null}{item.label}
            </button>
          ))}
        </nav>
        <div className="relative w-full max-w-[220px]">
          <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search activity" aria-label="Search activity" className="!pl-9" />
        </div>
        <select value={podId ?? ''} onChange={(e) => set({ pod: e.target.value, actor: '' })} aria-label="Filter by pod" className="!w-auto !py-2 !text-[12.5px]">
          <option value="">All visible pods</option>
          {pods.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select value={actorId ?? ''} onChange={(e) => set({ actor: e.target.value })} aria-label="Filter by team member" className="!w-auto !py-2 !text-[12.5px]">
          <option value="">Everyone visible</option>
          {availableUsers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" onClick={() => setShowMore(!showMore)} aria-expanded={showMore} aria-controls={panelId} className={`btn-secondary btn-sm ${showMore || more ? '!border-brand-300 !bg-brand-50 !text-brand-800' : ''}`}>
          <IconFilter size={14} /> Filters{more ? <span className="ml-1 tabular-nums">{more}</span> : null}
        </button>
        {active ? <Link href="/activity" onClick={() => reset()} className="btn-ghost btn-sm">Reset</Link> : null}
      </div>
      {showMore ? (
        <div id={panelId} className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <label className="flex items-center gap-2 text-[12px] text-ink-500">From<input type="date" value={from} onChange={(e) => { if (e.target.value) set({ from: e.target.value }); }} aria-label="From" className="!w-auto !py-2 !text-[12.5px]" /></label>
          <label className="flex items-center gap-2 text-[12px] text-ink-500">Through<input type="date" value={to} onChange={(e) => { if (e.target.value) set({ to: e.target.value }); }} aria-label="Through" className="!w-auto !py-2 !text-[12.5px]" /></label>
          {!channel ? (
            <select value={kind} onChange={(e) => set({ kind: e.target.value || null })} aria-label="Event type" className="!w-auto !py-2 !text-[12.5px]">
              <option value="">All events</option>
              {EVENT_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
