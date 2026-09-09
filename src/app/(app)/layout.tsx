import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { todayIn } from '@/lib/dates';
import { tabWhere, taskScopeWhere, WORKABLE } from '@/lib/tasks-query';
import { Sidebar } from '@/components/sidebar';
import { TopBar } from '@/components/topbar';
import { unreadNotifications } from '@/lib/notifications';
import { LiveRefresh } from '@/components/live-refresh';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const e = env();
  const today = todayIn(user.timezone);
  const mine = { AND: [taskScopeWhere(user), WORKABLE, { foUserId: user.id }] };
  const [unread, todayGroups, needsReview] = await Promise.all([
    unreadNotifications(user),
    prisma.task.groupBy({ by: ['enrollmentId','stepId'], where: { AND: [mine, tabWhere('today', today)] } }),
    isAdmin(user) ? prisma.activityEvent.count({ where: { needsReview: true } }) : Promise.resolve(0),
  ]);
  const todayCount = todayGroups.length;

  return (
    <div className="flex min-h-screen bg-canvas">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Sidebar user={user} mode={e.TWENTY_MODE} dryRun={e.CADENCE_DRY_RUN} todayCount={todayCount} />
      <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
        <LiveRefresh />
        <TopBar role={user.role} unread={unread} needsReview={needsReview} />
        <div className="page-content min-w-0 flex-1">{children}</div>
      </main>
    </div>
  );
}
