import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin, isPodLeader } from '@/lib/auth/rbac';
import { formatLocalDate } from '@/lib/dates';
import { buildHome } from '@/lib/home-query';
import { TASK_CHANNELS, type TaskChannel } from '@/lib/tasks-query';
import { ActionIcon, IconBolt, IconCalendar, IconCheck, IconChevronRight, IconCompany, IconPeople } from '@/components/icons';
import { Avatar, EmptyState, Notice, Surface } from '@/components/ui';

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
      <span className="metric-value mt-4 block">{value}</span>
      {hint ? <span className={`mt-3 block text-[11px] ${tone === 'warn' ? 'text-amber-700' : 'text-ink-600'}`}>{hint}</span> : null}
    </Link>
  );
}

/** A number inside a sentence. Point 1: anything that moves is bold and full-contrast. */
function N({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return <strong className={tone === 'warn' ? 'font-bold text-amber-800' : 'font-bold text-ink-900'}>{children}</strong>;
}

export default async function HomePage() {
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
        <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-[11px] text-ink-600"><IconCalendar size={14} />{formatLocalDate(h.today, 'long')}</span>
      </div>

      {h.needsReview ? (
        <Notice tone="warn">
          {h.needsReview} inbound event{h.needsReview === 1 ? '' : 's'} need review (unknown sender or failed processing).{' '}
          <Link href="/settings?tab=activity" className="underline">
            Open the activity log
          </Link>
          .
        </Notice>
      ) : null}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Tile
          label="To reach today"
          value={h.my.peopleToReachToday}
          hint={h.my.overdueTotal ? <><N tone="warn">{h.my.overdueTotal}</N> overdue {h.my.overdueTotal === 1 ? 'task' : 'tasks'}</> : <><N>{h.my.todayTotal}</N> scheduled {h.my.todayTotal === 1 ? 'touch' : 'touches'}</>}
          href={`/tasks?tab=today&mode=flow&${mine}`}
          icon={<IconPeople size={17} />}
          tone={h.my.overdueTotal ? 'warn' : undefined}
        />
        <Tile label="Completed today" value={completed} hint={allToday ? <><N>{progress}%</N> of <N>{allToday}</N> done</> : undefined} href={`/tasks?tab=done&${mine}`} icon={<IconCheck size={17} />} />
        <Tile label="My accounts" value={h.my.accounts} hint={<><N>{h.my.activeAccounts}</N> with live work</>} href="/accounts?scope=mine" icon={<IconCompany size={17} />} />
        <Tile label="My relationships" value={h.my.relationships} hint={<><N>{h.my.inSequence}</N> in a sequence</>} href="/people?owner=mine" icon={<IconPeople size={17} />} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
        <Surface flush>
          <div className="relative overflow-hidden bg-[#203e35] px-6 py-6 text-white">
            <div className="focus-art" aria-hidden />
            <div className="relative">
              <p className="mb-3 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-[#d5e9ad]"><IconBolt size={12} /> {h.my.overdueTotal ? 'Overdue first' : h.my.todayTotal ? 'Due today' : 'Nothing due'}</p>
              <h2 className="flex items-baseline gap-3 text-[25px] font-medium leading-[1.25] tracking-[-0.035em]">
                <span className="text-[46px] font-semibold leading-none tracking-[-0.04em]">{h.my.overdueTotal || h.my.todayTotal || h.my.peopleToReachToday}</span>
                <span>{h.my.overdueTotal ? `overdue ${h.my.overdueTotal === 1 ? 'touch' : 'touches'}` : h.my.todayTotal ? `${h.my.todayTotal === 1 ? 'touch' : 'touches'} due today` : 'due today'}</span>
              </h2>
              <p className="mb-5 mt-3 text-[12px] text-[#c1d4ca]">
                {h.my.overdueTotal && h.my.todayTotal ? <><strong className="font-bold text-white">{h.my.todayTotal}</strong> more due today across <strong className="font-bold text-white">{h.my.peopleToReachToday}</strong> {h.my.peopleToReachToday === 1 ? 'person' : 'people'}</> : null}
                {!h.my.overdueTotal && h.my.todayTotal ? <>across <strong className="font-bold text-white">{h.my.peopleToReachToday}</strong> {h.my.peopleToReachToday === 1 ? 'person' : 'people'}, <strong className="font-bold text-white">{completed}</strong> already done</> : null}
                {!h.my.overdueTotal && !h.my.todayTotal ? <><strong className="font-bold text-white">{completed}</strong> completed today</> : null}
                {h.my.overdueTotal && !h.my.todayTotal ? <>nothing else is due today</> : null}
              </p>
              <Link href={`/tasks?tab=${focusTab}&mode=flow&${mine}`} className="inline-flex items-center gap-3 rounded-lg bg-[#d5e9ad] px-4 py-2.5 text-[12px] font-semibold text-[#203e35] transition hover:bg-[#e2f0c6]">{h.my.todayTotal || h.my.overdueTotal ? 'Start task flow' : 'View upcoming tasks'}<IconChevronRight size={15} /></Link>
            </div>
          </div>
          <div className="grid grid-cols-3 divide-x divide-line">{TASK_CHANNELS.map((c) => <Link key={c} href={`/tasks?tab=${h.my.today[c] ? 'today' : h.my.overdue[c] ? 'overdue' : 'upcoming'}&type=${c}&mode=flow&${mine}`} className="group px-3 py-4 transition hover:bg-brand-50/50 sm:px-5">
            <span className="flex items-center gap-2 text-[11px] font-medium text-ink-500"><ActionIcon action={c} size={14} />{CHANNEL_LABELS[c]} today</span><span className="mt-2 flex items-baseline gap-2"><span className="text-[25px] font-semibold tracking-tight text-ink-900">{h.my.today[c]}</span><span className="text-[11px] text-ink-600">{h.my.overdue[c] ? <><N tone="warn">{h.my.overdue[c]}</N> overdue</> : <><N>{h.my.upcoming[c]}</N> upcoming</>}</span></span>
          </Link>)}</div>
        </Surface>
        <Surface flush>
          <div className="flex items-center justify-between border-b border-line px-5 py-4"><h2 className="text-[14px] font-semibold">Up next</h2><Link href={`/tasks?tab=${focusTab}&${mine}`} className="text-[11px] font-medium text-brand-700">{h.my.todayTotal + h.my.overdueTotal ? <>View all <N>{h.my.todayTotal + h.my.overdueTotal}</N></> : 'Open tasks'} <span aria-hidden>↗</span></Link></div>
          {h.my.nextTasks.length ? <div className="divide-y divide-line/70">{h.my.nextTasks.map((task) => <Link key={task.id} href={`/tasks?task=${task.id}&mode=flow&tab=${task.due < h.today ? 'overdue' : task.due === h.today ? 'today' : 'upcoming'}&${mine}`} className="flex items-center gap-3 px-5 py-4 transition hover:bg-brand-50/50">
            <Avatar name={task.name} shape="circle" size={34} /><span className="min-w-0 flex-1"><span className="block truncate text-[12px] font-semibold">{task.name}</span><span className="mt-0.5 block truncate text-[10px] text-ink-500">{task.company ?? task.label}</span></span><span className="text-right"><span className={`block text-[9px] font-medium ${task.due < h.today ? 'text-amber-700' : 'text-ink-500'}`}>{task.due < h.today ? 'Overdue' : task.due === h.today ? 'Today' : formatLocalDate(task.due)}</span><span className="mt-1.5 flex justify-end text-ink-400"><ActionIcon action={task.action} size={13} /></span></span>
          </Link>)}</div> : <EmptyState icon={<IconCheck size={20} />} title="Nothing scheduled" />}
        </Surface>
      </div>

      {h.team.length ? <TeamBoard rows={h.team} week={{ from: h.week.from, to: h.week.to }} title={isAdmin(user) ? 'The team this week' : isPodLeader(user) ? 'Your pods this week' : 'Your week'} /> : null}
    </div>
  );
}

