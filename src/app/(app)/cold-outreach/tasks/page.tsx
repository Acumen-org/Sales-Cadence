import { redirect } from 'next/navigation';
import type { TasksSearch } from '@/components/tasks/tasks-screen';

/**
 * Cold outreach had its own Tasks tab: the Tasks screen with only cold work. Tasks lists cold work
 * with everything else, so the tab is gone (owner, 9 Nov 2026) and old links open Tasks.
 */
export default async function ColdTasksPage({ searchParams }: { searchParams: Promise<TasksSearch> }) {
  const sp = await searchParams;
  const rest = new URLSearchParams(Object.entries(sp).filter(([k, v]) => k !== 'audience' && typeof v === 'string') as [string, string][]).toString();
  redirect(rest ? `/tasks?${rest}` : '/tasks');
}
