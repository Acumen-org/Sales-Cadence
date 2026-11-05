import Link from 'next/link';
import type { ReactNode } from 'react';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { REPEAT_LABELS } from '@/lib/next-actions';
import { refOf, subjectHref } from '@/lib/subject';
import type { NextActionListRow } from '@/lib/tasks-query';
import { ActionIcon, IconRefresh } from '@/components/icons';
import { Avatar, Badge, Notice, RecordFields, Surface } from '@/components/ui';
import { NextActionControls } from './next-action-controls';

/*
 * Tasks created for a person or a cold contact, outside any campaign (next actions), as the Tasks
 * screen lists and opens them. Both kinds share these: rows carry no tag, and every link goes
 * through the subject layer, so a cold contact's opens its own page, never /people (PLAN 8.13).
 */

/** Whoever the row is about: the CRM person, or the cold contact. */
export function nextSubject(n: Pick<NextActionListRow, 'person' | 'sandboxContact'>) {
  const who = n.person ?? n.sandboxContact;
  return { name: (who ? `${who.firstName} ${who.lastName}`.trim() || who.email : null) || 'Unnamed', firstName: who?.firstName ?? '', who };
}

const dueLabel = (due: string, today: string) => (due === today ? 'Today' : formatLocalDate(due));

/** Tasks created for a person, at the top of a tab's list: whose, what, how and when. */
export function NextActionList({ items, selectedId, today, showFo, href }: { items: NextActionListRow[]; selectedId: string | null; today: string; showFo: boolean; href: (id: string) => string }) {
  return <div className="border-b border-line">
    <div className="bg-canvas/60 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-500">Created tasks <span className="tabular-nums">· {items.length}</span></div>
    <ul className="divide-y divide-line">{items.map((n) => {
      const name = nextSubject(n).name;
      return <li key={n.id}>
        <Link href={href(n.id)} aria-current={n.id === selectedId ? 'true' : undefined} className={`flex items-start gap-3 px-3 py-2.5 transition hover:bg-brand-50/50 ${n.id === selectedId ? 'bg-brand-50' : ''}`}>
          <Avatar name={name} shape="circle" size={30} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-900">{name}</span><span className={`shrink-0 text-[12px] ${n.state === 'OPEN' && n.dueDate < today ? 'text-red-700' : 'text-ink-500'}`}>{n.state === 'OPEN' ? dueLabel(n.dueDate, today) : 'Done'}</span></span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-600"><span className="shrink-0 text-ink-500"><ActionIcon action={n.kind === 'MEETING' ? 'MEETING' : n.action} size={12} /></span><span className="truncate">{n.label}</span>{n.repeat !== 'NONE' ? <span className="shrink-0 text-ink-400" title={REPEAT_LABELS[n.repeat]}><IconRefresh size={11} /></span> : null}</span>
            {showFo ? <span className="mt-0.5 block truncate text-[11.5px] text-ink-500">FO {n.fo.name}</span> : null}
          </span>
        </Link>
      </li>;
    })}</ul>
  </div>;
}

type PanelProps = {
  item: NextActionListRow;
  today: string;
  timezone: string;
  nextUrl: string;
  nextWorkingDay: string;
  mayWork: boolean;
  /** Why this reader cannot work it (B159), said where the controls would be. */
  whyNot?: string | null;
  done?: boolean;
  workingDays?: number[];
  /** A cold contact's call: Call and "Called from another phone?" instead of Done (B161). */
  callSlot?: ReactNode;
  /** "Email bounced" or "Possible bounce" on a cold contact (N097). */
  warning?: string | null;
  /** On a cold Email next step: whether it closes itself when the rep sends from Outlook (N088). */
  closeWords?: string | null;
};

/** An open created task: the band says it is one and what it is; below, the person and the controls. */
export function NextActionPanel({ item: n, today, timezone, nextUrl, nextWorkingDay, mayWork, whyNot = null, done = false, workingDays = [], callSlot = null, warning = null, closeWords = null }: PanelProps) {
  const { name, firstName, who } = nextSubject(n);
  const ref = refOf(n);
  const cold = !n.person;
  const overdue = !done && n.state === 'OPEN' && n.dueDate < today;
  const meeting = n.kind === 'MEETING';
  const how = meeting ? <span className="inline-flex items-center gap-1.5"><ActionIcon action="MEETING" size={14} />Meeting{n.meetingAt ? ` at ${new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(n.meetingAt)}` : ''}</span> : <span className="inline-flex items-center gap-1.5"><ActionIcon action={n.action} size={14} />{ACTION_LABELS[n.action]}</span>;
  return <Surface flush>
    <div className="flex items-start gap-3 rounded-t-[inherit] bg-brand-900 px-5 py-3.5 text-white">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 text-[#d5e9ad]"><IconRefresh size={16} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3">
          <span className="flex-1 text-[12px] text-brand-200">Task</span>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] leading-none"><span className="rounded-full bg-white/10 px-2 py-1 text-white">{REPEAT_LABELS[n.repeat]}</span></span>
        </div>
        <div className="mt-1 break-words text-[19px] font-semibold leading-snug tracking-[-0.01em]">{n.label}</div>
      </div>
    </div>
    <header className="border-b border-line bg-gradient-to-r from-brand-50/70 to-white p-5">
      <div className="mb-4 flex items-center gap-3"><Avatar name={name} shape="circle" size={44} /><div>{ref ? <Link href={subjectHref(ref)} className="text-xl font-semibold tracking-tight hover:text-brand-700">{name}</Link> : <span className="text-xl font-semibold tracking-tight">{name}</span>}<div className="mt-1 text-sm text-ink-500">{who?.jobTitle ?? 'Title missing'}</div></div><div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">{cold ? <Badge tone="sky">Cold contact</Badge> : null}{warning ? <Badge tone="amber">{warning}</Badge> : null}<Badge tone={done || n.state !== 'OPEN' ? 'gray' : overdue ? 'red' : n.dueDate === today ? 'green' : 'blue'}>{done ? 'Done' : n.state !== 'OPEN' ? (n.state === 'CANCELLED' ? 'Stopped' : 'Done') : overdue ? 'Overdue' : n.dueDate === today ? 'Due today' : 'Upcoming'}</Badge></div></div>
      <RecordFields items={[{ label: 'Company', value: who?.companyName ?? null }, { label: 'How', value: how }, { label: 'Due', value: formatLocalDate(n.dueDate, 'long') }, { label: 'Assigned to', value: n.fo.name }, { label: 'Email', value: who?.email ?? null }, { label: 'Phone', value: who?.phone ?? null }, ...(n.lastDoneAt ? [{ label: 'Last done', value: formatInstant(n.lastDoneAt, timezone) }] : [])]} />
      {closeWords && n.action === 'EMAIL' && !meeting ? <p className="mt-3 text-[12px] text-ink-500">{closeWords}</p> : null}
    </header>
    {n.state === 'OPEN' && !done ? (mayWork
      ? <div className="p-5"><NextActionControls dueDate={n.dueDate} id={n.id} nextUrl={nextUrl} nextWorkingDay={nextWorkingDay} repeats={n.repeat !== 'NONE'} kind={n.kind} meetingHref={meeting && n.personId ? `/meetings/new?personId=${encodeURIComponent(n.personId)}` : null} callSlot={cold && n.action === 'CALL' && !meeting ? callSlot : null} subjectName={name || firstName} label={n.label} workingDays={workingDays} /></div>
      : whyNot ? <div className="p-5"><Notice tone="info">{whyNot}</Notice></div> : null) : null}
  </Surface>;
}
