import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { formatInstant, formatLocalDate, todayIn, weekRange } from '@/lib/dates';
import { repliesThisWeek } from '@/lib/home-query';
import { ActionIcon } from '@/components/icons';
import { EmptyState, IdentityCell, Surface, ViewHeader } from '@/components/ui';

/** Every reply to deal with this week: the full view behind Home's "Replies this week" tile. */
export default async function RepliesPage() {
  const user = await requireUser();
  const today = todayIn(user.timezone);
  const week = weekRange(today, user.timezone);
  const { rows, total } = await repliesThisWeek(user, week, 200);

  return (
    <div className="px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader
          title="Replies this week"
          caret
          meta={`${total} reply${total === 1 ? '' : 'ies'} · ${formatLocalDate(week.from, 'long')} to ${formatLocalDate(week.to, 'long')}`}
          actions={
            <Link href="/home" className="btn-ghost btn-sm">
              Back to Home
            </Link>
          }
        />
        {rows.length === 0 ? (
          <EmptyState
            icon={<ActionIcon action="EMAIL" size={20} />}
            title="No replies this week"
            hint="Inbound emails that Twenty syncs for the people you are responsible for appear here, newest first."
          />
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Reply</th>
                  <th>FO</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <IdentityCell name={r.name} href={`/people/${r.personId}`} shape="circle" size={28} sub={r.company} />
                    </td>
                    <td className="text-[13px] text-ink-700">{r.summary}</td>
                    <td className="whitespace-nowrap text-[12.5px]">{r.foName ?? <span className="text-ink-300">-</span>}</td>
                    <td className="whitespace-nowrap text-[12px] text-ink-500">{formatInstant(r.at, user.timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>
    </div>
  );
}
