import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { buildHome } from '@/lib/home-query';
import { TASK_CHANNELS, type TaskChannel } from '@/lib/tasks-query';
import { ActionIcon, IconCampaigns, IconChevronRight, IconPeople } from '@/components/icons';
import { Avatar, Card, EmptyState, Notice, Surface } from '@/components/ui';

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

      {/* This week, Sunday to Saturday: the latest one, with a way into the full list. */}
      <div className="grid gap-3 lg:grid-cols-2">
        <LatestCard
          title="Replies this week"
          count={h.replies.total}
          href="/replies"
          emptyTitle="No replies yet this week"
          emptyHint="Inbound emails Twenty syncs for the people you are responsible for land here."
          weekLabel={`${formatLocalDate(h.week.from)} - ${formatLocalDate(h.week.to)}`}
          row={
            h.replies.rows[0]
              ? {
                  name: h.replies.rows[0].name,
                  sub: [h.replies.rows[0].company, h.replies.rows[0].summary].filter(Boolean).join(' · '),
                  at: formatInstant(h.replies.rows[0].at, user.timezone),
                  href: `/people/${h.replies.rows[0].personId}`,
                }
              : null
          }
        />
        <LatestCard
          title="Meetings booked this week"
          count={h.meetings.total}
          href="/meetings?scope=week"
          emptyTitle="No meetings yet this week"
          emptyHint="A meeting counts when someone outside your own domains is on it."
          weekLabel={`${formatLocalDate(h.week.from)} - ${formatLocalDate(h.week.to)}`}
          row={
            h.meetings.rows[0]
              ? {
                  name: h.meetings.rows[0].title,
                  sub: [h.meetings.rows[0].company, `${h.meetings.rows[0].externals} external`].filter(Boolean).join(' · '),
                  at: formatInstant(h.meetings.rows[0].at, user.timezone),
                  href: h.meetings.rows[0].href,
                }
              : null
          }
        />
      </div>

      {h.team.length ? (
        <Card title={isAdmin(user) ? 'Team this week' : 'Your pods this week'}>
          <table className="table">
            <thead>
              <tr>
                <th>FO</th>
                <th>Due today</th>
                <th>Overdue</th>
                <th>Done</th>
                <th>Replies</th>
                <th>Meetings</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {h.team.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={t.name} shape="circle" size={26} />
                      <span className="font-medium text-ink-900">{t.name}</span>
                    </div>
                  </td>
                  <td>{t.today}</td>
                  <td className={t.overdue ? 'font-medium text-red-600' : undefined}>{t.overdue}</td>
                  <td>{t.doneWeek}</td>
                  <td>{t.replies}</td>
                  <td>{t.meetings}</td>
                  <td className="text-right">
                    <Link href={`/tasks?tab=today&fo=${t.id}`} className="btn-ghost btn-sm">
                      View tasks
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}

/** A card showing only the latest item, with an arrow that carries the full count. */
function LatestCard({
  title,
  count,
  href,
  row,
  emptyTitle,
  emptyHint,
  weekLabel,
}: {
  title: string;
  count: number;
  href: string;
  row: { name: string; sub: string; at: string; href: string } | null;
  emptyTitle: string;
  emptyHint: string;
  weekLabel: string;
}) {
  return (
    <Surface flush>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold text-ink-900">{title}</h2>
          <p className="text-[11px] text-ink-400">{weekLabel}</p>
        </div>
        <Link href={href} className="inline-flex items-center gap-1.5 rounded-[10px] border border-line px-2.5 py-1.5 text-[12.5px] font-medium text-ink-700 transition hover:border-brand-300 hover:text-brand-700" title={`Open all ${count}`}>
          {count}
          <IconChevronRight size={15} />
        </Link>
      </div>
      {row ? (
        <Link href={row.href} className="flex items-center gap-3 px-4 py-3 transition hover:bg-canvas/70">
          <Avatar name={row.name} shape="circle" size={30} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-medium text-ink-900">{row.name}</span>
            <span className="block truncate text-[12px] text-ink-500">{row.sub}</span>
          </span>
          <span className="shrink-0 text-[11.5px] text-ink-400">{row.at}</span>
        </Link>
      ) : (
        <EmptyState title={emptyTitle} hint={emptyHint} />
      )}
    </Surface>
  );
}
