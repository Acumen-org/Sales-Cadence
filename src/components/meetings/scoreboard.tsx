import Link from 'next/link';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { Scoreboard } from '@/lib/meetings/scoreboard';
import { ordinal } from '@/lib/meetings/numbering';
import { Avatar } from '@/components/ui';
import { KudosButton } from '@/components/meetings/kudos-button';

/**
 * The top of Meetings (owner, 21 and 22 Nov 2026: gamified, so people feel encouraged to book, and
 * every figure plain): the month against its target with where it should be by today, the pod race
 * against each pod's own target, the top three bookers (each opens their meetings), and recent wins.
 */
export function ScoreboardPanel({ s, now, admin = false }: { s: Scoreboard; now: number; admin?: boolean }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)]" aria-label="Meetings scoreboard" role="region">
      {s.me ? <YourMonth s={s} me={s.me} /> : <TeamMonth s={s} admin={admin} />}
      <PodRace s={s} />
      <Wins s={s} now={now} />
    </div>
  );
}

/** The meetings that count, booked by this person this month: what their number is made of. */
export const countedHref = (s: Pick<Scoreboard, 'month'>, userId: string) => `/meetings?booked=${encodeURIComponent(userId)}&from=${s.month.first}&to=${s.month.last}&counted=1`;

const BADGE_ICON: Record<string, string> = { board: '🎯', first: '🤝', hattrick: '🎩', streak: '🔥', goal: '🏆', best: '⭐' };

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
 * Booked against the target, with a mark where the month should be by today. The bar is the target;
 * the fill is what is booked; the tick is today's pace.
 */
function TargetBar({ booked, target, pace, day, days }: { booked: number; target: number; pace: number; day: number; days: number }) {
  const reached = booked >= target;
  const fill = Math.min(100, Math.round((booked / Math.max(1, target)) * 100));
  const tick = Math.min(100, Math.round((day / Math.max(1, days)) * 100));
  return (
    <div>
      <div className="relative h-2.5 rounded-full bg-[#e9eeea]" role="img" aria-label={`${booked} of ${target} booked; ${pace} by today keeps the month on track`}>
        <div className={clsx('h-full rounded-full transition-[width] duration-700', reached ? 'bg-amber-400' : booked >= pace ? 'bg-brand-500' : 'bg-brand-400')} style={{ width: `${fill}%` }} />
        {!reached ? <span aria-hidden className="absolute -top-1 h-[18px] w-0.5 rounded-full bg-ink-700" style={{ left: `calc(${tick}% - 1px)` }} /> : null}
      </div>
      {/* The tick's label sits under it, turned to whichever side has room; the target is in the line above. */}
      <div className="relative mt-1.5 h-4 text-[11px] tabular-nums text-ink-500">
        {!reached ? <span className={clsx('absolute whitespace-nowrap font-medium text-ink-700', tick > 55 ? '-translate-x-full pr-1' : 'pl-1')} style={{ left: `${tick}%` }}>by today: {pace}</span> : <span className="absolute left-0 font-medium text-amber-800">target reached</span>}
      </div>
    </div>
  );
}

function Figure({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[17px] font-semibold leading-tight tracking-[-0.02em] tabular-nums text-ink-900">{value}</div>
      <div className="mt-0.5 text-[11.5px] text-ink-500">{label}</div>
    </div>
  );
}

function MonthCard({ title, s, booked, target, pace, status, rule, figures, footer, label }: { title: string; s: Scoreboard; booked: number; target: number; pace: number; status: string; rule: ReactNode; figures: ReactNode; footer?: ReactNode; label: string }) {
  return (
    <section className="surface flex flex-col gap-3 p-4" aria-label={label}>
      <CardHead title={title} aside={daysLeft(s.month.daysLeft)} />
      <div className="flex items-end gap-2">
        <span className="text-[34px] font-semibold leading-none tracking-[-0.04em] tabular-nums text-ink-900">{booked}</span>
        <span className="pb-1 text-[13px] text-ink-600">of {target} meetings booked</span>
      </div>
      <TargetBar booked={booked} target={target} pace={pace} day={s.month.day} days={s.month.days} />
      <p className="text-[13px] font-medium text-ink-900">{status}</p>
      <div className="grid grid-cols-3 gap-2 border-t border-line pt-3">{figures}</div>
      <p className="text-[11.5px] text-ink-500">{rule}</p>
      {footer}
    </section>
  );
}

