import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canEditSequences } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';
import { saveSequenceAction } from '@/lib/actions/sequences';
import { parseSteps } from '@/lib/sequences/steps';
import { SequenceEditor } from '@/components/sequences/sequence-editor';
import { IconSequences } from '@/components/icons';
import { Badge, Field, RecordHeader } from '@/components/ui';

export default async function SequenceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sequence = await prisma.sequence.findUnique({ where: { id }, include: { _count: { select: { campaigns: true } } } });
  if (!sequence) notFound();
  const steps = parseSteps(sequence.steps);
  // A step somebody is standing on cannot move or change: those tasks already say something.
  const open = await prisma.task.groupBy({ by: ['stepId'], where: { state: 'PENDING', enrollment: { sequenceId: id } }, _count: { _all: true } });
  const edit = canEditSequences(user);

  return (
    <div className="space-y-5 px-6 pb-8 pt-2">
      <RecordHeader
        name={sequence.name}
        icon={<IconSequences size={20} />}
        badges={
          <Badge tone="green">
            <strong>{sequence._count.campaigns}</strong> {sequence._count.campaigns === 1 ? 'campaign' : 'campaigns'}
          </Badge>
        }
        actions={
          <Link href="/sequences" className="btn-secondary">
            All sequences
          </Link>
        }
      />
      <div className="mx-auto max-w-5xl">
        <SequenceEditor
          sequenceId={id}
          initialSteps={steps}
          action={saveSequenceAction}
          submitLabel="Save sequence"
          lockedSteps={Object.fromEntries(open.map((t) => [t.stepId, t._count._all]))}
          readOnly={!edit}
          header={
            edit ? (
              <div className="surface flex flex-wrap items-end gap-5 p-5">
                <Field label="Sequence name">
                  <input name="name" className="!w-80 max-w-full !font-semibold" defaultValue={sequence.name} required />
                </Field>
                <label className="mb-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" name="archived" defaultChecked={sequence.archived} />
                  Archived
                </label>
              </div>
            ) : null
          }
        />
      </div>
    </div>
  );
}
