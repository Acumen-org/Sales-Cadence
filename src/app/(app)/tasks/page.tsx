import { requireUser } from '@/lib/auth/current-user';
import { EmptyState, PageHeader } from '@/components/ui';

export default async function TasksPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Tasks" subtitle="Who you touch today, and on which channel." />
      <EmptyState title="No tasks yet" hint="Enrol people in a campaign and their first-day tasks will appear here. The task flow arrives in phase 3." />
    </>
  );
}
