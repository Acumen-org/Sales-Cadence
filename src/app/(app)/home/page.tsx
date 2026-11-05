import clsx from 'clsx';
import Link from 'next/link';
import { Suspense } from 'react';
import { requireUser } from '@/lib/auth/current-user';
import { diffDays, formatLocalDate } from '@/lib/dates';
import { buildHome } from '@/lib/home-query';
import { TASK_CHANNELS, type TaskChannel } from '@/lib/tasks-query';
import { ACTION_LABELS } from '@/lib/sequences/steps';
import { COLD_CONTACT_BASE } from '@/lib/subject';
import { ActionIcon, IconCalendar, IconCheck, IconChevronRight, IconCompany, IconPeople } from '@/components/icons';
import { Avatar, EmptyState, Surface } from '@/components/ui';
import { TeamBoard } from '@/components/home/team-board';

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
  // B094: the tab the panel shows; the user's own most urgent tab when it lists their work.
  const focusTab = h.my.focusTab;
  const completed = h.my.completedToday;

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
          // B095: overdue work is work to do today, and the tile opens the tab that holds it.
          href={`/tasks?tab=${h.my.overdueTotal ? 'overdue' : 'today'}&mode=flow&${mine}`}
          icon={<IconPeople size={17} />}
          tone={h.my.overdueTotal ? 'warn' : undefined}
        />
        <Tile label="Completed today" value={completed} hint={h.my.todayTotal ? <><N>{h.my.todayTotal}</N> still due today</> : undefined} href={`/tasks?tab=done&${mine}`} icon={<IconCheck size={17} />} />
        <Tile label="My accounts" value={h.my.accounts} hint={<><N>{h.my.activeAccounts}</N> with live work</>} href={`/accounts?pod=&fo=${user.id}`} icon={<IconCompany size={17} />} />
        {/* D2: CRM people and live cold contacts owned, with no distinction; a rep with only cold contacts opens them. */}
        <Tile label="My people" value={h.my.people} hint={<><N>{h.my.inSequence}</N> in a campaign</>} href={h.my.relationships || !h.my.coldContacts ? `/people?pod=&fo=${user.id}` : `${COLD_CONTACT_BASE}?owner=mine`} icon={<IconPeople size={17} />} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
        <Surface flush className="flex flex-col">
          <div className="relative flex-1 overflow-hidden bg-[#203e35] px-6 py-6 text-white">
            <div className="focus-art" aria-hidden />
            <div className="relative">
              <h2 className="flex items-baseline gap-3 text-[25px] font-medium leading-[1.25] tracking-[-0.035em]">
                <span className="text-[46px] font-semibold leading-none tracking-[-0.04em]">{h.my.overdueTotal || h.my.todayTotal || h.my.peopleDueToday}</span>
                <span>{h.my.overdueTotal ? `overdue ${h.my.overdueTotal === 1 ? 'step' : 'steps'}` : h.my.todayTotal ? `${h.my.todayTotal === 1 ? 'step' : 'steps'} due today` : 'due today'}</span>
              </h2>
              <p className="mb-5 mt-3 text-[12px] text-[#c1d4ca]">
                {h.my.overdueTotal && h.my.todayTotal ? <><span className="font-medium text-white">{h.my.todayTotal}</span> more due today across <span className="font-medium text-white">{h.my.peopleDueToday}</span> {h.my.peopleDueToday === 1 ? 'person' : 'people'}</> : null}
                {!h.my.overdueTotal && h.my.todayTotal ? <>across <span className="font-medium text-white">{h.my.peopleDueToday}</span> {h.my.peopleDueToday === 1 ? 'person' : 'people'}, <span className="font-medium text-white">{completed}</span> already done</> : null}
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
              <div className={`border-b border-line/70 bg-canvas/60 px-5 py-1.5 text-[11.5px] font-medium ${when === 'Overdue' ? 'text-red-700' : 'text-ink-500'}`}>{when}{!h.my.nextForTeam && when !== 'Coming up' ? <span className="tabular-nums"> · {when === 'Overdue' ? h.my.overdueTotal : h.my.todayTotal}</span> : null}</div>
              <ul className="divide-y divide-line/70">{rows.map((task) => <li key={task.id}><Link href={`/tasks?${task.kind === 'task' ? 'next' : 'task'}=${task.id}&mode=flow&tab=${task.due < h.today ? 'overdue' : task.due === h.today ? 'today' : 'upcoming'}&${h.my.nextForTeam ? 'fo=' : mine}`} className="flex items-center gap-3 px-5 py-2.5 transition hover:bg-brand-50/50">
                <Avatar name={task.name} shape="circle" size={32} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink-900">{task.name}</span>{when !== 'Today' ? <DueLabel due={task.due} today={h.today} /> : null}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink-700"><span className="flex shrink-0 gap-1 text-ink-500">{task.actions.map((a) => <ActionIcon key={a} action={a} size={13} />)}</span><span className="shrink-0">{task.actions.map((a) => (a === 'MEETING' ? 'Meeting' : ACTION_LABELS[a as keyof typeof ACTION_LABELS] ?? a)).join(' + ')}</span><span className="min-w-0 truncate text-ink-500">· {[task.campaign ?? (task.kind === 'task' ? null : 'No campaign'), h.my.nextForTeam && task.fo ? task.fo : task.company].filter(Boolean).join(' · ')}</span></span>
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
