import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { requireUser } from '@/lib/auth/current-user';
import { prisma } from '@/lib/db';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { getSettings } from '@/lib/settings';
import { callOutcomes } from '@/lib/engine/outcomes';
import { NEXT_STEP_LABELS } from '@/lib/sandbox/history-notes';
import { RecordFields, Surface, ViewHeader } from '@/components/ui';

/** One call as Cadence holds it: Twilio's facts, who it was with, its form and its recording. */
export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const call = await prisma.callLog.findUnique({ where: { id }, include: { form: true, user: { select: { name: true } }, person: { select: { id: true, firstName: true, lastName: true } }, sandboxContact: { select: { id: true, firstName: true, lastName: true } } } });
  if (!call) notFound();
  const settings = await getSettings();
  const outcome = call.form ? callOutcomes(settings.rules).find((o) => o.key === call.form!.outcome)?.label ?? call.form.outcome : null;
  const who = call.person ? <Link href={`/people/${call.person.id}`} className="text-brand-700 hover:underline">{`${call.person.firstName} ${call.person.lastName}`.trim()}</Link> : call.sandboxContact ? <Link href={`/sandbox/${call.sandboxContact.id}`} className="text-brand-700 hover:underline">{`${call.sandboxContact.firstName} ${call.sandboxContact.lastName}`.trim()} (sandbox)</Link> : 'Not matched';
  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    <Surface flush>
      <ViewHeader title={`${call.direction === 'OUTBOUND' ? 'Call' : 'Call received'} · ${formatInstant(call.startedAt ?? call.createdAt, user.timezone)}`} />
      <div className="p-4">
        <RecordFields items={[
          { label: 'With', value: who },
          { label: 'Rep', value: call.user?.name ?? null },
          { label: 'From', value: call.fromNumber },
          { label: 'To', value: call.toNumber },
          { label: 'Twilio status', value: call.twilioStatus },
          { label: 'Talk', value: call.talkSec ? `${Math.floor(call.talkSec / 60)}m ${call.talkSec % 60}s` : null },
          { label: 'Cost', value: call.priceUsd ? `$${Number(call.priceUsd).toFixed(3)}` : null },
          { label: 'Source', value: call.source === 'MANUAL' ? 'Logged by hand' : 'Twilio' },
        ]} />
        {call.recordingSid ? <audio controls preload="none" className="mt-4 w-full max-w-xl" src={`/api/calls/${call.id}/recording`} /> : null}
      </div>
    </Surface>
    <Surface flush>
      <ViewHeader title="Form" />
      <div className="p-4 text-[13px]">
        {call.form ? <RecordFields items={[
          { label: 'Outcome', value: outcome },
          { label: 'Rating', value: call.form.rating ? `${call.form.rating}/5` : null },
          { label: 'Next step', value: `${NEXT_STEP_LABELS[call.form.nextStep] ?? call.form.nextStep}${call.form.nextStepDate ? `, ${formatLocalDate(call.form.nextStepDate, 'long')}` : ''}` },
          { label: 'Interest', value: call.form.interest },
          { label: 'Decision maker', value: call.form.decisionMaker },
          { label: 'Products discussed', value: call.form.productsDiscussed.join(', ') || null },
          { label: 'Notes', value: call.form.notes ? <span className="whitespace-pre-wrap">{call.form.notes}</span> : null },
        ]} /> : <span className="text-ink-500">{call.formDueAt ? 'Waiting for the rep' : 'No form needed'}</span>}
      </div>
    </Surface>
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
