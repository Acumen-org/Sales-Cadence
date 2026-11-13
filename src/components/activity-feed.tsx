'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { formatInTimeZone } from 'date-fns-tz';
import { addDays, formatLocalDate, type LocalDate } from '@/lib/dates';
import type { FeedItem, FeedKind } from '@/lib/feed';
import { IconCalendar, IconCampaigns, IconLinkedin, IconMail, IconNote, IconPhone } from '@/components/icons';

/** Each kind of event looks the same wherever it is shown: its icon, its colour, its word. */
const KIND: Record<FeedKind, { label: string; plural: string; chip: string; Icon: typeof IconMail }> = {
  call: { label: 'Call', plural: 'Calls', chip: 'bg-sky-50 text-sky-700 ring-sky-200/70', Icon: IconPhone },
  email: { label: 'Email', plural: 'Emails', chip: 'bg-brand-50 text-brand-700 ring-brand-200/70', Icon: IconMail },
  linkedin: { label: 'LinkedIn', plural: 'LinkedIn', chip: 'bg-blue-50 text-blue-700 ring-blue-200/70', Icon: IconLinkedin },
  meeting: { label: 'Meeting', plural: 'Meetings', chip: 'bg-violet-50 text-violet-700 ring-violet-200/70', Icon: IconCalendar },
  note: { label: 'Note', plural: 'Notes', chip: 'bg-amber-50 text-amber-700 ring-amber-200/70', Icon: IconNote },
  campaign: { label: 'Campaign', plural: 'Campaign', chip: 'bg-canvas text-ink-600 ring-line', Icon: IconCampaigns },
};
const ORDER: FeedKind[] = ['call', 'email', 'linkedin', 'meeting', 'note', 'campaign'];

/** "Email received", "Call", "LinkedIn message sent": what it was, and which way it went. */
function kindWords(i: FeedItem): string {
  if (i.label) return i.label;
  const base = KIND[i.kind].label;
  if (i.kind === 'email') return i.direction === 'in' ? 'Email received' : i.direction === 'out' ? 'Email sent' : base;
  if (i.kind === 'linkedin') return i.direction === 'in' ? 'LinkedIn reply' : base;
  if (i.kind === 'call') return i.direction === 'in' ? 'Call received' : 'Call';
  return base;
}

const LONG = 280;

function Item({ item, timezone, showPerson }: { item: FeedItem; timezone: string; showPerson: boolean }) {
  const [open, setOpen] = useState(false);
  const k = KIND[item.kind];
  const long = Boolean(item.body && (item.body.length > LONG || item.body.split('\n').length > 4));
  const meta = [item.who ? `by ${item.who}` : null, item.source].filter((m): m is string => Boolean(m));
  return <li className="flex gap-3 px-4 py-3">
    <span aria-hidden className={clsx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1', k.chip)}><k.Icon size={15} /></span>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={clsx('text-[11.5px] font-semibold uppercase tracking-wide', item.direction === 'in' ? 'text-emerald-700' : 'text-ink-500')}>{kindWords(item)}</span>
        {showPerson && item.person ? <Link href={item.person.href} className="text-[12.5px] font-medium text-ink-900 hover:text-brand-700">{item.person.name}</Link> : null}
        <time dateTime={item.at} className="ml-auto shrink-0 text-[12px] tabular-nums text-ink-500">{formatInTimeZone(new Date(item.at), timezone, 'HH:mm')}</time>
      </div>
      <div className="mt-0.5 break-words text-[13.5px] font-medium text-ink-900">
        {item.href ? <Link href={item.href} className="hover:text-brand-700">{item.title}</Link> : item.title}
      </div>
      {meta.length || item.fields?.length ? <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-600">
        {meta.map((m) => <span key={m}>{m}</span>)}
        {item.fields?.map((f) => <span key={`${f.label}${f.value}`}><span className="text-ink-500">{f.label}:</span> <span className="text-ink-800">{f.value}</span></span>)}
      </div> : null}
      {item.body ? <div className="mt-2 rounded-lg border border-line bg-canvas/60 px-3 py-2">
        <p className={clsx('max-w-[75ch] whitespace-pre-wrap break-words text-[13px] leading-6 text-ink-800', long && !open && 'line-clamp-4')}>{item.body}</p>
        {long ? <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-[12.5px] font-medium text-brand-700 hover:underline">{open ? 'Show less' : 'Show more'}</button> : null}
      </div> : null}
      {item.recordingHref ? <audio controls preload="none" className="mt-2 h-8" src={item.recordingHref} /> : null}
    </div>
  </li>;
}

/**
 * The feed: filter chips with counts, then the events by day, newest first. `limit` makes the short
 * version for an Overview (no chips, a link to the rest). `showPerson` names whom each event was about
 * (an account's feed).
 */
export function ActivityFeed({ items, timezone, today, limit, showPerson = false, allHref, empty = 'Nothing has happened yet.' }: {
  items: FeedItem[]; timezone: string; today: LocalDate; limit?: number; showPerson?: boolean; allHref?: string; empty?: string;
}) {
  const [kind, setKind] = useState<FeedKind | 'all'>('all');
  const counts = useMemo(() => ORDER.map((k) => ({ k, n: items.filter((i) => i.kind === k).length })).filter((c) => c.n), [items]);
  const shown = (kind === 'all' ? items : items.filter((i) => i.kind === kind)).slice(0, limit ?? Infinity);
  const days = useMemo(() => {
    const out: { day: string; items: FeedItem[] }[] = [];
    for (const i of shown) {
      const day = formatInTimeZone(new Date(i.at), timezone, 'yyyy-MM-dd');
      const last = out[out.length - 1];
      if (last?.day === day) last.items.push(i); else out.push({ day, items: [i] });
    }
    return out;
  }, [shown, timezone]);
  const dayWords = (d: string) => d === today ? `Today · ${formatLocalDate(d as LocalDate, 'long')}` : d === addDays(today, -1) ? `Yesterday · ${formatLocalDate(d as LocalDate, 'long')}` : formatLocalDate(d as LocalDate, 'long');
  if (!items.length) return <p className="p-4 text-[13px] text-ink-500">{empty}</p>;
  return <div>
    {limit ? null : <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3">
      {[{ k: 'all' as const, n: items.length }, ...counts].map(({ k, n }) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
        className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-medium transition', kind === k ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-line bg-white text-ink-600 hover:bg-canvas')}>
        {k === 'all' ? 'All' : KIND[k].plural}<span className="tabular-nums text-ink-500">{n}</span>
      </button>)}
    </div>}
    {days.map((d) => <section key={d.day}>
      <h3 className="border-b border-line bg-canvas/70 px-4 py-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">{dayWords(d.day)}</h3>
      <ol className="divide-y divide-line">{d.items.map((i) => <Item key={i.key} item={i} timezone={timezone} showPerson={showPerson} />)}</ol>
    </section>)}
    {limit && allHref && items.length > shown.length ? <div className="border-t border-line px-4 py-2.5"><Link href={allHref} className="text-[12.5px] font-medium text-brand-700 hover:underline">All activity ({items.length})</Link></div> : null}
  </div>;
}