function YourMonth({ s, me }: { s: Scoreboard; me: NonNullable<Scoreboard['me']> }) {
  return (
    <MonthCard
      label="Your month" title={`Your ${s.month.label}`} s={s} booked={me.meetings} target={s.goal} pace={me.pace} status={me.status}
      figures={<>
        <Figure value={me.firstMeetings} label={me.firstMeetings === 1 ? 'first meeting' : 'first meetings'} />
        <Figure value={me.rank ? `#${me.rank}` : '–'} label={me.rank ? `of ${me.of} who book` : 'not on the board yet'} />
        <Figure value={me.streakWeeks ? `🔥 ${me.streakWeeks}` : '0'} label={me.streakWeeks === 1 ? 'week in a row' : 'weeks in a row'} />
      </>}
      rule={<>Target: {s.goal} meetings a month for each FO. Approved or recorded meetings count.{me.best ? ` Your best month: ${me.best.count} in ${me.best.label}.` : ''}{me.waiting ? <> <Link href="/meetings/approval" className="text-amber-800 underline decoration-amber-300 underline-offset-2">{me.waiting} more waiting for approval</Link>: add the recording link to count {me.waiting === 1 ? 'it' : 'them'} now.</> : null}</>}
      footer={
        <ul className="flex flex-wrap gap-1.5" aria-label="Badges this month">
          {me.badges.map((b) => (
            <li key={b.key} title={`${b.label}: ${b.hint}${b.earned ? ' (earned)' : ''}`} className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px]', b.earned ? 'border-amber-200 bg-amber-50 font-medium text-amber-900' : 'border-ink-200/70 bg-[#f8faf9] text-ink-400')}>
              <span aria-hidden className={b.earned ? '' : 'opacity-40 grayscale'}>{BADGE_ICON[b.key]}</span>{b.label}<span className="sr-only">{b.earned ? ', earned' : `, not yet: ${b.hint}`}</span>
            </li>
          ))}
        </ul>
      }
    />
  );
}

function TeamMonth({ s, admin }: { s: Scoreboard; admin: boolean }) {
  const t = s.team;
  const whose = t.pods ? (t.pods === 1 ? 'Your pod' : 'Your pods') : 'Team';
  return (
    <MonthCard
      label={`${whose} this month`} title={`${whose} · ${s.month.label}`} s={s} booked={t.meetings} target={t.target} pace={t.pace} status={t.status}
      figures={<>
        <Figure value={t.firstMeetings} label={t.firstMeetings === 1 ? 'first meeting' : 'first meetings'} />
        <Figure value={t.meetings - t.firstMeetings} label={t.meetings - t.firstMeetings === 1 ? 'follow-up' : 'follow-ups'} />
        <Figure value={t.waiting} label="waiting for approval" />
      </>}
      rule={<>Target: {s.goal} meetings a month for each of the {t.fos} FO{t.fos === 1 ? '' : 's'}{t.pods ? ` in ${t.pods === 1 ? 'your pod' : 'your pods'}` : ''} = {t.target}. {t.bookers} {t.bookers === 1 ? 'person has' : 'people have'} booked. Approved or recorded meetings count; those waiting count once approved.{admin ? <> <Link href="/settings?tab=meetings" className="text-brand-700 underline decoration-brand-200 underline-offset-2">Change the target</Link></> : null}</>}
    />
  );
}

const MEDALS = ['🥇', '🥈', '🥉'];

function PodRace({ s }: { s: Scoreboard }) {
  return (
    <section className="surface flex flex-col gap-3 p-4" aria-label="Pod race">
      <CardHead title="Pod race" aside={<span className="text-[11.5px] text-ink-500">booked of each pod&apos;s target</span>} />
      {s.pods.length ? (
        <ol className="space-y-2.5">
          {s.pods.slice(0, 5).map((p, i) => (
            <li key={p.id} className="text-[12.5px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className={clsx('min-w-0 truncate', p.yours ? 'font-semibold text-ink-900' : 'text-ink-700')}>{i === 0 && p.meetings ? '👑 ' : ''}{p.name}{p.yours ? <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 text-[11px] font-medium text-brand-800">Your pod</span> : null}</span>
                <span className="shrink-0 tabular-nums text-ink-600"><span className="font-semibold text-ink-900">{p.meetings}</span> of {p.target}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#eef2ef]" role="img" aria-label={`${p.name}: ${p.meetings} of ${p.target} booked`}>
                <div className={clsx('h-full rounded-full', p.share >= 1 ? 'bg-amber-400' : p.yours ? 'bg-brand-600' : 'bg-brand-300')} style={{ width: `${Math.min(100, Math.round(p.share * 100))}%` }} />
              </div>
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
                  <span aria-hidden className="w-4 text-center">{MEDALS[i]}</span>
                  <span className="sr-only">{ordinal(i + 1)}:</span>
                  <Avatar name={t.name} shape="circle" size={22} />
                  <span className={clsx('min-w-0 flex-1 truncate', t.you ? 'font-semibold text-ink-900' : 'text-ink-800')}>{t.name}{t.you ? ' (you)' : ''}</span>
                  <span className="shrink-0 tabular-nums text-ink-600"><span className="font-semibold text-ink-900">{t.meetings}</span> booked{t.firstMeetings ? <span className="text-ink-400"> · {t.firstMeetings} first</span> : null}</span>
                </Link>
              </li>
            ))}
          </ol>
        ) : <p className="text-[12.5px] text-ink-500">Nobody on the board yet this month: the first meeting takes gold.</p>}
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
