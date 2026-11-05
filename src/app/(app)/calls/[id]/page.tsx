import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { requireUser, toActor } from '@/lib/auth/current-user';
import { mayManageForm } from '@/lib/calls/form-tools';
import { formHolderOf } from '@/lib/calls/form-holder';
import { callOwnerId, HIDDEN_CALL, mayHearCall } from '@/lib/calls/access';
import { prisma } from '@/lib/db';
import { formatInstant, formatLocalDate } from '@/lib/dates';
import { getSettings } from '@/lib/settings';
import { callOutcomes } from '@/lib/engine/outcomes';
import { NEXT_STEP_LABELS } from '@/lib/sandbox/history-notes';
import { coldRef, personRef, subjectHref } from '@/lib/subject';
import { optionLabels } from '@/lib/twenty/labels';
import { Badge, Notice, RecordFields, Surface, ViewHeader } from '@/components/ui';
import { CloseFormButton, HandFormForm } from '@/components/calls/form-tools';

const FLAG_WORDS: Record<string, string> = { long_voicemail: 'Long voicemail', no_conversation: 'Line connected, no conversation', called_opted_out: 'Called someone opted out' };

/**
 * One call as Cadence holds it: Twilio's facts, who it was with, its form and its recording. Its notes,
 * numbers, cost and recording show only to the rep, the contact's owner and those who see Reports (N051).
 * Leaders can hand a waiting form on, or close it with a reason (N010).
 */
export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const call = await prisma.callLog.findUnique({ where: { id }, include: { form: true, user: { select: { name: true } }, person: { select: { id: true, firstName: true, lastName: true } }, sandboxContact: { select: { id: true, firstName: true, lastName: true } } } });
  if (!call) notFound();
  const settings = await getSettings();
  const actor = toActor(user);
  const hears = mayHearCall(actor, { userId: call.userId, formUserId: call.formUserId, ownerId: await callOwnerId(call) });
  // N010: a form nobody can fill: a leader hands it on, or closes it with a reason.
  const waiting = Boolean(call.formDueAt && !call.formDoneAt && !call.form && !call.discardedAt);
  const holderId = formHolderOf(call);
  const [holder, reps, closed] = await Promise.all([
    holderId ? prisma.user.findUnique({ where: { id: holderId }, select: { name: true, active: true } }) : null,
    waiting && mayManageForm(actor, call) ? prisma.user.findMany({ where: { active: true, role: { in: ['JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'] }, ...(call.podId ? { pods: { some: { podId: call.podId } } } : {}) }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [],
    call.formDoneAt && !call.form ? prisma.auditLog.findFirst({ where: { entityType: 'call', entityId: call.id, action: 'form_closed' }, orderBy: { createdAt: 'desc' }, select: { actorLabel: true, details: true } }) : null,
  ]);
  const outcome = call.form ? callOutcomes(settings.rules).find((o) => o.key === call.form!.outcome)?.label ?? call.form.outcome : null;
  const who = call.person ? <Link href={subjectHref(personRef(call.person.id))} className="text-brand-700 hover:underline">{`${call.person.firstName} ${call.person.lastName}`.trim()}</Link> : call.sandboxContact ? <Link href={subjectHref(coldRef(call.sandboxContact.id))} className="text-brand-700 hover:underline">{`${call.sandboxContact.firstName} ${call.sandboxContact.lastName}`.trim() || 'Removed contact'} (cold contact)</Link> : 'Not matched';
  const hidden = <span className="text-ink-500">Hidden</span>;
  return <PageFrame className="space-y-4 px-6 pb-8 pt-2">
    {call.discardedAt ? <Notice tone="warn">Discarded {formatInstant(call.discardedAt, user.timezone)}{call.discardReason ? `: ${call.discardReason}` : ''}. It counts nowhere.</Notice> : null}
    <Surface flush>
      <ViewHeader title={`${call.direction === 'OUTBOUND' ? 'Call' : 'Call received'} · ${formatInstant(call.startedAt ?? call.createdAt, user.timezone)}`} />
      <div className="p-4">
        <RecordFields items={[
          { label: 'With', value: who },
          { label: 'Rep', value: call.user?.name ?? null },
          { label: 'From', value: hears ? call.fromNumber : hidden },
          { label: 'To', value: hears ? call.toNumber : hidden },
          { label: 'Call status', value: call.twilioStatus },
          { label: 'Talk', value: call.talkSec ? `${Math.floor(call.talkSec / 60)}m ${call.talkSec % 60}s` : null },
          { label: 'Cost', value: hears ? (call.priceUsd ? `$${Number(call.priceUsd).toFixed(3)}` : null) : hidden },
          { label: 'Source', value: call.source === 'MANUAL' ? (call.twilioCallSid ? 'Logged by hand, then read from Twilio' : 'Logged by hand') : 'Twilio' },
        ]} />
        {call.recordingSid && hears ? <audio controls preload="none" className="mt-4 w-full max-w-xl" src={`/api/calls/${call.id}/recording`} /> : null}
        {/* N050: looked for until 48 hours after the call. */}
        {!call.recordingSid && call.recordingStatus === 'not_found' ? <p className="mt-3 text-[13px] text-ink-500">Recording not found: Twilio had none 48 hours after the call.</p> : null}
        {!hears ? <p className="mt-3 text-[12.5px] text-ink-500">{HIDDEN_CALL}</p> : null}
      </div>
    </Surface>
    <Surface flush>
      <ViewHeader title="Form" />
      <div className="space-y-4 p-4 text-[13px]">
        {call.form ? <>
          {call.form.flags.length ? <span className="flex flex-wrap gap-1.5">{call.form.flags.map((f) => <Badge key={f} tone="amber">{FLAG_WORDS[f] ?? f}</Badge>)}</span> : null}
          <RecordFields items={[
            { label: 'Outcome', value: outcome },
            { label: 'Rating', value: call.form.rating ? `${call.form.rating}/5` : null },
            { label: 'Next step', value: `${call.form.nextStepLabel ?? NEXT_STEP_LABELS[call.form.nextStep] ?? call.form.nextStep}${call.form.nextStepDate ? `, ${formatLocalDate(call.form.nextStepDate, 'long')}` : ''}` },
            { label: 'Interest', value: call.form.interest },
            { label: 'Decision maker', value: call.form.decisionMaker },
            { label: 'Products discussed', value: optionLabels(call.form.productsDiscussed) || null },
            { label: 'Notes', value: call.form.notes ? (hears ? <span className="whitespace-pre-wrap">{call.form.notes}</span> : hidden) : null },
          ]} />
        </> : <p className="text-ink-500">{closed ? `Closed without a form by ${closed.actorLabel ?? 'a leader'}: ${(closed.details as { reason?: string } | null)?.reason ?? ''}` : call.discardedAt ? 'Discarded, so no form.' : waiting ? `Waiting for ${holder ? `${holder.name}${holder.active ? '' : ' (removed)'}` : 'the rep'}` : 'No form needed'}</p>}
        {reps.length ? <div className="flex flex-wrap items-end gap-4 border-t border-line pt-4">
          <HandFormForm callId={call.id} reps={reps.filter((r) => r.id !== holderId)} />
          <CloseFormButton callId={call.id} holder={holder?.name ?? 'the rep'} />
        </div> : null}
      </div>
    </Surface>
  </PageFrame>;
}

export const dynamic = 'force-dynamic';
