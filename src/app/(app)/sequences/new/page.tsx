import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/current-user';
import { canEditSequences } from '@/lib/auth/rbac';
import { createSequenceAction } from '@/lib/actions/sequences';
import { SequenceEditor } from '@/components/sequences/sequence-editor';
import { Field, PageHeader } from '@/components/ui';

export default async function NewSequencePage() {
  const user = await requireUser(); if (!canEditSequences(user)) redirect('/sequences');
  return <><PageHeader title="New sequence" /><div className="max-w-4xl px-6 pb-8 pt-2"><SequenceEditor initialSteps={[{ id: 'step-start', day: 1, actions: [{ id: 'action-start', type: 'EMAIL', label: 'Email', subject: '', template: '', bodyHtml: '<p></p>' }] }]} action={createSequenceAction} submitLabel="Create sequence" header={<div className="surface p-5"><Field label="Sequence name"><input name="name" required className="w-full !font-medium" /></Field></div>} /></div></>;
}
