import clsx from 'clsx';
import Link from 'next/link';
import { Suspense } from 'react';
import { requireUser } from '@/lib/auth/current-user';
import { diffDays, formatLocalDate } from '@/lib/dates';
import { buildHome, type TeamRow } from '@/lib/home-query';
import { TASK_CHANNELS, type TaskChannel } from '@/lib/tasks-query';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { ActionIcon, IconBolt, IconCalendar, IconCheck, IconChevronRight, IconCompany, IconPeople } from '@/components/icons';
import { Avatar, EmptyState, Surface } from '@/components/ui';

const CHANNEL_LABELS: Record<TaskChannel, string> = { CALL: 'Calls', EMAIL: 'Emails', LINKEDIN: 'LinkedIn' };

/**
 * A tile is a number and, under it, one measured fact about that number. Both change with the
 * data; neither is a sentence explaining what the tile is for. Figures inside the fact are bold
 * so they read as values rather than prose.
 */
function Tile({ label, value, hint, href, icon, tone }: { label: string; value: number | string; hint?: React.ReactNode; href: string; icon: React.ReactNode; tone?: 'warn' }) {
  return (
    <Link href={href} className="surface group relative block px-5 py-5 transition hover:border-brand-300 hover:shadow-md">
      <span className="flex items-center justify-between gap-2 text-[12px] font-medium text-ink-500">{label}<span className="text-ink-400 group-hover:text-brand-600">{icon}</span></span>
      <span className={clsx('metric-value mt-4 block', value === 0 || value === '0' ? 'text-ink-400' : undefined)}>{value}</span>
      {hint ? <span className={`mt-3 block text-[11px] ${tone === 'warn' ? 'text-amber-700' : 'text-ink-600'}`}>{hint}</span> : null}
    </Link>
  );
}

/**
 * A number inside a sentence. It has to read as live data without breaking the line: the step up
 * is in colour, against the muted words around it, rather than a jump to bold mid-sentence.
 */
