'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ActivityKind } from '@/lib/activity-query';
import { ActionIcon, IconSearch } from '@/components/icons';
import { Field } from '@/components/ui';

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
};

export function ActivityToolbar({ users, pods, actorId, podId, kinds, channel, q, from, to }: Props) {
  const [pod, setPod] = useState(podId ?? '');
  const [actor, setActor] = useState(actorId ?? '');
  const availableUsers = pod ? users.filter((user) => user.podIds.includes(pod)) : users;
  const channelHref = (value: string) => {
    const params = new URLSearchParams({ from, to });
    if (actorId) params.set('actor', actorId);
    if (podId) params.set('pod', podId);
    if (q) params.set('q', q);
    if (kinds.length) params.set('kind', kinds.join(','));
    if (value) params.set('channel', value);
    return `/activity?${params.toString()}`;
  };
  return (
    <div className="w-full space-y-4">
      <nav aria-label="Activity channels" className="flex flex-wrap gap-1 border-b border-line pb-3">
        {CHANNELS.map((item) => (
          <Link key={item.value} href={channelHref(item.value)} aria-current={(channel ?? '') === item.value ? 'page' : undefined} className={(channel ?? '') === item.value ? 'chip' : 'chip-muted'}>
            {item.value ? <ActionIcon action={item.value} size={16} /> : null}{item.label}
          </Link>
        ))}
      </nav>
      <form method="get" className="grid grid-cols-2 items-end gap-3 lg:grid-cols-4 xl:grid-cols-7">
        {channel ? <input type="hidden" name="channel" value={channel} /> : null}
        <Field label="Search" className="col-span-2 xl:col-span-2">
          <div className="relative"><IconSearch size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" /><input name="q" defaultValue={q} placeholder="Search activity" aria-label="Search activity" className="!pl-9" /></div>
        </Field>
        <Field label="From"><input type="date" name="from" defaultValue={from} required /></Field>
        <Field label="Through"><input type="date" name="to" defaultValue={to} required /></Field>
        <Field label="Pod"><select name="pod" value={pod} onChange={(event) => { setPod(event.target.value); setActor(''); }}><option value="">All visible pods</option>{pods.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field label="Team member"><select name="actor" value={actor} onChange={(event) => setActor(event.target.value)}><option value="">Everyone visible</option>{availableUsers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        {!channel ? <Field label="Event type"><select name="kind" defaultValue={kinds.length === 1 ? kinds[0] : ''}><option value="">All events</option>{EVENT_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field> : null}
        <div className="col-span-2 flex flex-wrap gap-2 lg:col-span-4 xl:col-span-7"><button type="submit" className="btn-primary">Apply filters</button><Link href="/activity" className="btn-ghost">Reset</Link></div>
      </form>
    </div>
  );
}
