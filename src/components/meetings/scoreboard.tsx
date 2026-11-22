import Link from 'next/link';
import clsx from 'clsx';
import type { Scoreboard } from '@/lib/meetings/scoreboard';
import { ordinal } from '@/lib/meetings/numbering';
import { Avatar } from '@/components/ui';
import { KudosButton } from '@/components/meetings/kudos-button';

/**
 * The top of Meetings (owner, 21 Nov 2026: gamified, so people feel encouraged to book): your month
 * against the company target, the pod race and the top three, and the recent wins with a 👏.
 */
export function ScoreboardPanel({ s, now }: { s: Scoreboard; now: number }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]" aria-label="Meetings scoreboard" role="region">
      {s.me ? <YourMonth s={s} me={s.me} /> : <TeamMonth s={s} />}
      <PodRace s={s} />
      <Wins s={s} now={now} />
    </div>
  );
}

const BADGE_ICON: Record<string, string> = { board: '🎯', first: '🤝', hattrick: '🎩', streak: '🔥', goal: '🏆', best: '⭐' };

function Ring({ value, of, reached }: { value: number; of: number; reached: boolean }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const share = Math.min(1, of ? value / of : 0);
  return (
    <div className="relative h-[108px] w-[108px] shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" className="stroke-[#e9eeea]" />
        {share > 0 ? <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${c * share} ${c}`} className={clsx('transition-[stroke-dasharray] duration-700', reached ? 'stroke-amber-400' : 'stroke-brand-500')} /> : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[26px] font-semibold leading-none tracking-[-0.04em] tabular-nums text-ink-900">{value}</span>
        <span className="mt-1 text-[11px] text-ink-500">of {of}</span>
      </div>
    </div>
  );
}

function CardHead({ title, aside }: { title: string; aside?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[13px] font-semibold text-ink-900">{title}</h3>
      {aside}
    </div>
  );
}

const daysLeft = (n: number) => <span className="rounded-full bg-canvas px-2 py-0.5 text-[11.5px] tabular-nums text-ink-600">{n === 0 ? 'Last day' : `${n} day${n === 1 ? '' : 's'} left`}</span>;

function YourMonth({ s, me }: { s: Scoreboard; me: NonNullable<Scoreboard['me']> }) {
  const reached = me.meetings >= s.goal;
  return (
    <section className="surface flex flex-col gap-3 p-4" aria-label="Your month">
      <CardHead title={`Your ${s.month.label}`} aside={daysLeft(s.month.daysLeft)} />
      <div className="flex items-center gap-4">
        <Ring value={me.meetings} of={s.goal} reached={reached} />
        <div className="min-w-0 space-y-1.5 text-[12.5px] text-ink-700">
          <p className="text-[13px] font-medium text-ink-900">{me.next}</p>
          <p><span className="font-semibold tabular-nums text-ink-900">{me.firstMeetings}</span> first meeting{me.firstMeetings === 1 ? '' : 's'}{me.rank ? <> · <span className="font-semibold text-ink-900">#{me.rank}</span> of {me.of}</> : null}</p>
          <p>{me.streakWeeks ? <>🔥 <span className="font-semibold tabular-nums text-ink-900">{me.streakWeeks}</span>-week streak</> : 'Book one this week to start a streak'}{me.best ? <> · best {me.best.count} in {me.best.label}</> : null}</p>
          {me.waiting ? <p><Link href="/meetings/approval" className="text-amber-800 underline decoration-amber-300 underline-offset-2 hover:text-amber-900">{me.waiting} more waiting for approval</Link>: add the recording link to count {me.waiting === 1 ? 'it' : 'them'} now.</p> : null}
        </div>
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label="Badges this month">
        {me.badges.map((b) => (
          <li key={b.key} title={`${b.label}: ${b.hint}${b.earned ? ' (earned)' : ''}`} className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px]', b.earned ? 'border-amber-200 bg-amber-50 font-medium text-amber-900' : 'border-ink-200/70 bg-[#f8faf9] text-ink-400')}>
            <span aria-hidden className={b.earned ? '' : 'opacity-40 grayscale'}>{BADGE_ICON[b.key]}</span>{b.label}<span className="sr-only">{b.earned ? ', earned' : `, not yet: ${b.hint}`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TeamMonth({ s }: { s: Scoreboard }) {
  const whose = s.team.pods ? (s.team.pods === 1 ? 'Your pod\'s' : 'Your pods\'') : 'The team\'s';
  return (
    <section className="surface flex flex-col gap-3 p-4" aria-label={`${whose} month`}>
      <CardHead title={`${whose} ${s.month.label}`} aside={daysLeft(s.month.daysLeft)} />
      <div className="flex items-center gap-4">
        <Ring value={s.team.meetings} of={s.team.target} reached={s.team.meetings >= s.team.target} />
        <div className="min-w-0 space-y-1.5 text-[12.5px] text-ink-700">
          <p className="text-[13px] font-medium text-ink-900">Toward {s.goal} meetings for each FO this month.</p>
          <p><span className="font-semibold tabular-nums text-ink-900">{s.team.firstMeetings}</span> first meeting{s.team.firstMeetings === 1 ? '' : 's'} · <span className="font-semibold tabular-nums text-ink-900">{s.team.bookers}</span> {s.team.bookers === 1 ? 'person' : 'people'} on the board</p>
        </div>
      </div>
    </section>
  );
}

const MEDALS = ['🥇', '🥈', '🥉'];

function PodRace({ s }: { s: Scoreboard }) {
  const max = Math.max(0.1, ...s.pods.map((p) => p.perFo));
  return (
    <section className="surface flex flex-col gap-3 p-4" aria-label="Pod race">
      <CardHead title="Pod race" aside={<span className="text-[11.5px] text-ink-500">meetings per FO</span>} />
      {s.pods.length ? (
        <ol className="space-y-2">
          {s.pods.slice(0, 5).map((p, i) => (
            <li key={p.id} className="text-[12.5px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className={clsx('min-w-0 truncate', p.yours ? 'font-semibold text-ink-900' : 'text-ink-700')}>{i === 0 && p.meetings ? '👑 ' : ''}{p.name}{p.yours ? <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 text-[11px] font-medium text-brand-800">Your pod</span> : null}</span>
                <span className="shrink-0 tabular-nums text-ink-600" title={`${p.perFo} meetings per FO; ${p.meetings} booked by ${p.fos} FO${p.fos === 1 ? '' : 's'}`}><span className="font-semibold text-ink-900">{p.perFo}</span> · {p.meetings} booked</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#eef2ef]"><div className={clsx('h-full rounded-full', p.yours ? 'bg-brand-600' : 'bg-brand-300')} style={{ width: `${Math.max(p.meetings ? 4 : 0, Math.round((p.perFo / max) * 100))}%` }} /></div>
            </li>
          ))}
        </ol>
      ) : <p className="text-[12.5px] text-ink-500">No pods yet.</p>}
      <div className="border-t border-line pt-2.5">
        <h4 className="mb-1.5 text-[11.5px] font-medium text-ink-500">Top bookers</h4>
        {s.top.length ? (
          <ol className="space-y-1">
            {s.top.map((t, i) => (
              <li key={t.userId} className="flex items-center gap-2 text-[12.5px]">
                <span aria-hidden className="w-4 text-center">{MEDALS[i]}</span>
                <span className="sr-only">{ordinal(i + 1)}:</span>
                <Avatar name={t.name} shape="circle" size={22} />
                <span className={clsx('min-w-0 flex-1 truncate', t.you ? 'font-semibold text-ink-900' : 'text-ink-800')}>{t.name}{t.you ? ' (you)' : ''}</span>
                <span className="shrink-0 tabular-nums text-ink-600">{t.meetings}{t.firstMeetings ? <span className="text-ink-400"> · {t.firstMeetings} first</span> : null}</span>
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
      <CardHead title="Recent wins" />
      {s.wins.length ? (
        <ul className="space-y-2.5">
          {s.wins.slice(0, 5).map((w) => (
            <li key={w.meetingId} className="flex items-center gap-2.5">
              <Avatar name={w.bookedBy} shape="circle" size={28} />
              <div className="min-w-0 flex-1 text-[12.5px] leading-[1.35]">
                <Link href={`/meetings/${w.meetingId}`} className="line-clamp-2 block break-words text-ink-800 hover:text-brand-700">
                  <span className="font-semibold text-ink-900">{w.mine ? 'You' : w.bookedBy}</span> booked {w.number === 1 ? <span className="font-medium text-emerald-700">a first meeting</span> : w.number ? `a ${ordinal(w.number)} meeting` : 'a meeting'}
                </Link>
                <span className="block truncate text-[11.5px] text-ink-500">{[w.company, ago(w.at, now)].filter(Boolean).join(' · ')}</span>
              </div>
              <KudosButton meetingId={w.meetingId} count={w.kudos} mine={w.kudosByMe} own={w.mine} who={w.bookedBy} />
            </li>
          ))}
        </ul>
      ) : <p className="text-[12.5px] text-ink-500">No meetings booked in the last two weeks yet. Be the first.</p>}
    </section>
  );
}
