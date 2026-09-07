import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { buildHome } from '@/lib/home-query';
import { TASK_CHANNELS, type TaskChannel } from '@/lib/tasks-query';
import { ActionIcon, IconBolt, IconCheck, IconClock } from '@/components/icons';
import { Avatar, Card, EmptyState, Notice, Stat, Surface } from '@/components/ui';

const CHANNEL_LABELS: Record<TaskChannel, string> = { CALL: 'Calls', EMAIL: 'Emails', LINKEDIN: 'LinkedIn' };

export default async function HomePage() {
  const user = await requireUser();
  const h = await buildHome(user);
  const first = user.name.split(/\s+/)[0];

  return (
    <div className="space-y-4 px-6 pb-8 pt-2">
      <div>
        <h2 className="text-[17px] font-semibold text-ink-900">Good day, {first}</h2>
        <p className="text-[13px] text-ink-500">
          {formatLocalDate(h.today, 'long')} · {h.my.todayTotal} due today, {h.my.overdueTotal} overdue, {h.my.active} people in your sequences
        </p>
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

      {/* Today's work, by channel */}
      <div className="grid gap-3 lg:grid-cols-3">
        {TASK_CHANNELS.map((c) => {
          const due = h.my.today[c];
          const over = h.my.overdue[c];
          return (
            <Surface key={c} flush className="transition hover:border-brand-200">
              <Link href={`/tasks?tab=${due ? 'today' : over ? 'overdue' : 'upcoming'}&type=${c}&mode=flow`} className="flex items-center gap-3.5 p-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                  <ActionIcon action={c} size={20} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] font-medium uppercase tracking-wide text-ink-400">{CHANNEL_LABELS[c]} today</span>
                  <span className="block text-[26px] font-semibold leading-tight text-ink-900">{due}</span>
                  <span className="block text-[12px] text-ink-500">
                    {over ? <span className="font-medium text-red-600">{over} overdue</span> : 'nothing overdue'} · {h.my.upcoming[c]} upcoming
                  </span>
                </span>
                <span className="btn-soft btn-sm shrink-0">Start</span>
              </Link>
            </Surface>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Done this week" value={h.my.doneThisWeek} tone="good" icon={<IconCheck size={17} />} />
        <Stat label="Replies this week" value={h.replies.length} tone="good" icon={<ActionIcon action="EMAIL" size={17} />} />
        <Stat label="Meetings this week" value={h.meetings.length} tone="good" icon={<IconBolt size={17} />} />
        <Stat label="Overdue" value={h.my.overdueTotal} tone={h.my.overdueTotal ? 'warn' : 'default'} hint={h.my.overdueTotal ? 'Work these first' : undefined} icon={<IconClock size={17} />} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {[
          { title: 'Replies this week', rows: h.replies },
          { title: 'Meetings booked this week', rows: h.meetings },
        ].map((block) => (
          <Card key={block.title} title={block.title}>
            {block.rows.length === 0 ? (
              <EmptyState title={`No ${block.title.split(' ')[0].toLowerCase()} yet this week`} />
            ) : (
              <ul className="divide-y divide-line">
                {block.rows.map((r) => (
                  <li key={r.id}>
                    <Link href={`/people/${r.personId}`} className="flex items-center gap-3 px-4 py-2.5 transition hover:bg-canvas/70">
                      <Avatar name={r.name} shape="circle" size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium text-ink-900">{r.name}</span>
                        <span className="block truncate text-[12px] text-ink-500">
                          {r.company} · {r.fo}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11.5px] text-ink-400">{formatInstant(r.at, user.timezone)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </div>

      {h.team.length ? (
        <Card title={isAdmin(user) ? 'Team today' : 'Your pods today'}>
          <table className="table">
            <thead>
              <tr>
                <th>FO</th>
                <th>Due today</th>
                <th>Overdue</th>
                <th>Done (7d)</th>
                <th>Replies (7d)</th>
                <th>Meetings (7d)</th>
                <th>In sequences</th>
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
                  <td>{t.active}</td>
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
