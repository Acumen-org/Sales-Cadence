import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { todayIn } from '@/lib/dates';
import { tabWhere, taskScopeWhere } from '@/lib/tasks-query';
import { Sidebar } from '@/components/sidebar';
import { TopBar } from '@/components/topbar';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const e = env();
  const today = todayIn(user.timezone);
  const mine = { AND: [taskScopeWhere(user), { foUserId: user.id }] };
  const [overdue, todayCount, needsReview] = await Promise.all([
    prisma.task.count({ where: { AND: [mine, tabWhere('overdue', today)] } }),
    prisma.task.count({ where: { AND: [mine, tabWhere('today', today)] } }),
    isAdmin(user) ? prisma.activityEvent.count({ where: { needsReview: true } }) : Promise.resolve(0),
  ]);

  return (
    <div className="flex min-h-screen bg-canvas">
      <Sidebar user={user} mode={e.TWENTY_MODE} dryRun={e.CADENCE_DRY_RUN} />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar role={user.role} overdue={overdue} todayCount={todayCount} needsReview={needsReview} />
        <div className="min-w-0 flex-1">{children}</div>
      </main>
    </div>
  );
}
