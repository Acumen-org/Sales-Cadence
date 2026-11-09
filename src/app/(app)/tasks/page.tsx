import { TasksScreen, type TasksSearch } from '@/components/tasks/tasks-screen';

/**
 * Tasks: CRM and cold work in one list, with no tag on the rows (cold outreach D2), so Home's links
 * always land on the item. Cold outreach no longer has a Tasks tab of its own (owner, 9 Nov 2026);
 * an old `?audience=cold` link simply opens this list.
 */
export default async function TasksPage({ searchParams }: { searchParams: Promise<TasksSearch> }) {
  return <TasksScreen sp={await searchParams} audience="all" basePath="/tasks" />;
}
