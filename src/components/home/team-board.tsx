import clsx from 'clsx';
import Link from 'next/link';
import { barColour } from '@/lib/bar-colour';
import { formatLocalDate } from '@/lib/dates';
import { weekTotal, type TeamRow } from '@/lib/home-query';
import { IconChevronRight } from '@/components/icons';
import { Avatar, Surface } from '@/components/ui';

/**
 * The board's fixed columns, in pixels, after the FO and before the chevron (B185). At 1280px, with
 * the 232px sidebar and the page's margins, what is left is the week's bar: never under 150px, so the
 * bar never runs under Done.
 */
export const TEAM_BOARD_WIDTHS = { fo: 180, done: 60, overdue: 72, today: 72, later: 92, replies: 68, meetings: 84, calls: 56, forms: 100, open: 40 } as const;

/** One figure on the board, centred and easy to read; zero is quiet so the eye lands on work. */
function Figure({ value, tone }: { value: number; tone?: 'warn' | 'good' | 'brand' | 'amber' }) {
  if (!value) return <span className="text-ink-300">0</span>;
  const colour = tone === 'warn' ? 'text-red-700' : tone === 'good' ? 'text-emerald-700' : tone === 'brand' ? 'text-brand-700' : tone === 'amber' ? 'text-amber-700' : 'text-ink-900';
  return <span className={`font-medium ${colour}`}>{value.toLocaleString('en-US')}</span>;
}

/** How far through the week an FO is: done out of done, overdue, due today and later this week. It shrinks with its column (B185). */
function WeekProgress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return <div className="min-w-0">
    <div className="mb-2 truncate text-[14px] tabular-nums text-ink-600"><span className="font-medium text-ink-900">{done.toLocaleString('en-US')}</span> of {total.toLocaleString('en-US')} done</div>
    <div className="h-2.5 overflow-hidden rounded-full bg-line" role="img" aria-label={`${pct}% of this week's tasks done`}><div className="h-full rounded-full transition-[width,background-color]" style={{ width: `${pct}%`, background: barColour(pct / 100) }} /></div>
  </div>;
}

/** How long the oldest waiting form has waited: "2 h", "3 d". */
export function waitedWords(since: Date, now = new Date()): string {
  const hours = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 3_600_000));
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/**
 * The week's board, Monday to Sunday, CRM and cold work together with no distinction (B031). Each FO
 * with anything this week is a row; a rep with nothing simply has no row (B032). The bar is their own
 * week, and the four columns after it are exactly that total, so "X of Y" can be checked at a glance.
 * Then what came back (replies; meetings held, with those booked beside them, never added), the calls
 * made, and the post-call forms still waiting, amber, with the oldest one's age (N046).
 */