function N({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return <span className={clsx('font-medium tabular-nums', tone === 'warn' ? 'text-amber-800' : 'text-ink-900')}>{children}</span>;
}

/** Its own Suspense boundary, for hydration: see the note on the Activity page. Home missed once in thirty walks. */
export default function HomePage() {
  return (
    <Suspense fallback={<div className="space-y-4 px-6 pb-8 pt-2"><div className="surface h-[52vh]" /></div>}>
      <HomeContent />
    </Suspense>
  );
}

async function HomeContent() {
  const user = await requireUser();
  const h = await buildHome(user);
  const first = user.name.split(/\s+/)[0];
  const mine = `fo=${encodeURIComponent(user.id)}`;
  const focusTab = h.my.overdueTotal ? 'overdue' : h.my.todayTotal ? 'today' : 'upcoming';
  const completed = h.my.completedToday;
  const allToday = completed + h.my.todayTotal;
  const progress = allToday ? Math.round(completed / allToday * 100) : 0;

  return (
    <div className="space-y-5 px-6 pb-8 pt-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[30px] font-semibold tracking-[-0.045em] text-ink-900">Good day, {first}<span className="text-brand-500">.</span></h1>
        <span className="inline-flex items-center gap-2 text-[12px] text-ink-500"><IconCalendar size={14} />{formatLocalDate(h.today, 'long')}</span>
      </div>


      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Tile
          label="To reach today"
          value={h.my.peopleToReachToday}
          hint={h.my.overdueTotal ? <><N tone="warn">{h.my.overdueTotal}</N> overdue {h.my.overdueTotal === 1 ? 'step' : 'steps'}</> : <><N>{h.my.todayTotal}</N> {h.my.todayTotal === 1 ? 'step' : 'steps'} due</>}
          href={`/tasks?tab=today&mode=flow&${mine}`}
          icon={<IconPeople size={17} />}
          tone={h.my.overdueTotal ? 'warn' : undefined}
        />
        <Tile label="Completed today" value={completed} hint={allToday ? <><N>{progress}%</N> of <N>{allToday}</N> done</> : undefined} href={`/tasks?tab=done&${mine}`} icon={<IconCheck size={17} />} />
        <Tile label="My accounts" value={h.my.accounts} hint={<><N>{h.my.activeAccounts}</N> with live work</>} href={`/accounts?pod=&fo=${user.id}`} icon={<IconCompany size={17} />} />
        <Tile label="My people" value={h.my.relationships} hint={<><N>{h.my.inSequence}</N> in a campaign</>} href={`/people?pod=&fo=${user.id}`} icon={<IconPeople size={17} />} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
        <Surface flush className="flex flex-col">
          <div className="relative flex-1 overflow-hidden bg-[#203e35] px-6 py-6 text-white">
            <div className="focus-art" aria-hidden />
            <div className="relative">
              <p className="mb-3 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-[#d5e9ad]"><IconBolt size={12} /> {h.my.overdueTotal ? 'Overdue first' : h.my.todayTotal ? 'Due today' : h.my.nextForTeam ? 'Nothing due for you' : 'Nothing due'}</p>
              <h2 className="flex items-baseline gap-3 text-[25px] font-medium leading-[1.25] tracking-[-0.035em]">
                <span className="text-[46px] font-semibold leading-none tracking-[-0.04em]">{h.my.overdueTotal || h.my.todayTotal || h.my.peopleToReachToday}</span>
                <span>{h.my.overdueTotal ? `overdue ${h.my.overdueTotal === 1 ? 'step' : 'steps'}` : h.my.todayTotal ? `${h.my.todayTotal === 1 ? 'step' : 'steps'} due today` : 'due today'}</span>
              </h2>
              <p className="mb-5 mt-3 text-[12px] text-[#c1d4ca]">
                {h.my.overdueTotal && h.my.todayTotal ? <><span className="font-medium text-white">{h.my.todayTotal}</span> more due today across <span className="font-medium text-white">{h.my.peopleToReachToday}</span> {h.my.peopleToReachToday === 1 ? 'person' : 'people'}</> : null}
                {!h.my.overdueTotal && h.my.todayTotal ? <>across <span className="font-medium text-white">{h.my.peopleToReachToday}</span> {h.my.peopleToReachToday === 1 ? 'person' : 'people'}, <span className="font-medium text-white">{completed}</span> already done</> : null}
                {!h.my.overdueTotal && !h.my.todayTotal ? <><span className="font-medium text-white">{completed}</span> completed today</> : null}
              </p>
              <Link href={`/tasks?tab=${focusTab}&mode=flow&${mine}`} className="inline-flex items-center gap-3 rounded-lg bg-[#d5e9ad] px-4 py-2.5 text-[12px] font-semibold text-[#203e35] transition hover:bg-[#e2f0c6]">{h.my.todayTotal || h.my.overdueTotal ? 'Start task flow' : 'View upcoming tasks'}<IconChevronRight size={15} /></Link>
            </div>
          </div>
          <div className="grid grid-cols-3 divide-x divide-line">{TASK_CHANNELS.map((c) => <Link key={c} href={`/tasks?tab=${h.my.today[c] ? 'today' : h.my.overdue[c] ? 'overdue' : 'upcoming'}&type=${c}&mode=flow&${mine}`} className="group px-3 py-4 transition hover:bg-brand-50/50 sm:px-5">
            <span className="flex items-center gap-2 text-[11px] font-medium text-ink-500"><ActionIcon action={c} size={14} />{CHANNEL_LABELS[c]} today</span><span className="mt-2 flex items-baseline gap-2"><span className={clsx('text-[25px] font-semibold tracking-tight', h.my.today[c] ? 'text-ink-900' : 'text-ink-400')}>{h.my.today[c]}</span><span className="text-[11px] text-ink-600">{h.my.overdue[c] ? <><N tone="warn">{h.my.overdue[c]}</N> overdue</> : <><N>{h.my.upcoming[c]}</N> upcoming</>}</span></span>
          </Link>)}</div>
        </Surface>
        <Surface flush>
          <div className="flex items-center justify-between border-b border-line px-5 py-4"><h2 className="text-[14px] font-semibold">{h.my.nextForTeam ? 'Up next for the team' : 'Up next'}</h2><Link href={`/tasks?tab=${focusTab}&${h.my.nextForTeam ? 'fo=' : mine}`} className="inline-flex items-center gap-1 text-[12px] font-medium text-brand-700 hover:underline">All tasks <IconChevronRight size={13} /></Link></div>
          {h.my.nextTasks.length ? <ul>{(['Overdue', 'Today', 'Coming up'] as const).map((when) => {
            const rows = h.my.nextTasks.filter((t) => (when === 'Overdue' ? t.due < h.today : when === 'Today' ? t.due === h.today : t.due > h.today));
            return rows.length ? <li key={when}>
              <div className={`border-b border-line/70 bg-canvas/60 px-5 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] ${when === 'Overdue' ? 'text-red-700' : 'text-ink-500'}`}>{when}{!h.my.nextForTeam && when !== 'Coming up' ? <span className="tabular-nums"> · {when === 'Overdue' ? h.my.overdueTotal : h.my.todayTotal}</span> : null}</div>
              <ul className="divide-y divide-line/70">{rows.map((task) => <li key={task.id}><Link href={`/tasks?task=${task.id}&mode=flow&tab=${task.due < h.today ? 'overdue' : task.due === h.today ? 'today' : 'upcoming'}&${h.my.nextForTeam ? 'fo=' : mine}`} className="flex items-center gap-3 px-5 py-2.5 transition hover:bg-brand-50/50">
                <Avatar name={task.name} shape="circle" size={32} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink-900">{task.name}</span>{when !== 'Today' ? <DueLabel due={task.due} today={h.today} /> : null}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-700"><span className="flex shrink-0 gap-1 text-ink-500">{task.actions.map((a) => <ActionIcon key={a} action={a} size={13} />)}</span><span className="shrink-0">{task.actions.map((a) => ACTION_LABELS[a as keyof typeof ACTION_LABELS] ?? a).join(' + ')}</span><span className="min-w-0 truncate text-ink-500">· {[task.campaign ?? 'No campaign', h.my.nextForTeam && task.fo ? task.fo : task.company].filter(Boolean).join(' · ')}</span></span>
                </span>
              </Link></li>)}</ul>
            </li> : null;
          })}</ul> : <EmptyState icon={<IconCheck size={20} />} title="Nothing due" />}
        </Surface>
      </div>

      {h.team.length ? <TeamBoard rows={h.team} week={{ from: h.week.from, to: h.week.to }} title="The team this week" /> : null}
    </div>
  );
}

/** How late an overdue step is, or when a later one falls. */
function DueLabel({ due, today }: { due: string; today: string }) {
  const late = diffDays(due, today);
  const [tone, text] = due < today ? ['bg-red-50 text-red-700', late === 1 ? '1 day' : `${late} days`] : ['bg-canvas text-ink-600', formatLocalDate(due)];
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium tabular-nums ${tone}`}>{text}</span>;
}

/** One figure on the board, centred and easy to read; zero is quiet so the eye lands on work. */
function Figure({ value, tone }: { value: number; tone?: 'warn' | 'good' | 'brand' }) {
  if (!value) return <span className="text-ink-300">0</span>;
  const colour = tone === 'warn' ? 'text-red-700' : tone === 'good' ? 'text-emerald-700' : tone === 'brand' ? 'text-brand-700' : 'text-ink-900';
  return <span className={`font-medium ${colour}`}>{value.toLocaleString('en-US')}</span>;
}

/** How far through the week's steps an FO is: the count and a bar that is their own week. */
function WeekProgress({ done, due }: { done: number; due: number }) {
  const pct = due ? Math.min(100, Math.round((done / due) * 100)) : 0;
  return <div className="min-w-[200px]">
    <div className="mb-2 text-[14px] tabular-nums text-ink-600"><span className="font-medium text-ink-900">{done.toLocaleString('en-US')}</span> of {due.toLocaleString('en-US')} steps done</div>
    <div className="h-2.5 overflow-hidden rounded-full bg-line" role="img" aria-label={`${pct}% of this week's steps done`}><div className={`h-full rounded-full transition-[width] ${pct >= 100 ? 'bg-emerald-500' : 'bg-brand-500'}`} style={{ width: `${pct}%` }} /></div>
  </div>;
}

/**
 * The week's board, Monday to Sunday. Each FO with work this week is a row: who they are, how far
 * through the week's steps they are, the people reached, what is due today and overdue, and what
 * came back. Every figure is in steps - one person's step of outreach - and the bar is each FO's
 * own week, counted against every step planned for it, not a race against the busiest person.
 * Those with nothing this week share one line at the foot.
 */
function TeamBoard({ rows, week, title }: { rows: TeamRow[]; week: { from: string; to: string }; title: string }) {
  const busy = rows.filter((r) => r.dueWeek + r.today + r.overdue + r.replies + r.meetings > 0);
  const idle = rows.filter((r) => !busy.includes(r));
  const total = busy.reduce(
    (a, r) => ({ today: a.today + r.today, overdue: a.overdue + r.overdue, doneWeek: a.doneWeek + r.doneWeek, dueWeek: a.dueWeek + r.dueWeek, peopleWeek: a.peopleWeek + r.peopleWeek, replies: a.replies + r.replies, meetings: a.meetings + r.meetings }),
    { today: 0, overdue: 0, doneWeek: 0, dueWeek: 0, peopleWeek: 0, replies: 0, meetings: 0 },
  );
  const head = 'px-3 py-3 text-center font-medium';
  const cell = 'px-3 py-4 text-center text-[18px] tabular-nums';
  return (
    <Surface flush>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-4">
        <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
        <p className="text-[13px] text-ink-500">{formatLocalDate(week.from)} to {formatLocalDate(week.to)}</p>
      </div>
      <table className="w-full table-fixed border-collapse text-[15px]">
        <colgroup><col className="w-[250px]" /><col /><col className="w-[104px]" /><col className="w-[104px]" /><col className="w-[104px]" /><col className="w-[104px]" /><col className="w-[104px]" /><col className="w-[56px]" /></colgroup>
        <thead>
          <tr className="border-b border-line bg-[#fafbf9] text-[12px] uppercase tracking-[0.07em] text-ink-500">
            <th className="px-5 py-3 text-left font-medium">FO</th>
            <th className="px-3 py-3 text-left font-medium">This week</th>
            <th className={head}>Reached</th>
            <th className={head}>Due today</th>
            <th className={head}>Overdue</th>
            <th className={head}>Replies</th>
            <th className={head}>Meetings</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {busy.map((t) => (
            <tr key={t.id} className="group border-b border-line/70 transition last:border-b-0 hover:bg-canvas/60">
              <td className="px-5 py-4">
                <div className="flex items-center gap-3">
                  <Avatar name={t.name} shape="circle" size={36} />
                  <span className="min-w-0"><span className="block truncate text-[16px] font-medium text-ink-900">{t.name}</span>{t.pod ? <span className="mt-0.5 block truncate text-[12.5px] text-ink-500">{t.pod}</span> : null}</span>
                </div>
              </td>
              <td className="px-3 py-4">{t.dueWeek ? <WeekProgress done={t.doneWeek} due={t.dueWeek} /> : <span className="text-[14px] text-ink-400">Nothing planned</span>}</td>
              <td className={cell}><Figure value={t.peopleWeek} /></td>
              <td className={cell}><Figure value={t.today} /></td>
              <td className={cell}><Figure value={t.overdue} tone="warn" /></td>
              <td className={cell}><Figure value={t.replies} tone="good" /></td>
              <td className={cell}><Figure value={t.meetings} tone="brand" /></td>
              <td className="px-3 py-4 text-right">
                <Link href={`/tasks?tab=today&fo=${t.id}`} aria-label={`${t.name}'s tasks`} className="inline-grid h-8 w-8 place-items-center rounded-lg text-ink-400 transition hover:bg-brand-50 hover:text-brand-700 group-hover:text-brand-700"><IconChevronRight size={16} /></Link>
              </td>
            </tr>
          ))}
          {!busy.length ? <tr><td colSpan={8} className="px-5 py-8 text-center text-[14px] text-ink-500">Nothing planned for anyone this week</td></tr> : null}
        </tbody>
        <tfoot>
          {busy.length > 1 ? (
            <tr className="border-t border-line bg-canvas/50 text-ink-700">
              <td className="px-5 py-3.5 text-[15px] font-medium">Everyone</td>
              <td className="px-3 py-3.5">{total.dueWeek ? <WeekProgress done={total.doneWeek} due={total.dueWeek} /> : null}</td>
              <td className={cell}><Figure value={total.peopleWeek} /></td>
              <td className={cell}><Figure value={total.today} /></td>
              <td className={cell}><Figure value={total.overdue} tone="warn" /></td>
              <td className={cell}><Figure value={total.replies} tone="good" /></td>
              <td className={cell}><Figure value={total.meetings} tone="brand" /></td>
              <td />
            </tr>
          ) : null}
          {idle.length ? (
            <tr className="border-t border-line">
              <td colSpan={8} className="px-5 py-3 text-[13px] text-ink-500"><span className="text-ink-700">Nothing this week:</span> {idle.map((r, i) => <span key={r.id}>{i ? ', ' : ''}<Link href={`/tasks?tab=upcoming&fo=${r.id}`} className="hover:text-brand-700 hover:underline">{r.name}</Link></span>)}</td>
            </tr>
          ) : null}
        </tfoot>
      </table>
    </Surface>
  );
}
