import { redirect } from 'next/navigation';
import { TasksScreen, type TasksSearch } from '@/components/tasks/tasks-screen';
import { COLD_TASKS_HREF } from '@/lib/tasks-query';

/**
 * Tasks: CRM and cold work in one list, with no tag on the rows (cold outreach D2), so Home's links
 * always land on the item. Cold outreach > Tasks is the same screen at its own address; the
 * `?audience=cold` this page carried before the section had one goes there.
 */
export default async function TasksPage({ searchParams }: { searchParams: Promise<TasksSearch> }) {
  const sp = await searchParams;
  if (sp.audience === 'cold') {
    const rest = new URLSearchParams(Object.entries(sp).filter(([k, v]) => k !== 'audience' && typeof v === 'string') as [string, string][]).toString();
    redirect(rest ? `${COLD_TASKS_HREF}?${rest}` : COLD_TASKS_HREF);
  }
  return <TasksScreen sp={sp} audience="all" basePath="/tasks" />;
}
