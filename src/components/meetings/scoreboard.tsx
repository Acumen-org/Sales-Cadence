import Link from 'next/link';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { MonthProgress, Scoreboard } from '@/lib/meetings/scoreboard';
import type { LocalDate } from '@/lib/dates';
import { ordinal } from '@/lib/meetings/numbering';
import { barColour } from '@/lib/bar-colour';
import { Avatar } from '@/components/ui';
import { IconStar } from '@/components/icons';
import { KudosButton } from '@/components/meetings/kudos-button';

/**
 * The top of Meetings (owner, 21 to 23 Nov 2026: gamified, fun, simple and useful; no emojis): last
 * month's best as an honour, the month as the platform's progress bar with its next mark, the pod
 * race with the top three bookers (each opens their meetings), and recent wins.
 */
export function ScoreboardPanel({ s, now, admin = false }: { s: Scoreboard; now: number; admin?: boolean }) {
  return (
    <div className="space-y-3" aria-label="Meetings scoreboard" role="region">
      {s.champions ? <Champions c={s.champions} month={s.month.label} /> : null}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)]">
        {s.me ? <YourMonth s={s} me={s.me} /> : <TeamMonth s={s} admin={admin} />}
        <PodRace s={s} />
        <Wins s={s} now={now} />
      </div>
    </div>
  );
}

/** The meetings that count, booked by this person in a month: what their number is made of. */
const rangeHref = (first: LocalDate, last: LocalDate, userId: string) => `/meetings?booked=${encodeURIComponent(userId)}&from=${first}&to=${last}&counted=1`;
export const countedHref = (s: Pick<Scoreboard, 'month'>, userId: string) => rangeHref(s.month.first, s.month.last, userId);

function CardHead({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[13px] font-semibold text-ink-900">{title}</h3>
      {aside}
    </div>
  );
}

const daysLeft = (n: number) => <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-[11.5px] tabular-nums text-ink-600">{n <= 1 ? 'Last day' : `${n} days left`}</span>;

/**
 * Last month's best (owner, 23 Nov 2026: "give regards to top pod and performer from last month,
 * and it should look good enough that people want to be in that place"). The sidebar's evergreen
 * and lime, so it reads as the house's own honour board; a light passes over it once on opening.
 */
