import Link from 'next/link';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { listSequences } from '@/lib/sequences-query';
import { IconPlus, IconSequences } from '@/components/icons';
import { Badge, EmptyState, IdentityCell, StatusDot, Surface, ViewHeader } from '@/components/ui';

export default async function SequencesPage() {
  const user = await requireUser();
  const sequences = await listSequences();
  const admin = isAdmin(user);
  return (
    <div className="px-6 pb-8 pt-2">
      <Surface flush>
        <ViewHeader
          title="All sequences"
          caret
          meta={`${sequences.length} sequence${sequences.length === 1 ? '' : 's'}`}
          actions={
            admin ? (
              <Link href="/sequences/new" className="btn-secondary btn-sm">
                <IconPlus size={13} /> New sequence
              </Link>
            ) : null
          }
        />
        {sequences.length === 0 ? (
          <EmptyState icon={<IconSequences size={20} />} title="No sequences" hint="Run the seed to create the default sequence, or create one." />
        ) : (
          <div className="overflow-x-auto scroll-thin">
            <table className="table">
              <thead>
                <tr>
                  <th>Sequence</th>
                  <th>Version</th>
                  <th>Steps</th>
                  <th>Active</th>
                  <th>Replied</th>
                  <th>Meetings</th>
                  <th>Finished</th>
                  <th>Campaigns</th>
                </tr>
              </thead>
              <tbody>
                {sequences.map((s) => (
                  <tr key={s.id} className={s.archived ? 'opacity-60' : undefined}>
                    <td>
                      <div className="flex items-center gap-2">
                        <IdentityCell name={s.name} href={`/sequences/${s.id}`} sub={s.description ?? `${s.stepCount} steps over ${s.lastDay} days`} />
                        {s.archived ? <Badge tone="gray">archived</Badge> : null}
                      </div>
                    </td>
                    <td className="whitespace-nowrap">v{s.version ?? '-'}</td>
                    <td className="whitespace-nowrap text-[12.5px]">
                      {s.stepCount} steps · {s.lastDay} days
                    </td>
                    <td>
                      <StatusDot tone={s.enrollments.active + s.enrollments.paused ? 'green' : 'gray'}>{s.enrollments.active + s.enrollments.paused} Active</StatusDot>
                    </td>
                    <td>{s.enrollments.replied}</td>
                    <td>{s.enrollments.meeting}</td>
                    <td>{s.enrollments.completed}</td>
                    <td>{s.campaigns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>
    </div>
  );
}
