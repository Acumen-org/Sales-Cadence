import { parseTaskAudience } from '@/lib/tasks-query';
import { TasksScreen, type TasksSearch } from '@/components/tasks/tasks-screen';

/**
 * Tasks: CRM and cold work in one list, with no tag on the rows (cold outreach D2), so Home's links
 * always land on the item. `?audience=cold` is Cold outreach > Tasks, the same screen filtered to
 * cold work, until the section mounts the screen at its own address.
 */
export default async function TasksPage({ searchParams }: { searchParams: Promise<TasksSearch> }) {
  const sp = await searchParams;
  return <TasksScreen sp={sp} audience={parseTaskAudience(sp.audience)} basePath="/tasks" />;
}
