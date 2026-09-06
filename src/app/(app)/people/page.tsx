import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { cachedPersonName } from '@/lib/person-cache';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';

export default async function PeoplePage() {
  await requireUser();
  const people = await prisma.personCache.findMany({ where: { deletedAt: null }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], take: 200 });
  return (
    <>
      <PageHeader title="People" subtitle={`${people.length} people cached from Twenty.`} />
      <div className="p-6">
        <Card>
          {people.length === 0 ? (
            <EmptyState title="No people cached" hint="Run the seed (mock) or a cache refresh (Settings > Twenty) to pull people from Twenty." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Title</th>
                  <th>Pod</th>
                  <th>Where we met</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id}>
                    <td className="font-medium text-slate-900">{cachedPersonName(p)}</td>
                    <td>{p.companyName}</td>
                    <td>{p.jobTitle}</td>
                    <td>{p.podOwner}</td>
                    <td>{p.eventSource}</td>
                    <td>{p.dnd ? <Badge tone="red">DND</Badge> : null}</td>
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
