import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { mayManageForm } from '@/lib/calls/form-tools';
import { formHolderOf } from '@/lib/calls/form-holder';
import { ActionForm } from '@/components/action-form';
import { closeFormAction, handFormAction } from '@/lib/actions/call-forms';
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
  // N010: a form nobody can fill: a leader hands it on, or closes it with a reason.
  const waiting = Boolean(call.formDueAt && !call.formDoneAt && !call.form && !call.discardedAt);
  const holderId = formHolderOf(call);
  const [holder, reps, closed] = await Promise.all([
    holderId ? prisma.user.findUnique({ where: { id: holderId }, select: { name: true, active: true } }) : null,
    waiting && mayManageForm(toActor(user), call) ? prisma.user.findMany({ where: { active: true, role: { in: ['JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'] }, ...(call.podId ? { pods: { some: { podId: call.podId } } } : {}) }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [],
    call.formDoneAt && !call.form ? prisma.auditLog.findFirst({ where: { entityType: 'call', entityId: call.id, action: 'form_closed' }, orderBy: { createdAt: 'desc' }, select: { actorLabel: true, details: true } }) : null,
  ]);
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
        ]} /> : <span className="text-ink-500">{closed ? `Closed without a form by ${closed.actorLabel ?? 'a leader'}: ${(closed.details as { reason?: string } | null)?.reason ?? ''}` : waiting ? `Waiting for ${holder ? `${holder.name}${holder.active ? '' : ' (removed)'}` : 'the rep'}` : 'No form needed'}</span>}
        {reps.length ? <div className="mt-4 flex flex-wrap items-end gap-4 border-t border-line pt-4">
          <ActionForm action={handFormAction} className="flex flex-wrap items-end gap-2"><input type="hidden" name="callId" value={call.id} /><label className="block text-xs text-ink-500">Hand the form to<select name="userId" required defaultValue="" className="mt-1"><option value="" disabled>Choose a rep</option>{reps.filter((r) => r.id !== holderId).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><button type="submit" className="btn-secondary btn-sm">Hand on</button></ActionForm>
          <ActionForm action={closeFormAction} confirm="Close this call's form without one? The call stays; the reason is kept." className="flex flex-wrap items-end gap-2"><input type="hidden" name="callId" value={call.id} /><label className="block text-xs text-ink-500">Or close it without a form, because<input name="reason" required maxLength={500} className="mt-1 w-64" placeholder="Wrong number, nobody spoke" /></label><button type="submit" className="btn-ghost btn-sm">Close</button></ActionForm>
        </div> : null}
      </div>
    </Surface>
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
