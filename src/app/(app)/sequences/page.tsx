import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { listSequences } from '@/lib/sequences-query';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';

export default async function SequencesPage() {
  const user = await requireUser();
  const sequences = await listSequences();
  const admin = isAdmin(user);
  return (
    <>
      <PageHeader
        title="Sequences"
        subtitle="Step plans with day offsets and actions. Editing creates a new version; running enrollments pick it up at their next step."
        actions={
          admin ? (
            <Link href="/sequences/new" className="btn-primary">
              New sequence
            </Link>
          ) : null
        }
      />
      <div className="p-6">
        <Card>
          {sequences.length === 0 ? (
            <EmptyState title="No sequences" hint="Run the seed to create the default sequence, or create one." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Sequence</th>
                  <th>Version</th>
                  <th>Steps</th>
                  <th>Active</th>
                  <th>Replied</th>
                  <th>Meetings</th>
                  <th>Completed</th>
                  <th>Campaigns</th>
                </tr>
              </thead>
              <tbody>
                {sequences.map((s) => (
                  <tr key={s.id} className={s.archived ? 'opacity-60' : undefined}>
                    <td>
                      <Link href={`/sequences/${s.id}`} className="font-medium text-brand-700 hover:underline">
                        {s.name}
                      </Link>
                      {s.archived ? <Badge tone="gray" className="ml-2">archived</Badge> : null}
                      {s.description ? <div className="text-xs text-slate-500">{s.description}</div> : null}
                    </td>
                    <td>v{s.version ?? '-'}</td>
                    <td>
                      {s.stepCount} over {s.lastDay} days
                    </td>
                    <td>{s.enrollments.active + s.enrollments.paused}</td>
                    <td>{s.enrollments.replied}</td>
                    <td>{s.enrollments.meeting}</td>
                    <td>{s.enrollments.completed}</td>
                    <td>{s.campaigns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
