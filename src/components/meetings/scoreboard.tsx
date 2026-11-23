import Link from 'next/link';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { MonthProgress, Scoreboard } from '@/lib/meetings/scoreboard';
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
 * The month so far, as a picture (owner, 22 Nov 2026: "simple and nice, make the space worth it"):
 * the green line is the running total of meetings booked; the dashed line is the steady pace that
 * reaches the target on the last day. Under the dashed line is behind, over it is ahead; today's gap
 * is drawn between the two dots.
 */
function MonthChart({ p, target, days, month }: { p: MonthProgress; target: number; days: number; month: string }) {
  const W = 320, H = 104, top = 8, bottom = 3;
  const day = p.daily.length;
  const booked = p.daily[day - 1] ?? 0;
  const max = Math.max(target, booked, 1);
  const x = (d: number) => (d / days) * W;
  const y = (v: number) => H - bottom - (v / max) * (H - top - bottom);
  const line = [[0, 0], ...p.daily.map((v, i) => [i + 1, v])].map(([d, v]) => `${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const short = month.slice(0, 3);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-ink-500">
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-[3px] w-3.5 rounded-full bg-brand-500" />booked</span>
        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-3.5 border-t-2 border-dotted border-ink-300" />on pace for {target}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" role="img" aria-label={p.status}>
        <line x1={0} y1={y(0)} x2={W} y2={y(0)} className="stroke-line" strokeWidth={1} />
        <line x1={0} y1={y(target)} x2={W} y2={y(target)} className="stroke-line" strokeWidth={1} strokeDasharray="1 4" />
        <line x1={0} y1={y(0)} x2={W} y2={y(target)} className="stroke-ink-300" strokeWidth={1.5} strokeDasharray="2 4" strokeLinecap="round" />
        <polygon points={`0,${y(0)} ${line} ${x(day).toFixed(1)},${y(0)}`} className="fill-brand-100/70" />
        <polyline points={line} fill="none" className="stroke-brand-500" strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
        {p.state === 'behind' ? <line x1={x(day)} y1={y(booked) - 5} x2={x(day)} y2={y(p.pace) + 5} className="stroke-amber-400" strokeWidth={2} strokeLinecap="round" /> : null}
        {p.state !== 'reached' ? <circle cx={x(day)} cy={y(p.pace)} r={3.5} className="fill-white stroke-ink-400" strokeWidth={1.5} /> : null}
        <circle cx={x(day)} cy={y(booked)} r={4.5} className={p.state === 'reached' ? 'fill-amber-400 stroke-white' : 'fill-brand-600 stroke-white'} strokeWidth={2} />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-ink-400"><span>1 {short}</span><span>{days} {short}</span></div>
    </div>
  );
}

function StatePill({ p, booked }: { p: MonthProgress; booked: number }) {
  if (p.state === 'reached') return <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[12px] font-medium text-amber-900">🏆 Target reached</span>;
  if (p.state === 'ahead') return <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-800">On pace{booked > p.pace ? ` · ${booked - p.pace} ahead` : ''}</span>;
  return <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[12px] font-medium text-amber-900">Behind pace · {p.pace - booked} short</span>;
}

function Chip({ children, tone = 'plain', href, title }: { children: ReactNode; tone?: 'plain' | 'warn'; href?: string; title?: string }) {
  const cls = clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] tabular-nums', tone === 'warn' ? 'bg-amber-50 text-amber-900 hover:bg-amber-100' : 'bg-canvas text-ink-700');
  return href ? <Link href={href} title={title} className={cls}>{children}</Link> : <span title={title} className={cls}>{children}</span>;
}

function MonthCard({ label, title, s, booked, target, p, chips, rule, footer }: { label: string; title: string; s: Scoreboard; booked: number; target: number; p: MonthProgress; chips: ReactNode; rule: ReactNode; footer?: ReactNode }) {
  return (
    <section className="surface flex flex-col gap-3 p-4" aria-label={label}>
      <CardHead title={title} aside={daysLeft(s.month.daysLeft)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-1.5" title="Approved or recorded meetings count. Those waiting for approval count once approved.">
          <span className="text-[38px] font-semibold leading-none tracking-[-0.04em] tabular-nums text-ink-900">{booked}</span>
          <span className="text-[20px] font-medium leading-none tabular-nums text-ink-400">/ {target}</span>
          <span className="ml-1 text-[12.5px] text-ink-500">booked</span>
        </div>
        <StatePill p={p} booked={booked} />
      </div>
      <MonthChart p={p} target={target} days={s.month.days} month={s.month.label} />
      <p className="text-[13px] font-medium text-ink-900">{p.state === 'reached' ? (booked > target ? `${booked - target} over target` : 'Right on target') : `${p.toGo} to go · about ${p.perDay} a working day`}</p>
      <div className="flex flex-wrap gap-1.5">{chips}</div>
      {footer}
      <p className="mt-auto text-[11.5px] text-ink-500">{rule}</p>
    </section>
  );
}

function YourMonth({ s, me }: { s: Scoreboard; me: NonNullable<Scoreboard['me']> }) {
  return (
    <MonthCard
      label="Your month" title={`Your ${s.month.label}`} s={s} booked={me.meetings} target={s.goal} p={me}
      chips={<>
        <Chip><b className="font-semibold text-ink-900">{me.firstMeetings}</b> first meeting{me.firstMeetings === 1 ? '' : 's'}</Chip>
        <Chip>{me.rank ? <><b className="font-semibold text-ink-900">#{me.rank}</b> of {me.of}</> : 'Not ranked yet'}</Chip>
        <Chip>🔥 <span><b className="font-semibold text-ink-900">{me.streakWeeks}</b>-week streak</span></Chip>
        {me.waiting ? <Chip tone="warn" href="/meetings/approval" title="Add the recording link to count it now">{me.waiting} waiting for approval</Chip> : null}
      </>}
      footer={
        <ul className="flex flex-wrap gap-1.5" aria-label="Badges this month">
          {me.badges.map((b) => (
            <li key={b.key} title={`${b.label}: ${b.hint}${b.earned ? ' (earned)' : ''}`} className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px]', b.earned ? 'border-amber-200 bg-amber-50 font-medium text-amber-900' : 'border-ink-200/70 bg-[#f8faf9] text-ink-400')}>
              <span aria-hidden className={b.earned ? '' : 'opacity-40 grayscale'}>{BADGE_ICON[b.key]}</span>{b.label}<span className="sr-only">{b.earned ? ', earned' : `, not yet: ${b.hint}`}</span>
            </li>
          ))}
        </ul>
      }
      rule={<>Target: {s.goal} a month{me.best ? ` · your best: ${me.best.count} in ${me.best.label}` : ''}</>}
    />
  );
}

function TeamMonth({ s, admin }: { s: Scoreboard; admin: boolean }) {
  const t = s.team;
  const whose = t.pods ? (t.pods === 1 ? 'Your pod' : 'Your pods') : 'Team';
  return (
    <MonthCard
      label={`${whose} this month`} title={`${whose} · ${s.month.label}`} s={s} booked={t.meetings} target={t.target} p={t}
      chips={<>
        <Chip><b className="font-semibold text-ink-900">{t.firstMeetings}</b> first meeting{t.firstMeetings === 1 ? '' : 's'}</Chip>
        <Chip><b className="font-semibold text-ink-900">{t.meetings - t.firstMeetings}</b> follow-up{t.meetings - t.firstMeetings === 1 ? '' : 's'}</Chip>
        {t.waiting ? <Chip tone="warn" href="/meetings/approval" title="They count once approved">{t.waiting} waiting for approval</Chip> : null}
      </>}
      rule={<>Target: {s.goal} per FO × {t.fos} FO{t.fos === 1 ? '' : 's'}{admin ? <> · <Link href="/settings?tab=meetings" className="text-brand-700 hover:underline">Change</Link></> : null}</>}
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
