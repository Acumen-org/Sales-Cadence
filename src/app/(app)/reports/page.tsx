import { requireUser } from '@/lib/auth/current-user';
import { EmptyState, PageHeader } from '@/components/ui';

export default async function ReportsPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Reports" subtitle="By pod, FO, campaign, sequence and channel." />
      <EmptyState title="Nothing to report yet" hint="Reports arrive in phase 5 once enrollments and tasks exist." />
    </>
  );
}
