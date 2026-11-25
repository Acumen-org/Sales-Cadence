import Link from 'next/link';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { Milestone, MonthProgress, Scoreboard } from '@/lib/meetings/scoreboard';
import type { LocalDate } from '@/lib/dates';
import { ordinal } from '@/lib/meetings/numbering';
import { barColour } from '@/lib/bar-colour';
import { Avatar } from '@/components/ui';
import { IconStar } from '@/components/icons';
import { KudosButton } from '@/components/meetings/kudos-button';
import { FitList } from '@/components/meetings/fit-list';
import { PodList } from '@/components/meetings/pod-list';

/**
 * The top of Meetings (owner, 21 to 25 Nov 2026: gamified, fun, simple and useful; no emojis): last
 * month's best as an honour, then one card in three parts (owner, 25 Nov: "one card, three
 * sections"): the reader's own month (an FO's own; a leader's or admin's team), the pod race, and the
 * top bookers on a podium with the latest wins to cheer.
 */
export function ScoreboardPanel({ s, now }: { s: Scoreboard; now: number }) {
  return (
    <div className="space-y-3" aria-label="Meetings scoreboard" role="region">
      {s.champions ? <Champions c={s.champions} month={s.month.label} /> : null}
      <div className="surface grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] lg:py-4">
        {s.me ? <YourMonth s={s} me={s.me} /> : <TeamMonth s={s} />}
        <PodRace s={s} />
        <TopBookers s={s} now={now} />
      </div>
    </div>
  );
}

/** One of the card's three parts: side by side on a wide screen, stacked with a rule between on a phone. */
const PART = 'flex min-w-0 flex-col gap-3 p-4 lg:px-5 lg:py-0';
const LATER_PART = 'border-t border-line lg:border-l lg:border-t-0';

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

const Aside = ({ children }: { children: ReactNode }) => <span className="text-right text-[11.5px] text-ink-500">{children}</span>;
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
        <Link href={rangeHref(c.first, c.last, p.userId)} title={`Open the ${p.meetings} meeting${p.meetings === 1 ? '' : 's'} ${p.name} booked in ${c.label}`} className="group flex min-w-0 items-center gap-3.5">
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
              {c.pod.people.slice(0, 4).map((n, i) => <Avatar key={`${i}-${n}`} name={n} shape="circle" size={34} className="-ml-1.5 ring-2 ring-[#192c28]" />)}
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
 * with a white tick at each named mark (owner, 25 Nov 2026: the names under the bar went; the line
 * under it names the next one). On opening it grows to today's mark, then its edge keeps leaning on
 * toward the next one until the target is reached (globals.css: bar-grow, bar-lean; both stay still
 * for anyone who asked for less motion).
 */
function GoalBar({ value, target, milestones, label, size = 'lg' }: { value: number; target: number; milestones?: Milestone[]; label: string; size?: 'lg' | 'sm' }) {
  const fraction = target ? Math.min(1, value / target) : 0;
  // Never a sliver too thin to see: 1 of 72 still shows.
  const width = value > 0 ? Math.max(3, fraction * 100) : 0;
  return (
    <div className={clsx('relative overflow-hidden rounded-full bg-line', size === 'lg' ? 'h-2.5' : 'h-1.5')} role="img" aria-label={label}>
      <div className="bar-grow relative h-full rounded-full" style={{ width: `${width}%`, background: barColour(fraction) }}>
        {value < target && size === 'lg' ? <span aria-hidden className="bar-lean" /> : null}
      </div>
      {milestones?.filter((m) => m.at < target).map((m) => <span key={m.at} aria-hidden className="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-white" style={{ left: `${(m.at / target) * 100}%` }} />)}
    </div>
  );
}

/** The month's sentence, with the next mark's name standing out in it. */
function NextLine({ text, mark }: { text: string; mark?: string }) {
  const at = mark ? text.indexOf(mark) : -1;
  return (
    <p className="text-[13px] font-medium text-ink-900">
      {mark && at >= 0 ? <>{text.slice(0, at)}<span className="font-semibold text-brand-700">{mark}</span>{text.slice(at + mark.length)}</> : text}
    </p>
  );
}

type Stat = { value: ReactNode; label: string };