function Champions({ c, month }: { c: NonNullable<Scoreboard['champions']>; month: string }) {
  const p = c.performer;
  return (
    <section aria-label={`${c.label}'s best`} className="champions relative overflow-hidden rounded-2xl bg-[#192c28] px-5 py-4 text-white">
      <IconStar size={150} filled className="pointer-events-none absolute -right-6 -top-8 text-white/[0.04]" />
      <div className="relative flex flex-wrap items-center gap-x-10 gap-y-4">
        <div className="min-w-[10rem]">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#d5e9ad]"><IconStar size={13} filled />{c.label}&apos;s best</p>
          <p className="mt-1 text-[12.5px] text-white/60">Lead {month} to take their place.</p>
        </div>
        <Link href={rangeHref(c.first, c.last, p.userId)} title={`Open the ${p.meetings} meetings ${p.name} booked in ${c.label}`} className="group flex min-w-0 items-center gap-3.5">
          <span className="relative shrink-0">
            <Avatar name={p.name} shape="circle" size={50} className="ring-2 ring-[#d5e9ad] ring-offset-2 ring-offset-[#192c28]" />
            <span aria-hidden className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full bg-[#d5e9ad] text-[#192c28]"><IconStar size={11} filled /></span>
          </span>
          <span className="min-w-0">
            <span className="block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-white/55">Top performer</span>
            <span className="block truncate text-[18px] font-semibold leading-tight tracking-[-0.01em] group-hover:underline">{p.name}</span>
            <span className="block truncate text-[12.5px] tabular-nums text-white/70">{p.meetings} meeting{p.meetings === 1 ? '' : 's'}{p.firstMeetings ? ` · ${p.firstMeetings} first` : ''}{p.pod ? ` · ${p.pod}` : ''}</span>
          </span>
        </Link>
        {c.pod ? (
          <div className="flex min-w-0 items-center gap-3.5">
            <span aria-hidden className="flex shrink-0 pl-1.5">
              {c.pod.people.slice(0, 4).map((n) => <Avatar key={n} name={n} shape="circle" size={34} className="-ml-1.5 ring-2 ring-[#192c28]" />)}
              {c.pod.people.length > 4 ? <span className="-ml-1.5 grid h-[34px] w-[34px] place-items-center rounded-full bg-white/10 text-[11px] font-medium ring-2 ring-[#192c28]">+{c.pod.people.length - 4}</span> : null}
            </span>
            <span className="min-w-0">
              <span className="block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-white/55">Top pod</span>
              <span className="block truncate text-[18px] font-semibold leading-tight tracking-[-0.01em]">{c.pod.name}</span>
              <span className="block truncate text-[12.5px] tabular-nums text-white/70">{c.pod.meetings} meeting{c.pod.meetings === 1 ? '' : 's'} · {c.pod.perFo} per FO</span>
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The platform's progress bar (as on Home: the line-coloured track, the fill darkening as it fills),
 * with the marks under it. On opening it grows to today's mark, then its edge keeps leaning on
 * toward the next one until the target is reached (globals.css: bar-grow, bar-lean; both stay still
 * for anyone who asked for less motion).
 */
function GoalBar({ value, target, milestones, label, size = 'lg' }: { value: number; target: number; milestones?: number[]; label: string; size?: 'lg' | 'sm' }) {
  const fraction = target ? Math.min(1, value / target) : 0;
  // Never a sliver too thin to see: 1 of 72 still shows.
  const width = value > 0 ? Math.max(3, fraction * 100) : 0;
  const at = (m: number) => `${(m / target) * 100}%`;
  return (
    <div>
      <div className={clsx('relative overflow-hidden rounded-full bg-line', size === 'lg' ? 'h-2.5' : 'h-1.5')} role="img" aria-label={label}>
        <div className="bar-grow relative h-full rounded-full" style={{ width: `${width}%`, background: barColour(fraction) }}>
          {value < target && size === 'lg' ? <span aria-hidden className="bar-lean" /> : null}
        </div>
        {milestones?.filter((m) => m < target).map((m) => <span key={m} aria-hidden className="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-white" style={{ left: at(m) }} />)}
      </div>
      {milestones ? (
        <div aria-hidden className="relative mt-1.5 h-4 text-[11px] tabular-nums">
          {milestones.map((m) => (
            <span key={m} className={clsx('absolute top-0', m === target ? 'right-0' : '-translate-x-1/2', value >= m ? 'font-semibold text-brand-700' : 'text-ink-400')} style={m === target ? undefined : { left: at(m) }}>{m}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GoalCard({ label, title, s, booked, target, p, extra, foot }: { label: string; title: string; s: Scoreboard; booked: number; target: number; p: MonthProgress; extra?: ReactNode; foot: ReactNode }) {
  return (
    <section className="surface flex flex-col gap-3 p-4" aria-label={label}>
      <CardHead title={title} aside={daysLeft(s.month.daysLeft)} />
      <p className="flex items-baseline gap-1.5">
        <span className={clsx('text-[38px] font-semibold leading-none tracking-[-0.04em] tabular-nums', booked >= target ? 'text-brand-700' : 'text-ink-900')}>{booked}</span>{' '}
        <span className="text-[14px] text-ink-500">of {target} booked</span>
      </p>
      <GoalBar value={booked} target={target} milestones={p.milestones} label={`${booked} of ${target} booked. ${p.next}`} />
      <p className="text-[13px] font-medium text-ink-900">{p.next}</p>
      {extra}
      <p className="mt-auto text-[11.5px] text-ink-500">{foot}</p>
    </section>
  );
}

function Waiting({ n, mine }: { n: number; mine: boolean }) {
  if (!n) return null;
  return (
    <Link href="/meetings/approval" className="-mt-1 text-[12.5px] text-amber-800 hover:underline">
      {n} waiting for approval: {mine ? `add the recording link to count ${n === 1 ? 'it' : 'them'} now` : `${n === 1 ? 'it counts' : 'they count'} once approved`}
    </Link>
  );
}

function YourMonth({ s, me }: { s: Scoreboard; me: NonNullable<Scoreboard['me']> }) {
  return (
    <GoalCard
      label="Your month" title={`Your ${s.month.label}`} s={s} booked={me.meetings} target={s.goal} p={me}
      extra={<><Waiting n={me.waiting} mine /><WeekRow w={s.week} /></>}
      foot={<>Target: {s.goal} a month{me.best ? ` · your best: ${me.best.count} in ${me.best.label}` : ''}</>}
    />
  );
}

/** This week, day by day, for the same people as the month: a goal that is always still winnable. */
function WeekRow({ w }: { w: Scoreboard['week'] }) {
  return (
    <div className="flex items-end justify-between gap-3 border-t border-line pt-3" aria-label={`This week: ${w.total} booked`} role="group">
      <div className="min-w-0">
        <p className="text-[11.5px] font-medium text-ink-500">This week</p>
        <ol className="mt-1.5 flex flex-wrap gap-1.5">
          {w.days.map((d) => (
            <li key={d.day} className={clsx('flex w-10 flex-col items-center rounded-lg py-1', d.today ? 'bg-brand-50 ring-1 ring-brand-200' : 'bg-canvas')}>
              <span className="text-[10.5px] text-ink-500">{d.label}</span>
              <span className={clsx('text-[14px] font-semibold tabular-nums', d.future ? 'text-ink-300' : d.count ? 'text-ink-900' : 'text-ink-400')}>{d.future && !d.count ? '–' : d.count}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className="shrink-0 text-right">
        <span className="block text-[22px] font-semibold leading-none tabular-nums text-ink-900">{w.total}</span>
        <span className="text-[11.5px] text-ink-500">booked</span>
      </p>
    </div>
  );
}

function TeamMonth({ s, admin }: { s: Scoreboard; admin: boolean }) {
  const t = s.team;
  const whose = t.pods ? (t.pods === 1 ? 'Your pod' : 'Your pods') : 'Team';
  return (
    <GoalCard
      label={`${whose} this month`} title={`${whose} · ${s.month.label}`} s={s} booked={t.meetings} target={t.target} p={t}
      extra={<><Waiting n={t.waiting} mine={false} /><WeekRow w={s.week} /></>}
      foot={<>Target: {s.goal} per FO × {t.fos} FO{t.fos === 1 ? '' : 's'}{admin ? <> · <Link href="/settings?tab=meetings" className="text-brand-700 hover:underline">Change</Link></> : null}</>}
    />
  );
}

/** First, second and third: gold, silver and bronze tints, with the number on them. */
const PLACE = ['bg-[#f5e3a8] text-[#6b4f00]', 'bg-[#e3e8e6] text-[#3b4744]', 'bg-[#f0d9c6] text-[#7a4421]'];

function PodRace({ s }: { s: Scoreboard }) {
  const me = s.me;
  return (
    <section className="surface flex flex-col gap-3 p-4" aria-label="Pod race">
      <CardHead title="Pod race" aside={<span className="text-[11.5px] text-ink-500">booked of each pod&apos;s target</span>} />
      {s.pods.length ? (
        <ol className="space-y-2.5">
          {s.pods.slice(0, 5).map((p) => (
            <li key={p.id} className="text-[12.5px]">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className={clsx('min-w-0 truncate', p.yours ? 'font-semibold text-ink-900' : 'text-ink-700')}>{p.name}{p.yours ? <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 text-[11px] font-medium text-brand-800">Your pod</span> : null}</span>
                <span className="shrink-0 tabular-nums text-ink-600"><span className="font-semibold text-ink-900">{p.meetings}</span> of {p.target}</span>
              </div>
              <GoalBar value={p.meetings} target={p.target} size="sm" label={`${p.name}: ${p.meetings} of ${p.target} booked`} />
              <span className="mt-0.5 block text-[11px] tabular-nums text-ink-500">{Math.round(p.share * 100)}% · {p.perFo} per FO · {p.fos} FO{p.fos === 1 ? '' : 's'}</span>
            </li>
          ))}
        </ol>
      ) : <p className="text-[12.5px] text-ink-500">No pods yet.</p>}
      <div className="border-t border-line pt-2.5">
        <h4 className="mb-1.5 text-[11.5px] font-medium text-ink-500">Top bookers this month</h4>
        {s.top.length ? (
          <ol className="space-y-1">
            {s.top.map((t, i) => (
              <li key={t.userId}>
                <Link href={countedHref(s, t.userId)} title={`Open the ${t.meetings} meeting${t.meetings === 1 ? '' : 's'} ${t.name} booked this month`} aria-label={`${ordinal(i + 1)}: ${t.name}, ${t.meetings} booked this month. Open their meetings`} className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[12.5px] hover:bg-canvas">
                  <span aria-hidden className={clsx('grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10.5px] font-bold tabular-nums', PLACE[i])}>{i + 1}</span>
                  <Avatar name={t.name} shape="circle" size={22} />
                  <span className={clsx('min-w-0 flex-1 truncate', t.you ? 'font-semibold text-ink-900' : 'text-ink-800')}>{t.name}{t.you ? ' (you)' : ''}</span>
                  <span className="shrink-0 tabular-nums text-ink-600"><span className="font-semibold text-ink-900">{t.meetings}</span> booked{t.firstMeetings ? <span className="text-ink-400"> · {t.firstMeetings} first</span> : null}</span>
                </Link>
              </li>
            ))}
          </ol>
        ) : <p className="text-[12.5px] text-ink-500">Nobody on the board yet this month: the first meeting takes first place.</p>}
        {me && !s.top.some((t) => t.you) ? (
          <p className="mt-1.5 flex items-center gap-2 border-t border-dashed border-line pt-1.5 text-[12.5px] text-ink-700">
            <span className="font-semibold text-ink-900">You</span>
            <span className="tabular-nums">{me.rank ? `${ordinal(me.rank)} of ${me.of} · ${me.meetings} booked` : 'Not on the board yet this month'}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ago(at: Date, now: number): string {
  const min = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function Wins({ s, now }: { s: Scoreboard; now: number }) {
  return (
    <section className="surface flex flex-col gap-3 p-4" aria-label="Recent wins">
      <CardHead title="Recent wins" aside={<span className="text-[11.5px] text-ink-500">last two weeks</span>} />
      {s.wins.length ? (
        <ul className="space-y-2.5">
          {s.wins.slice(0, 6).map((w) => (
            <li key={w.meetingId} className="flex items-center gap-2.5">
              <Avatar name={w.bookedBy} shape="circle" size={28} />
              <div className="min-w-0 flex-1 text-[12.5px] leading-[1.35]">
                <Link href={`/meetings/${w.meetingId}`} className="line-clamp-2 block break-words text-ink-800 hover:text-brand-700">
                  <span className="font-semibold text-ink-900">{w.mine ? 'You' : w.bookedBy}</span> booked {w.number === 1 ? <span className="font-medium text-emerald-700">a first meeting</span> : w.number ? `a follow-up (${ordinal(w.number)} meeting)` : 'a meeting'}
                </Link>
                <span className="block truncate text-[11.5px] text-ink-500">{[w.company, ago(w.at, now)].filter(Boolean).join(' · ')}</span>
              </div>
              <KudosButton meetingId={w.meetingId} count={w.kudos} mine={w.kudosByMe} own={w.mine} who={w.bookedBy} />
            </li>
          ))}
        </ul>
      ) : <p className="text-[12.5px] text-ink-500">Nothing booked in the last two weeks yet. Be the first.</p>}
    </section>
  );
}
