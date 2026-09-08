import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { formatLocalDate } from '@/lib/dates';
import { buildHome } from '@/lib/home-query';
import { TASK_CHANNELS, type TaskChannel } from '@/lib/tasks-query';
import { ActionIcon, IconCampaigns, IconChevronRight, IconPeople } from '@/components/icons';
import { Avatar, EmptyState, Notice, Surface } from '@/components/ui';

const CHANNEL_LABELS: Record<TaskChannel, string> = { CALL: 'Calls', EMAIL: 'Emails', LINKEDIN: 'LinkedIn' };

/** One bordered tile. The whole row is a single line of tiles by design. */
function Tile({ label, value, hint, href, icon, tone }: { label: string; value: number | string; hint?: string; href: string; icon: React.ReactNode; tone?: 'warn' }) {
  return (
    <Link href={href} className="surface flex items-center gap-3 px-3.5 py-3 transition hover:border-brand-300">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-brand-50 text-brand-600">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</span>
        <span className={`block text-[22px] font-semibold leading-tight ${tone === 'warn' ? 'text-amber-600' : 'text-ink-900'}`}>{value}</span>
        {hint ? <span className="block truncate text-[11px] text-ink-400">{hint}</span> : null}
      </span>
    </Link>
  );
}

export default async function HomePage() {
  const user = await requireUser();
  const h = await buildHome(user);
  const first = user.name.split(/\s+/)[0];

  return (
    <div className="space-y-4 px-6 pb-8 pt-2">
      <h2 className="text-[17px] font-semibold text-ink-900">Good day, {first}</h2>

      {h.needsReview ? (
        <Notice tone="warn">
          {h.needsReview} inbound event{h.needsReview === 1 ? '' : 's'} need review (unknown sender or failed processing).{' '}
          <Link href="/settings?tab=activity" className="underline">
            Open the activity log
          </Link>
          .
        </Notice>
      ) : null}

      {/* One row: today's work by channel, then what this user owns. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile
          label="To reach today"
          value={h.my.peopleToReachToday}
          hint={h.my.overdueTotal ? `${h.my.overdueTotal} overdue` : 'people, not tasks'}
          href="/tasks?tab=today&mode=flow"
          icon={<IconPeople size={17} />}
          tone={h.my.overdueTotal ? 'warn' : undefined}
        />
        {TASK_CHANNELS.map((c) => (
          <Tile
            key={c}
            label={`${CHANNEL_LABELS[c]} today`}
            value={h.my.today[c]}
            hint={h.my.overdue[c] ? `${h.my.overdue[c]} overdue` : `${h.my.upcoming[c]} upcoming`}
            href={`/tasks?tab=${h.my.today[c] ? 'today' : h.my.overdue[c] ? 'overdue' : 'upcoming'}&type=${c}&mode=flow`}
            icon={<ActionIcon action={c} size={17} />}
            tone={h.my.overdue[c] ? 'warn' : undefined}
          />
        ))}
        <Tile label="My accounts" value={h.my.accounts} hint="firms I own or work" href="/accounts?scope=mine" icon={<IconCampaigns size={17} />} />
        <Tile label="My relationships" value={h.my.relationships} hint="people assigned to me" href="/people?owner=mine" icon={<IconPeople size={17} />} />
      </div>

      {h.team.length ? <TeamBoard rows={h.team} week={{ from: h.week.from, to: h.week.to }} isAdmin={isAdmin(user)} /> : null}
    </div>
  );
}

type TeamRow = { id: string; name: string; today: number; overdue: number; doneWeek: number; replies: number; meetings: number };

/**
 * The week's board. A plain grid of numbers was unreadable, so each FO gets a row with the
 * work they owe on the left, a bar for what they have actually finished, and outcomes on the
 * right. The bar is scaled to the busiest person, which is the only comparison that matters
 * when you are scanning for who needs help.
 */
function TeamBoard({ rows, week, isAdmin: admin }: { rows: TeamRow[]; week: { from: string; to: string }; isAdmin: boolean }) {
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
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink-900">{admin ? 'The team this week' : 'Your pods this week'}</h2>
        <p className="text-[11.5px] text-ink-400">
          {formatLocalDate(week.from)} - {formatLocalDate(week.to)} · {rows.length} {rows.length === 1 ? 'person' : 'people'}
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Nobody in your pods yet" />
      ) : (
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] font-medium uppercase tracking-wide text-ink-400">
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
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-800">{t.today || <span className="text-ink-300">-</span>}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {t.overdue ? <span className="font-medium text-red-600">{t.overdue}</span> : <span className="text-ink-300">-</span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="h-1.5 w-full max-w-[104px] overflow-hidden rounded-full bg-canvas">
                        <span className="block h-full rounded-full bg-brand-500 transition-[width]" style={{ width: `${Math.round((t.doneWeek / peak) * 100)}%` }} />
                      </span>
                      <span className="w-6 shrink-0 text-right tabular-nums text-ink-700">{t.doneWeek}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {t.replies ? <span className="font-medium text-emerald-700">{t.replies}</span> : <span className="text-ink-300">-</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {t.meetings ? <span className="font-medium text-brand-700">{t.meetings}</span> : <span className="text-ink-300">-</span>}
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
                <tr className="border-t border-line bg-canvas/50 text-[12.5px] font-medium text-ink-600">
                  <td className="px-4 py-2">Everyone</td>
                  <td className="px-3 py-2 text-right tabular-nums">{total.today}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{total.overdue}</td>
                  <td className="px-3 py-2 tabular-nums">{total.doneWeek} done</td>
                  <td className="px-3 py-2 text-right tabular-nums">{total.replies}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{total.meetings}</td>
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
