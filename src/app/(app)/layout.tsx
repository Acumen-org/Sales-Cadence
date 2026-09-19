import { FilterNavigationProvider } from '@/components/filter-navigation';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { todayIn } from '@/lib/dates';
import { taskScopeWhere, WORKABLE } from '@/lib/tasks-query';
import { Sidebar } from '@/components/sidebar';
import { TopBar } from '@/components/topbar';
import { unreadNotifications } from '@/lib/notifications';
import { LiveRefresh } from '@/components/live-refresh';
import { workspaceTimezone } from '@/lib/workspace';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const e = env();
  const today = todayIn(user.timezone);
  const mine = { AND: [taskScopeWhere(user), WORKABLE, { foUserId: user.id }] };
  // One read for the badge counts: every open touchpoint of mine up to today, bucketed here. The
  // layout runs on every navigation, so each query it saves is felt on every click.
  const [unread, openGroups, needsReview] = await Promise.all([
    unreadNotifications(user),
    prisma.task.findMany({ where: { AND: [mine, { state: 'PENDING' }, { OR: [{ snoozedTo: null, dueDate: { lte: today } }, { snoozedTo: { not: null, lte: today } }] }] }, select: { enrollmentId: true, stepId: true, dueDate: true, snoozedTo: true } }),
    isAdmin(user) ? prisma.activityEvent.count({ where: { needsReview: true } }) : Promise.resolve(0),
  ]);
  const todayGroups = new Set<string>();
  const overdueGroups = new Set<string>();
  for (const t of openGroups) ((t.snoozedTo ?? t.dueDate) === today ? todayGroups : overdueGroups).add(`${t.enrollmentId}:${t.stepId}`);
  const todayCount = todayGroups.size;
  const overdueCount = overdueGroups.size;

  return (
    <FilterNavigationProvider><div className="flex min-h-screen bg-canvas">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Sidebar user={user} mode={e.TWENTY_MODE} dryRun={e.CADENCE_DRY_RUN} todayCount={todayCount} overdueCount={overdueCount} />
      <main id="main-content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
        <LiveRefresh />
        <TopBar role={user.role} unread={unread} needsReview={needsReview} timezone={workspaceTimezone()} />
        <div className="page-content min-w-0 flex-1">{children}</div>
      </main>
    </div></FilterNavigationProvider>
  );
}