/**
 * One figure in the board. Zero reads as an empty cell, in the rows and in the totals alike, so
 * the eye lands only on people who actually owe work.
 */
function Figure({ value, tone }: { value: number; tone?: 'warn' | 'good' | 'brand' }) {
  if (!value) return <span className="text-ink-300">-</span>;
  const colour = tone === 'warn' ? 'text-red-700' : tone === 'good' ? 'text-emerald-700' : tone === 'brand' ? 'text-brand-700' : 'text-ink-900';
  return <span className={`font-bold ${colour}`}>{value}</span>;
}

type TeamRow = { id: string; name: string; today: number; overdue: number; doneWeek: number; replies: number; meetings: number };

/**
 * The week's board. A plain grid of numbers was unreadable, so each FO gets a row with the
 * work they owe on the left, a bar for what they have actually finished, and outcomes on the
 * right. The bar is scaled to the busiest person, which is the only comparison that matters
 * when you are scanning for who needs help.
 */
function TeamBoard({ rows, week, title }: { rows: TeamRow[]; week: { from: string; to: string }; title: string }) {
  const total = rows.reduce(
    (a, r) => ({
      today: a.today + r.today,
      overdue: a.overdue + r.overdue,
      doneWeek: a.doneWeek + r.doneWeek,
      replies: a.replies + r.replies,
      meetings: a.meetings + r.meetings,
    }),
    { today: 0, overdue: 0, doneWeek: 0, replies: 0, meetings: 0 },
  );
  const peak = Math.max(1, ...rows.map((r) => r.doneWeek));

  return (
    <Surface flush>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-5">
        <h2 className="text-[14px] font-semibold text-ink-900">{title}</h2>
        <p className="text-[11.5px] font-semibold text-ink-700">
          {formatLocalDate(week.from)} to {formatLocalDate(week.to)}
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Nobody in your pods yet" />
      ) : (
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line bg-[#fafbf9] text-[10px] font-medium uppercase tracking-[0.07em] text-ink-500">
                {/* Explicit widths: the name column absorbs the slack so the figures stay together. */}
                <th className="px-4 py-2 text-left font-medium">Person</th>
                <th className="w-[92px] px-3 py-2 text-right font-medium">Due today</th>
                <th className="w-[84px] px-3 py-2 text-right font-medium">Overdue</th>
                <th className="w-[172px] px-3 py-2 text-left font-medium">Done this week</th>
                <th className="w-[78px] px-3 py-2 text-right font-medium">Replies</th>
                <th className="w-[88px] px-3 py-2 text-right font-medium">Meetings</th>
                <th className="w-[92px] px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="group border-b border-line/70 transition last:border-b-0 hover:bg-canvas/60">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={t.name} shape="circle" size={28} />
                      <span className="truncate font-medium text-ink-900">{t.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums"><Figure value={t.today} /></td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <Figure value={t.overdue} tone="warn" />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="h-1.5 w-full max-w-[104px] overflow-hidden rounded-full bg-line">
                        <span className="block h-full rounded-full bg-brand-500 transition-[width]" style={{ width: `${Math.round((t.doneWeek / peak) * 100)}%` }} />
                      </span>
                      <span className="w-6 shrink-0 text-right tabular-nums"><Figure value={t.doneWeek} /></span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <Figure value={t.replies} tone="good" />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <Figure value={t.meetings} tone="brand" />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Link
                      href={`/tasks?tab=today&fo=${t.id}`}
                      className="inline-flex items-center gap-0.5 whitespace-nowrap text-[12.5px] font-medium text-ink-400 transition group-hover:text-brand-700"
                    >
                      Tasks <IconChevronRight size={14} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
            {rows.length > 1 ? (
              <tfoot>
                <tr className="border-t border-line bg-canvas/50 text-[12.5px] text-ink-700">
                  <td className="px-4 py-2 font-medium">Everyone</td>
                  <td className="px-3 py-2 text-right tabular-nums"><Figure value={total.today} /></td>
                  <td className="px-3 py-2 text-right tabular-nums"><Figure value={total.overdue} tone="warn" /></td>
                  <td className="px-3 py-2 tabular-nums"><span className="flex items-center gap-2.5"><span className="w-full max-w-[104px]" /><span className="w-6 shrink-0 text-right"><Figure value={total.doneWeek} /></span></span></td>
                  <td className="px-3 py-2 text-right tabular-nums"><Figure value={total.replies} tone="good" /></td>
                  <td className="px-3 py-2 text-right tabular-nums"><Figure value={total.meetings} tone="brand" /></td>
                  <td />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}
    </Surface>
  );
}
