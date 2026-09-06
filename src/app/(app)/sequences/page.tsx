import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { parseSteps, describeStep } from '@/lib/sequences/steps';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export default async function SequencesPage() {
  await requireUser();
  const sequences = await prisma.sequence.findMany({
    where: { archived: false },
    include: { activeVersion: true, _count: { select: { enrollments: true } } },
    orderBy: { name: 'asc' },
  });
  return (
    <>
      <PageHeader title="Sequences" subtitle="Step plans with day offsets and actions. Editing creates a new version." />
      <div className="space-y-4 p-6">
        {sequences.length === 0 ? <EmptyState title="No sequences" hint="Run the seed to create the default sequence." /> : null}
        {sequences.map((s) => {
          const steps = s.activeVersion ? parseSteps(s.activeVersion.steps) : [];
          return (
            <Card key={s.id} title={`${s.name} · v${s.activeVersion?.version ?? '-'}`}>
              <ol className="divide-y divide-slate-100">
                {steps.map((step, i) => (
                  <li key={step.id} className="flex items-center gap-4 px-4 py-2 text-sm">
                    <span className="w-14 shrink-0 text-xs font-semibold uppercase text-slate-500">Day {step.day}</span>
                    <span className="text-slate-800">
                      <span className="mr-2 text-slate-400">{i + 1}.</span>
                      {describeStep(step)}
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          );
        })}
      </div>
    </>
  );
}
