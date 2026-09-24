'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { calendarDateLabel, calendarMonths, dateRangeLabel, monthGrid, shortDateLabel, weekday, PRIORITY_LABELS, contactPriority, type CampaignDraft, type CampaignCalendar } from '@/lib/campaign-planner';
import { addDays, diffDays } from '@/lib/dates';
import { ActionIcon, IconChevronLeft, IconChevronRight } from '@/components/icons';
import { Modal } from '@/components/modal';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthName = (month: string, short = false) => new Intl.DateTimeFormat('en-US', { month: short ? 'short' : 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const mondayOf = (day: string) => addDays(day, -((weekday(day) + 6) % 7));
/** A campaign of up to six weeks is one page; longer ones page by month. */
const ONE_PAGE_WEEKS = 6;

/** "September 2026", or "September – October 2026" when a short campaign crosses a month. */
function spanTitle(first: string, last: string) {
  if (first.slice(0, 7) === last.slice(0, 7)) return monthName(first.slice(0, 7));
  const name = (m: string) => new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(new Date(`${m}-01T12:00:00Z`));
  return first.slice(0, 4) === last.slice(0, 4) ? `${name(first.slice(0, 7))} – ${monthName(last.slice(0, 7))}` : `${monthName(first.slice(0, 7))} – ${monthName(last.slice(0, 7))}`;
}

/**
 * The plan as a calendar, Monday to Sunday, showing the weeks the campaign runs in: one page for up
 * to six weeks, otherwise a month at a time. Working days sit on a dotted field with each batch as a
 * card, a first step lightly tinted; weekends and dates outside the campaign stay plain. Hovering a
 * batch outlines its other steps; nothing stays marked once the pointer leaves or the view changes.
 */
export function CampaignCalendarView({ draft, calendar, actions }: { draft: CampaignDraft; calendar: CampaignCalendar; actions?: ReactNode }) {
  const fos = useMemo(() => [...calendar.fos].sort((a, b) => a.name.localeCompare(b.name)), [calendar.fos]);
  const [chosenFo, setChosenFo] = useState(fos[0]?.id ?? 'all');
  // A plan updated from Dates and limits may drop the FO or month on screen; fall back rather than show nothing.
  const foId = chosenFo === 'all' || fos.some(f => f.id === chosenFo) ? chosenFo : fos[0]?.id ?? 'all';
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ batchId: string; step: number } | null>(null);
  const first = calendar.days[0] ?? draft.startDate, last = calendar.days.at(-1) ?? draft.endDate;
  const weeksSpanned = diffDays(mondayOf(first), mondayOf(last)) / 7 + 1;
  const onePage = weeksSpanned <= ONE_PAGE_WEEKS;
  const months = useMemo(() => (onePage ? [first.slice(0, 7)] : calendarMonths(first, last)), [onePage, first, last]);
  const [shown, setShown] = useState<string | null>(null);
  const month = shown && months.includes(shown) ? shown : first.slice(0, 7);
  const monthIndex = months.indexOf(month);
  const showMonth = (m: string) => { setHover(null); setShown(m); };
  const showFo = (id: string) => { setHover(null); setChosenFo(id); };
  const working = useMemo(() => new Set(calendar.days), [calendar.days]);
  // Whole weeks, Monday to Sunday, but only the ones the campaign runs in: every row has room.
  const days = useMemo(() => {
    const grid = onePage ? Array.from({ length: weeksSpanned * 7 }, (_, i) => addDays(mondayOf(first), i)) : monthGrid(month);
    return Array.from({ length: grid.length / 7 }, (_, w) => grid.slice(w * 7, w * 7 + 7)).filter(week => week.some(d => d >= first && d <= last)).flat();
  }, [onePage, weeksSpanned, month, first, last]);
  const byDay = useMemo(() => {
    const m = new Map<string, { b: CampaignCalendar['batches'][number]; step: number }[]>();
    for (const b of calendar.batches) if (foId === 'all' || b.foId === foId) b.dates.forEach((d, step) => { const list = m.get(d) ?? []; list.push({ b, step }); m.set(d, list); });
    return m;
  }, [calendar.batches, foId]);
  // Cards name their outreach group only when this view mixes groups.
  const mixed = useMemo(() => new Set(calendar.batches.filter(b => foId === 'all' || b.foId === foId).map(b => b.flowId)).size > 1, [calendar.batches, foId]);
  const picked = calendar.batches.find(b => b.id === selected?.batchId);
  const flow = draft.flows.find(f => f.id === picked?.flowId);
  const count = (events: { b: { personIds: string[] } }[]) => events.reduce((n, e) => n + e.b.personIds.length, 0);
  const years = first.slice(0, 4) !== last.slice(0, 4);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">Your outreach calendar</h2><p className="mt-0.5 text-sm text-ink-600">{dateRangeLabel(first, last)} · <span className="tabular-nums">{calendar.days.length}</span> working {calendar.days.length === 1 ? 'day' : 'days'}</p></div>
      <div className="flex flex-wrap items-center gap-2">
        {fos.length <= 5
          ? <div role="group" aria-label="Calendar FO" className="inline-flex rounded-lg border border-line bg-canvas p-0.5">{[{ id: 'all', name: 'All FOs' }, ...fos].map(f => <button type="button" key={f.id} aria-pressed={foId === f.id} onClick={() => showFo(f.id)} className={`rounded-md px-3 py-1.5 text-sm ${foId === f.id ? 'bg-white font-medium text-ink-900 shadow-sm' : 'text-ink-600 hover:text-ink-900'}`}>{f.name}</button>)}</div>
          : <select aria-label="Calendar FO" value={foId} onChange={e => showFo(e.target.value)} className="!w-auto"><option value="all">All FOs</option>{fos.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select>}
        {actions}
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/* One or two months: the month and arrows. More: a strip of months between the arrows, so nothing moves as you page. */}
      <div className="flex flex-wrap items-center gap-1">
        <h3 className={`text-base font-semibold text-ink-900 ${months.length > 2 ? 'sr-only' : 'min-w-40'}`} aria-live="polite">{onePage ? spanTitle(first, last) : monthName(month)}</h3>
        {months.length > 1 && <button type="button" className="btn-icon-ghost disabled:opacity-40 disabled:hover:bg-transparent" aria-label="Previous month" disabled={monthIndex <= 0} onClick={() => showMonth(months[monthIndex - 1])}><IconChevronLeft size={16} /></button>}
        {months.length > 2 && <span role="group" aria-label="Months" className="flex flex-wrap gap-1">{months.map((m, i) => <button type="button" key={m} aria-pressed={m === month} onClick={() => showMonth(m)} className={`rounded-md px-2.5 py-1 text-sm ${m === month ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-canvas'}`}>{i === 0 || (years && m.endsWith('-01')) ? monthName(m, true) : monthName(m, true).slice(0, 3)}</button>)}</span>}
        {months.length > 1 && <button type="button" className="btn-icon-ghost disabled:opacity-40 disabled:hover:bg-transparent" aria-label="Next month" disabled={monthIndex >= months.length - 1} onClick={() => showMonth(months[monthIndex + 1])}><IconChevronRight size={16} /></button>}
      </div>
      {foId !== 'all' && <p className="flex items-center gap-4 text-xs text-ink-600"><span className="flex items-center gap-1.5"><span className="h-3 w-4 rounded border border-brand-200 bg-brand-50" />First step, new people</span><span className="flex items-center gap-1.5"><span className="h-3 w-4 rounded border border-ink-300 bg-white" />Follow-up</span></p>}
    </div>
    <div className="overflow-x-auto rounded-xl border border-line">
      <div className="grid min-w-[900px] grid-cols-[repeat(5,minmax(0,1fr))_repeat(2,minmax(0,0.55fr))] gap-px bg-line">
        {WEEKDAYS.map((d, i) => <div key={d} className={`bg-white px-3 py-2.5 text-xs font-semibold uppercase tracking-wide ${i > 4 ? 'text-ink-400' : 'text-ink-500'}`}>{d}</div>)}
        {days.map(day => {
          const works = working.has(day);
          const events = works ? byDay.get(day) ?? [] : [];
          const date = day.endsWith('-01') ? shortDateLabel(day, false) : String(Number(day.slice(8)));
          return <div key={day} data-day={day} className={`flex min-h-[9rem] flex-col ${works ? 'calendar-dots' : 'bg-canvas'}`}>
            <div className={`flex items-center justify-between gap-1 px-2.5 pb-1.5 pt-2.5 ${works ? 'bg-white' : ''}`}>
              <span className="flex items-center gap-1.5"><time dateTime={day} title={calendarDateLabel(day)} className={`text-sm font-semibold ${works && (onePage || day.slice(0, 7) === month) ? 'text-ink-900' : 'text-ink-400'}`}>{date}</time>{(day === first || day === last) && <span className="rounded bg-white px-1.5 py-px text-[10.5px] font-medium text-ink-700 ring-1 ring-ink-300">{day === first ? 'Start' : 'End'}</span>}</span>
              {events.length > 1 && <span className="text-xs tabular-nums text-ink-600">{people(count(events))}</span>}
            </div>
            {works && (foId === 'all' ? <div className="space-y-1.5 px-2.5 pb-2.5 pt-1">{fos.map(fo => <button type="button" key={fo.id} title={`Show ${fo.name}'s calendar`} onClick={() => showFo(fo.id)} className="group flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] shadow-sm hover:border-ink-300"><span className="truncate text-ink-800">{fo.name}</span><span className="flex items-center gap-0.5 font-semibold tabular-nums text-ink-900">{count(events.filter(e => e.b.foId === fo.id))}<IconChevronRight size={12} className="text-ink-400 opacity-0 group-hover:opacity-100" /></span></button>)}</div>
              : <div className="space-y-1.5 px-2.5 pb-2.5 pt-1">{events.map(({ b, step }) => {
                const f = draft.flows.find(f => f.id === b.flowId)!;
                return <button type="button" key={b.id} aria-label={`${f.name} · Step ${step + 1} of ${f.steps.length} · ${people(b.personIds.length)} · first step ${shortDateLabel(b.dates[0], true, years)}`} onClick={() => { setHover(null); setSelected({ batchId: b.id, step }); }} onMouseEnter={() => setHover(b.id)} onMouseLeave={() => setHover(null)}
                  className={`block w-full rounded-lg border px-3 py-2.5 text-left text-[13px] shadow-sm transition-colors ${step === 0 ? 'bg-brand-50' : 'bg-white'} ${hover === b.id ? 'border-brand-400 ring-2 ring-brand-100' : step === 0 ? 'border-brand-200 hover:border-brand-300' : 'border-line hover:border-ink-300'}`}>
                  <span className="flex items-center justify-between gap-1.5"><span className="truncate text-sm font-semibold text-ink-900">Step {step + 1} <span className="font-normal text-ink-500">of {f.steps.length}</span></span><span className="flex shrink-0 gap-1 text-ink-500">{f.steps[step].actions.map(a => <ActionIcon key={a.id} action={a.type} size={14} />)}</span></span>
                  <span className="mt-1 block truncate text-ink-600">{people(b.personIds.length)} · {PRIORITY_LABELS[b.priority]}</span>
                  {mixed && <span className="mt-0.5 block truncate text-ink-500">{f.name}</span>}
                </button>;
              })}{!events.length && <span className="rounded bg-white px-1 text-xs font-medium text-amber-800">Nothing to send</span>}</div>)}
          </div>;
        })}
      </div>
    </div>
    {selected && picked && flow && <Modal label={`${flow.name} · first step ${shortDateLabel(picked.dates[0], true, years)}`} onClose={() => setSelected(null)}>
      <div className="space-y-4 p-5">
        <div><h2 className="text-lg font-semibold">{flow.name} · first step {shortDateLabel(picked.dates[0], true, years)}</h2><p className="mt-1 text-sm text-ink-600">Step {selected.step + 1} of {flow.steps.length} goes out on {calendarDateLabel(picked.dates[selected.step])}, to {people(picked.personIds.length)}.</p></div>
        <div className="flex flex-wrap gap-2">{picked.dates.map((d, i) => <button type="button" className={i === selected.step ? 'chip' : 'chip-muted'} key={d} aria-pressed={i === selected.step} onClick={() => setSelected({ batchId: picked.id, step: i })}>Step {i + 1} · {shortDateLabel(d, true, years)}</button>)}</div>
        <div className="max-h-64 divide-y divide-line overflow-y-auto">{picked.personIds.map(id => { const p = calendar.people.find(p => p.id === id); return <div key={id} className="flex justify-between gap-2 py-2 text-sm"><span>{p?.name ?? id}</span><span className="chip-muted">{p ? PRIORITY_LABELS[contactPriority(p)] : ''}</span></div>; })}</div>
        {flow.steps[selected.step].actions.map(a => <div key={a.id} className="rounded-xl border border-line p-3"><strong>{a.label}</strong>{a.subject && <p className="mt-1 font-medium">{a.subject}</p>}<p className="mt-2 whitespace-pre-wrap text-sm">{a.template}</p></div>)}
      </div>
    </Modal>}
  </div>;
}