/** Three small numbers along the foot of the month (owner, 25 Nov 2026: "specific to that FO"). */
function Stats({ items }: { items: Stat[] }) {
  return (
    <dl className="mt-auto grid grid-cols-3 border-t border-line pt-3">
      {items.map((x, i) => (
        <div key={x.label} className={clsx('flex min-w-0 flex-col-reverse', i > 0 && 'border-l border-line pl-3', i < items.length - 1 && 'pr-3')}>
          <dt className="text-[11.5px] leading-[15px] text-ink-500">{x.label}</dt>
          <dd className="text-[17px] font-semibold leading-[22px] tabular-nums text-ink-900">{x.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MonthPart({ label, title, s, booked, target, unit, aside, p, waiting, stats }: { label: string; title: string; s: Scoreboard; booked: number; target: number; unit: string; aside?: string; p: MonthProgress; waiting: ReactNode; stats: Stat[] }) {
  const mark = p.milestones.find((m) => m.at > booked);
  return (
    <section className={PART} aria-label={label}>
      <CardHead title={title} aside={daysLeft(s.month.daysLeft)} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex items-baseline gap-1.5">
          <span className={clsx('text-[38px] font-semibold leading-none tracking-[-0.04em] tabular-nums', booked >= target ? 'text-brand-700' : 'text-ink-900')}>{booked}</span>{' '}
          <span className="text-[14px] text-ink-500">{unit}</span>
        </p>
        {aside ? <span className="text-[12px] text-ink-500">{aside}</span> : null}
      </div>
      <GoalBar value={booked} target={target} milestones={p.milestones} label={`${booked} of ${target} booked. ${p.next}`} />
      <NextLine text={p.next} mark={mark ? (mark.name === 'Goal' ? 'the goal' : mark.name) : undefined} />
      {waiting}
      <Stats items={stats} />
    </section>
  );
}

function Waiting({ n, mine }: { n: number; mine: boolean }) {
  if (!n) return null;
  return (
    <Link href="/meetings/approval" className="-mt-1 self-start text-[12.5px] text-amber-800 hover:underline">
      {mine ? `${n} waiting for approval: add the recording link${n === 1 ? '' : 's'}` : `${n} ${n === 1 ? 'meeting' : 'meetings'} waiting for approval`}
    </Link>
  );
}

const firstWord = (n: number) => (n === 1 ? 'first meeting' : 'first meetings');

/** An FO's own month: their number, their next mark, and where they stand. */
function YourMonth({ s, me }: { s: Scoreboard; me: NonNullable<Scoreboard['me']> }) {
  return (
    <MonthPart
      label="Your month" title={`Your ${s.month.label}`} s={s} booked={me.meetings} target={s.goal} unit={`of your ${s.goal} booked`} p={me}
      waiting={<Waiting n={me.waiting} mine />}
      stats={[
        { value: me.rank ? ordinal(me.rank) : '–', label: me.rank ? `of ${me.of} this month` : 'not on the board yet' },
        { value: me.firstMeetings, label: firstWord(me.firstMeetings) },
        { value: s.week.total, label: 'booked this week' },
      ]}
    />
  );
}

/** A leader's pods, or everyone for an admin: none of them books, so the month is the team's. */
function TeamMonth({ s }: { s: Scoreboard }) {
  const t = s.team;
  const whose = t.pods ? (t.pods === 1 ? 'Your pod' : 'Your pods') : 'Team';
  return (
    <MonthPart
      label={`${whose} this month`} title={`${whose} · ${s.month.label}`} s={s} booked={t.meetings} target={t.target} unit={`of ${t.target} booked`} p={t}
      aside={`${s.goal} per FO · ${t.fos ? `${t.fos} FO${t.fos === 1 ? '' : 's'}` : 'no FOs yet'}`}
      waiting={<Waiting n={t.waiting} mine={false} />}
      stats={[
        { value: s.week.total, label: 'booked this week' },
        { value: t.firstMeetings, label: firstWord(t.firstMeetings) },
        { value: t.bookers, label: 'booking this month' },
      ]}
    />
  );
}

type Pod = Scoreboard['pods'][number];

/** Up to this many pods, each takes two lines; past it, one line each and the top `SHOWN` first. */
const ROOMY = 4;
const SHOWN = 5;

const podMeta = (p: Pod) => `${p.perFo} per FO · ${p.fos} FO${p.fos === 1 ? '' : 's'}`;
const podLabel = (p: Pod) => `${p.name}: ${p.meetings} of ${p.target} booked`;
const YourPod = ({ tint }: { tint?: boolean }) => <span className={clsx('shrink-0 rounded-full px-1.5 text-[11px] font-medium text-brand-800', tint ? 'bg-brand-100' : 'bg-brand-50')}>Your pod</span>;
const OfTarget = ({ p }: { p: Pod }) => <span className="shrink-0 text-right tabular-nums text-ink-600"><span className="font-semibold text-ink-900">{p.meetings}</span> of {p.target}</span>;

/** A few pods: the bar under each name, and what the pod is made of under the bar. */
function PodRow({ p }: { p: Pod }) {
  return (
    <li className="text-[12.5px]">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={clsx('min-w-0 truncate', p.yours ? 'font-semibold text-ink-900' : 'text-ink-700')}>{p.name}</span>
          {p.yours ? <YourPod /> : null}
        </span>
        <OfTarget p={p} />
      </div>
      <GoalBar value={p.meetings} target={p.target} size="sm" label={podLabel(p)} />
      <span className="mt-0.5 block text-[11px] tabular-nums text-ink-500">{podMeta(p)}</span>
    </li>
  );
}

/** Many pods: one line each with its place; what the pod is made of shows on hover. */
function PodLine({ p, place }: { p: Pod; place: number }) {
  return (
    <li title={podMeta(p)} className={clsx('-mx-1.5 grid h-[26px] grid-cols-[1rem_minmax(0,1fr)_minmax(0,1fr)_3.25rem] items-center gap-x-2.5 rounded-md px-1.5 text-[12.5px]', p.yours && 'bg-brand-50')}>
      <span className="text-right text-[11.5px] tabular-nums text-ink-500">{place}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={clsx('min-w-0 truncate', p.yours ? 'font-semibold text-ink-900' : 'text-ink-700')}>{p.name}</span>
        {p.yours ? <YourPod tint /> : null}
      </span>
      <GoalBar value={p.meetings} target={p.target} size="sm" label={podLabel(p)} />
      <OfTarget p={p} />
    </li>
  );
}

/**
 * Pods ranked by how much of their own target they have booked, so a small pod races a big one
 * fairly. Built for many pods (owner, 25 Nov 2026): past a handful, one line each, the top five,
 * the reader's own pod pinned under them, and the rest a click away.
 */
function PodRace({ s }: { s: Scoreboard }) {
  const pods = s.pods;
  const yoursBelow = pods.map((p, i) => ({ p, place: i + 1 })).filter(({ p, place }) => place > SHOWN && p.yours);
  return (
    <section className={clsx(PART, LATER_PART)} aria-label="Pod race">
      <CardHead title="Pod race" aside={<Aside>booked of each pod&apos;s target</Aside>} />
      {!pods.length ? <p className="text-[12.5px] text-ink-500">No pods yet.</p>
        : pods.length <= ROOMY ? <ol className="space-y-2.5">{pods.map((p) => <PodRow key={p.id} p={p} />)}</ol>
        : (
          <PodList
            count={pods.length} shown={SHOWN}
            top={pods.slice(0, SHOWN).map((p, i) => <PodLine key={p.id} p={p} place={i + 1} />)}
            pinned={yoursBelow.length ? <><li aria-hidden className="!my-1 border-t border-dashed border-ink-200" />{yoursBelow.map(({ p, place }) => <PodLine key={p.id} p={p} place={place} />)}</> : null}
            rest={pods.slice(SHOWN).map((p, i) => <PodLine key={p.id} p={p} place={SHOWN + i + 1} />)}
          />
        )}
    </section>
  );
}

/** The podium (owner, 25 Nov 2026: top bookers "looks a little underwhelming"): first in the middle, gold, silver and bronze steps. */
const STEP = ['h-[30px] text-[12px] bg-[#f5e3a8] text-[#6b4f00]', 'h-[21px] text-[12px] bg-[#e3e8e6] text-[#3b4744]', 'h-[13px] text-[10px] leading-none bg-[#f0d9c6] text-[#7a4421]'];
const RING = ['#e5c360', '#b9c3bf', '#dcb796'];
const PODIUM_ORDER = ['order-2', 'order-1', 'order-3'];

function ago(at: Date, now: number): string {
  const min = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/**
 * The top three on a podium, each opening the meetings behind their number, and under them the
 * latest wins with a cheer (owner, 25 Nov 2026: "bring back cheer"), as many as fill the space the
 * other two parts leave, so there is no gap below.
 */
function TopBookers({ s, now }: { s: Scoreboard; now: number }) {
  const me = s.me;
  return (
    <section className={clsx(PART, LATER_PART)} aria-label="Top bookers">
      <CardHead title="Top bookers" aside={<Aside>this month</Aside>} />
      {s.top.length ? (
        <ol aria-label="The top three this month" className="flex items-end gap-1.5 border-b border-line">
          {s.top.map((t, i) => {
            const k = Math.min(t.place, 3) - 1;
            return (
              <li key={t.userId} className={clsx('min-w-0 flex-1', s.top.length > 1 && PODIUM_ORDER[i])}>
                <Link href={countedHref(s, t.userId)} title={`Open the ${t.meetings} meeting${t.meetings === 1 ? '' : 's'} ${t.you ? 'you' : t.name} booked this month`} aria-label={`${ordinal(t.place)}: ${t.name}, ${t.meetings} booked this month. Open their meetings`} className="group flex flex-col items-center gap-[3px] text-center">
                  <Avatar name={t.name} shape="circle" size={k ? 32 : 40} style={{ boxShadow: `0 0 0 2px #ffffff, 0 0 0 4px ${RING[k]}` }} />
                  <span className="mt-1 max-w-full truncate text-[12.5px] font-semibold text-ink-900 group-hover:underline">{t.you ? 'You' : t.name}</span>
                  <span className="max-w-full text-[11.5px] leading-[15px] tabular-nums text-ink-600">
                    <span className="whitespace-nowrap"><span className="font-semibold text-ink-900">{t.meetings}</span> booked</span>
                    {t.firstMeetings ? <span className="whitespace-nowrap"> · {t.firstMeetings} first</span> : null}
                  </span>
                  <span aria-hidden className={clsx('mt-[5px] flex w-full items-center justify-center rounded-t-lg font-bold tabular-nums', STEP[k])}>{t.place}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      ) : <p className="text-[12.5px] text-ink-500">Nobody on the board yet this month: the first meeting takes first place.</p>}
      {me && !s.top.some((t) => t.you) ? (
        <p className="-mt-1 text-[12.5px] tabular-nums text-ink-700">
          <span className="font-semibold text-ink-900">You:</span> {me.rank ? `${ordinal(me.rank)} of ${me.of}, ${me.meetings} booked` : 'not on the board yet this month'}
        </p>
      ) : null}
      <div className="-mb-1 flex items-baseline justify-between gap-2">
        <h4 className="text-[11.5px] font-medium text-ink-500">Latest wins</h4>
        <Aside>last two weeks</Aside>
      </div>
      {s.wins.length ? (
        <FitList stacked={3} label="Meetings booked lately">
          {s.wins.map((w) => (
            <li key={w.meetingId} className="flex items-center gap-2.5">
              <Avatar name={w.bookedBy} shape="circle" size={28} />
              <div className="min-w-0 flex-1 text-[12.5px] leading-[1.35]">
                {/* Two lines at most: no `block` here, which would undo the clamp and let a narrow row grow. */}
                <Link href={`/meetings/${w.meetingId}`} className="line-clamp-2 break-words text-ink-800 hover:text-brand-700">
                  <span className="font-semibold text-ink-900">{w.mine ? 'You' : w.bookedBy}</span> booked {w.number === 1 ? <span className="font-medium text-emerald-700">a first meeting</span> : w.number ? `a follow-up (${ordinal(w.number)} meeting)` : 'a meeting'}
                </Link>
                <span className="block truncate text-[11.5px] text-ink-500">{[w.company, ago(w.at, now)].filter(Boolean).join(' · ')}</span>
              </div>
              <KudosButton meetingId={w.meetingId} count={w.kudos} mine={w.kudosByMe} own={w.mine} who={w.bookedBy} />
            </li>
          ))}
        </FitList>
      ) : <p className="text-[12.5px] text-ink-500">Nothing booked in the last two weeks yet. Be the first.</p>}
    </section>
  );
}