export function TeamBoard({ rows, week, title, now = new Date() }: { rows: TeamRow[]; week: { from: string; to: string }; title: string; now?: Date }) {
  const total = rows.reduce(
    (a, r) => ({ done: a.done + r.done, overdue: a.overdue + r.overdue, today: a.today + r.today, later: a.later + r.later, replies: a.replies + r.replies, meetings: a.meetings + r.meetings, booked: a.booked + r.booked, calls: a.calls + r.calls, formsWaiting: a.formsWaiting + r.formsWaiting }),
    { done: 0, overdue: 0, today: 0, later: 0, replies: 0, meetings: 0, booked: 0, calls: 0, formsWaiting: 0 },
  );
  const w = TEAM_BOARD_WIDTHS;
  const head = 'whitespace-nowrap px-2 py-3 text-center font-medium';
  const cell = 'px-2 py-4 text-center text-[17px] tabular-nums';
  const figures = (r: typeof total & { oldestFormAt?: Date | null }) => <>
    <td className={cell}><Figure value={r.done} tone="good" /></td>
    <td className={cell}><Figure value={r.overdue} tone="warn" /></td>
    <td className={cell}><Figure value={r.today} /></td>
    <td className={cell}><Figure value={r.later} /></td>
    <td className={clsx(cell, 'border-l border-line/70')}><Figure value={r.replies} tone="good" /></td>
    <td className={cell}><Figure value={r.meetings} tone="brand" />{r.booked ? <span className="block text-[11px] font-normal text-ink-500">{r.booked} booked</span> : null}</td>
    <td className={cell}><Figure value={r.calls} /></td>
    <td className={cell}><Figure value={r.formsWaiting} tone="amber" />{r.formsWaiting && r.oldestFormAt ? <span className="block text-[11px] font-normal text-amber-700">oldest {waitedWords(r.oldestFormAt, now)}</span> : null}</td>
  </>;
  return (
    <Surface flush>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-4">
        <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
        <p className="text-[13px] text-ink-500">{formatLocalDate(week.from)} to {formatLocalDate(week.to)}</p>
      </div>
      <table className="w-full table-fixed border-collapse text-[15px]">
        <colgroup><col style={{ width: w.fo }} /><col /><col style={{ width: w.done }} /><col style={{ width: w.overdue }} /><col style={{ width: w.today }} /><col style={{ width: w.later }} /><col style={{ width: w.replies }} /><col style={{ width: w.meetings }} /><col style={{ width: w.calls }} /><col style={{ width: w.forms }} /><col style={{ width: w.open }} /></colgroup>
        <thead>
          <tr className="border-b border-line bg-[#fafbf9] text-[11.5px] text-ink-500">
            <th className="px-5 py-3 text-left font-medium">FO</th>
            <th className="px-3 py-3 text-left font-medium">This week</th>
            <th className={head}>Done</th>
            <th className={head}>Overdue</th>
            <th className={head}>Due today</th>
            <th className={head}>Later this week</th>
            <th className={clsx(head, 'border-l border-line/70')}>Replies</th>
            <th className={head} title="Meetings held this week; those booked are under the figure">Meetings</th>
            <th className={head} title="Calls made this week">Calls</th>
            <th className={head} title="Post-call forms waiting now, whatever the week">Forms waiting</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="group border-b border-line/70 transition last:border-b-0 hover:bg-canvas/60">
              <td className="px-5 py-4">
                <div className="flex items-center gap-3">
                  <Avatar name={t.name} shape="circle" size={34} />
                  <span className="min-w-0"><span className="block truncate text-[15px] font-medium text-ink-900">{t.name}</span>{t.pod ? <span className="mt-0.5 block truncate text-[12.5px] text-ink-500">{t.pod}</span> : null}</span>
                </div>
              </td>
              <td className="px-3 py-4">{weekTotal(t) ? <WeekProgress done={t.done} total={weekTotal(t)} /> : <span className="text-[14px] text-ink-400">Nothing planned</span>}</td>
              {figures(t)}
              <td className="px-1 py-4 text-right">
                <Link href={`/tasks?tab=${t.overdue ? 'overdue' : t.today ? 'today' : 'upcoming'}&pod=&fo=${t.id}`} aria-label={`${t.name}'s tasks`} className="inline-grid h-8 w-8 place-items-center rounded-lg text-ink-400 transition hover:bg-brand-50 hover:text-brand-700 group-hover:text-brand-700"><IconChevronRight size={16} /></Link>
              </td>
            </tr>
          ))}
          {!rows.length ? <tr><td colSpan={11} className="px-5 py-8 text-center text-[14px] text-ink-500">Nothing planned for anyone this week</td></tr> : null}
        </tbody>
        {rows.length > 1 ? (
          <tfoot>
            <tr className="border-t border-line bg-canvas/50 text-ink-700">
              <td className="px-5 py-3.5 text-[15px] font-medium">Everyone</td>
              <td className="px-3 py-3.5">{weekTotal(total) ? <WeekProgress done={total.done} total={weekTotal(total)} /> : null}</td>
              {figures(total)}
              <td />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </Surface>
  );
}
