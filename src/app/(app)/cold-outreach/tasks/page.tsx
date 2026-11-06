import { requireUser } from '@/lib/auth/current-user';
import { COLD_TASKS_HREF } from '@/lib/tasks-query';
import { TasksScreen, type TasksSearch } from '@/components/tasks/tasks-screen';
import { ColdOutreachHeader } from '@/components/sandbox/section-tabs';

export const metadata = { title: 'Tasks · Cold outreach' };

/** Cold outreach > Tasks: the Tasks screen, filtered to cold work (D2). Its rows and counts are /tasks's cold rows. */
export default async function ColdTasksPage({ searchParams }: { searchParams: Promise<TasksSearch> }) {
  const user = await requireUser();
  const sp = await searchParams;
  return <TasksScreen sp={sp} audience="cold" basePath={COLD_TASKS_HREF} header={<ColdOutreachHeader user={user} current="work" />} />;
}

export const dynamic = 'force-dynamic';
