import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { buildHome } from '@/lib/home-query';
import { TASK_CHANNELS, type TaskChannel } from '@/lib/tasks-query';
import { ActionIcon } from '@/components/icons';
import { Card, EmptyState, Notice, PageHeader, Stat } from '@/components/ui';

const CHANNEL_LABELS: Record<TaskChannel, string> = { CALL: 'Calls', EMAIL: 'Emails', LINKEDIN: 'LinkedIn' };

export default async function HomePage() {
  const user = await requireUser();
  const h = await buildHome(user);
  const first = user.name.split(/\s+/)[0];

  return (
    <>
      <PageHeader title={`Good day, ${first}`} subtitle={`${formatLocalDate(h.today, 'long')} · ${h.my.todayTotal} tasks due today, ${h.my.overdueTotal} overdue, ${h.my.active} people in your sequences.`} />
      <div className="space-y-6 p-6">
        {h.needsReview ? (
          <Notice tone="warn">
            {h.needsReview} inbound event{h.needsReview === 1 ? '' : 's'} need review (unknown sender or failed processing).{' '}
            <Link href="/settings?tab=activity" className="underline">
              Open the activity log
            </Link>
            .
          </Notice>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-3">
          {TASK_CHANNELS.map((c) => (
            <Card key={c}>
              <div className="flex items-start justify-between p-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                    <ActionIcon action={c} size={20} />
                  </span>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-slate-500">{CHANNEL_LABELS[c]} today</div>
                    <div className="text-3xl font-semibold text-slate-900">{h.my.today[c]}</div>
                    <div className="text-xs text-slate-500">
                      {h.my.overdue[c] ? <span className="font-medium text-red-600">{h.my.overdue[c]} overdue</span> : 'nothing overdue'} · {h.my.upcoming[c]} upcoming
                    </div>
                  </div>
                </div>
                <Link href={`/tasks?tab=${h.my.today[c] ? 'today' : h.my.overdue[c] ? 'overdue' : 'upcoming'}&type=${c}&mode=flow&fo=${user.id}`} className="btn-primary btn-sm">
                  Start
                </Link>
              </div>
            </Card>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Done this week" value={h.my.doneThisWeek} tone="good" />
          <Stat label="Replies this week" value={h.replies.length} tone="good" />
          <Stat label="Meetings this week" value={h.meetings.length} tone="good" />
          <Stat label="Overdue" value={h.my.overdueTotal} tone={h.my.overdueTotal ? 'warn' : 'default'} hint={h.my.overdueTotal ? 'Work these first' : undefined} />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Replies this week">
            {h.replies.length === 0 ? (
              <EmptyState title="No replies yet this week" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {h.replies.map((r) => (
                  <li key={r.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <Link href={`/people/${r.personId}`} className="text-slate-800 hover:underline">
                      {r.name} <span className="text-slate-500">· {r.company}</span>
                    </Link>
                    <span className="text-xs text-slate-400">{formatInstant(r.at, user.timezone)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Meetings booked this week">
            {h.meetings.length === 0 ? (
              <EmptyState title="No meetings yet this week" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {h.meetings.map((r) => (
                  <li key={r.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <Link href={`/people/${r.personId}`} className="text-slate-800 hover:underline">
                      {r.name} <span className="text-slate-500">· {r.company}</span>
                    </Link>
                    <span className="text-xs text-slate-400">{formatInstant(r.at, user.timezone)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
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
                    <td className="font-medium text-slate-900">{t.name}</td>
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
    </>
  );
}
