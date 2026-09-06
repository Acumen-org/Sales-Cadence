import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { isAdmin } from '@/lib/auth/rbac';
import { createSequenceAction } from '@/lib/actions/sequences';
import { DEFAULT_SEQUENCE_STEPS } from '@/lib/sequences/default-sequence';
import { SequenceEditor } from '@/components/sequences/sequence-editor';
import { Field, PageHeader } from '@/components/ui';

export default async function NewSequencePage() {
  const user = await requireUser();
  if (!isAdmin(user)) redirect('/sequences');
  return (
    <>
      <PageHeader title="New sequence" subtitle="Starts from the default plan. Change anything, then save as version 1." />
      <div className="max-w-4xl p-6">
        <SequenceEditor
          initialSteps={DEFAULT_SEQUENCE_STEPS}
          action={createSequenceAction}
          submitLabel="Create sequence"
          header={
            <div className="card grid gap-4 p-4 md:grid-cols-2">
              <Field label="Name">
                <input name="name" required className="w-full" placeholder="Event follow-up (14 days)" />
              </Field>
              <Field label="Description (optional)">
                <input name="description" className="w-full" />
              </Field>
            </div>
          }
        />
      </div>
    </>
  );
}
