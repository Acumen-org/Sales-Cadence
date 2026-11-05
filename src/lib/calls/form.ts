import type { ActionType, Role } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { addDays, isLocalDate, todayIn, type LocalDate } from '../dates';
import { getSettings, type RulesSettings } from '../settings';
import { nextWorkingDay } from '../engine/clock';
import { callOutcomes, completeCall, setSubjectFlags } from '../engine/outcomes';
import { setNextActions, stopNextAction } from '../next-actions';
import { ANSWERED_CALL_PREFIX } from '../reply-credit';
import { getTwentyClient } from '../twenty';
import { workspaceTimezone } from '../workspace';
import { optOutSubject } from '../sandbox/opt-out';
import { setColdNextStep } from '../sandbox/work';
import { callNoteDraft, writeNote } from '../sandbox/history-notes';
import { coldRef, personRef } from '../subject';
import { audienceFor, callPodFor } from '../outreach/audience';
import { channelOfAction, contactability } from '../outreach/contactability';
import type { GuardActor } from '../outreach/guard';

/**
 * The post-call form (plan section 10): after every call, and a call is complete only once it is in.
 * The next step and its date are one field (decision 6): the date is required for every step except
 * No further action and defaults to 2 working days on.
 */

export const NEXT_STEPS = [
  { key: 'call_again', label: 'Call again', action: 'CALL' as ActionType },
  { key: 'email', label: 'Email', action: 'EMAIL' as ActionType },
  { key: 'linkedin', label: 'LinkedIn', action: 'LINKEDIN_MESSAGE' as ActionType },
  { key: 'meeting', label: 'Meeting', action: 'CALL' as ActionType },
  { key: 'none', label: 'No further action', action: null },
] as const;
export type NextStepKey = (typeof NEXT_STEPS)[number]['key'];
export const INTEREST = ['hot', 'warm', 'cold'] as const;
export const DECISION_MAKER = ['yes', 'no', 'unknown'] as const;

/** Two working days on from today, the date the next step opens on unless the rep picks another. */
export function defaultNextStepDate(today: LocalDate, workingDays: number[]): LocalDate {
  return nextWorkingDay(addDays(nextWorkingDay(addDays(today, 1), workingDays), 1), workingDays);
}

/** Outcomes that mean nothing more should happen: the form opens on No further action. */
export const ENDING_OUTCOMES = new Set(['not_interested', 'do_not_contact', 'wrong_number']);

export type CallFormInput = {
  outcome: string;
  rating?: number | null;
  notes?: string | null;
  nextStep: string;
  nextStepDate?: string | null;
  interest?: string | null;
  productsDiscussed?: string[];
  decisionMaker?: string | null;
};
export type CallFormValue = Required<Omit<CallFormInput, 'rating' | 'notes' | 'nextStepDate' | 'interest' | 'decisionMaker'>> & { rating: number | null; notes: string | null; nextStepDate: string | null; interest: string | null; decisionMaker: string | null };

export function validateCallForm(input: CallFormInput, ctx: { rules: RulesSettings; today: LocalDate }): { ok: true; value: CallFormValue } | { ok: false; error: string; field: string } {
  const outcome = callOutcomes(ctx.rules).find((o) => o.key === input.outcome);
  if (!outcome) return { ok: false, error: 'Pick the outcome of the call.', field: 'outcome' };
  const rating = input.rating == null || (input.rating as unknown) === '' ? null : Number(input.rating);
  const notes = input.notes?.trim() || null;
  if (outcome.answered) {
    if (rating == null || !Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'Rate the call from 1 to 5.', field: 'rating' };
    if (!notes) return { ok: false, error: 'Write what was said.', field: 'notes' };
  } else if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) return { ok: false, error: 'A rating is from 1 to 5.', field: 'rating' };
  const step = NEXT_STEPS.find((s) => s.key === input.nextStep);
  if (!step) return { ok: false, error: 'Pick the next step.', field: 'nextStep' };
  const date = input.nextStepDate?.trim() || null;
  if (step.key !== 'none') {
    if (!date || !isLocalDate(date)) return { ok: false, error: `Pick the day for "${step.label}".`, field: 'nextStepDate' };
    if (date < ctx.today) return { ok: false, error: 'The next step cannot be in the past.', field: 'nextStepDate' };
  }
  if (input.interest && !(INTEREST as readonly string[]).includes(input.interest)) return { ok: false, error: 'Interest is hot, warm or cold.', field: 'interest' };
  if (input.decisionMaker && !(DECISION_MAKER as readonly string[]).includes(input.decisionMaker)) return { ok: false, error: 'Decision maker is yes, no or unknown.', field: 'decisionMaker' };
  return { ok: true, value: { outcome: outcome.key, rating, notes: notes?.slice(0, 10_000) ?? null, nextStep: step.key, nextStepDate: step.key === 'none' ? null : date, interest: input.interest || null, productsDiscussed: [...new Set(input.productsDiscussed ?? [])].slice(0, 10), decisionMaker: input.decisionMaker || null } };
}

/** Calls of this rep that ended and are waiting for their form, oldest first. */
export async function pendingForms(userId: string) {
  return prisma.callLog.findMany({
    where: { userId, formDueAt: { not: null }, formDoneAt: null },
    orderBy: { formDueAt: 'asc' },
    include: { person: { select: { firstName: true, lastName: true } }, sandboxContact: { select: { firstName: true, lastName: true } } },
    take: 20,
  });
}

export type SubmitResult = { ok: true; message: string; reminder: string | null } | { ok: false; error: string; field?: string };

export async function submitCallForm(callId: string, input: CallFormInput, user: { id: string; name: string; timezone: string; role?: Role; podIds?: string[] }, now = new Date()): Promise<SubmitResult> {
  const settings = await getSettings();
  const call = await prisma.callLog.findUnique({ where: { id: callId }, include: { form: true } });
  if (!call) return { ok: false, error: 'Call not found.' };
  if (call.userId !== user.id) return { ok: false, error: 'Only the rep who made this call can fill in its form.' };
  if (call.form) return { ok: false, error: 'This call already has its form.' };
  const today = todayIn(user.timezone, now);
  const valid = validateCallForm(input, { rules: settings.rules, today });
  if (!valid.ok) return valid;
  const v = valid.value;
  const actor: AuditActor & { id: string } = { type: 'USER', id: user.id, label: user.name };
  const guard: GuardActor | null = user.role ? { id: user.id, role: user.role, podIds: user.podIds ?? [] } : null;
  const subject = { personId: call.personId, sandboxContactId: call.personId ? null : call.sandboxContactId };
  const outcome = callOutcomes(settings.rules).find((o) => o.key === v.outcome)!;
  const step = NEXT_STEPS.find((s) => s.key === v.nextStep)!;

  // N077: a next step the contact cannot be reached by is refused before anything is saved, so the rep picks another.
  if (step.action && v.outcome !== 'do_not_contact' && (subject.personId || subject.sandboxContactId)) {
    const check = await contactability(subject.personId ? personRef(subject.personId) : coldRef(subject.sandboxContactId!), { act: 'form_next_step', channel: channelOfAction(step.action), now });
    if (!check.ok && check.block === 'no_channel') return { ok: false, error: check.reason, field: 'nextStep' };
  }

  const form = await prisma.$transaction(async (tx) => {
    const audience = call.audience ?? await audienceFor(subject, tx);
    const created = await tx.callForm.create({ data: { callId, userId: user.id, outcome: v.outcome, rating: v.rating, notes: v.notes, nextStep: v.nextStep, nextStepDate: v.nextStepDate, interest: v.interest, productsDiscussed: v.productsDiscussed, decisionMaker: v.decisionMaker, submittedAt: now, audience } });
    await tx.callLog.update({ where: { id: callId }, data: { formDoneAt: now, formDueAt: call.formDueAt ?? now } });
    return created;
  });

  // A CRM person's note goes to Twenty now, and stands in for the step's completion note.
  if (call.personId) {
    const draft = await callNoteDraft(callId);
    if (draft) {
      const client = await getTwentyClient().catch(() => null);
      const person = await prisma.personCache.findUnique({ where: { id: call.personId }, select: { companyId: true } });
      const noteId = client ? await writeNote(client, { title: draft.title, bodyMarkdown: draft.bodyMarkdown, personId: call.personId, companyId: person?.companyId ?? null }, { taskId: call.taskId, callId }) : null;
      if (noteId) {
        await prisma.callForm.update({ where: { id: form.id }, data: { twentyNoteId: noteId } });
        if (call.taskId) await prisma.task.updateMany({ where: { id: call.taskId, twentyNoteId: null }, data: { twentyNoteId: noteId } });
      }
    }
  }

  // The call step it was for closes with this outcome, as Log call does.
  if (call.taskId) {
    const task = await prisma.task.findUnique({ where: { id: call.taskId }, select: { state: true, action: true, disposition: true } });
    if (task?.state === 'PENDING' && task.action === 'CALL') await completeCall({ taskId: call.taskId, disposition: v.outcome, note: v.notes }, { actor });
    else if (task && !task.disposition) await prisma.task.update({ where: { id: call.taskId }, data: { disposition: v.outcome, note: v.notes ?? undefined } });
  } else if (outcome.badPhone) {
    await setSubjectFlags(subject, { badPhone: true }, actor);
  }
  if (outcome.answered && call.touchId) await prisma.touch.update({ where: { id: call.touchId }, data: { summary: `${ANSWERED_CALL_PREFIX} ${outcome.label}` } });

  let reminder: string | null = null;
  const openWhere = subject.personId ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId, personId: null };
  if (v.outcome === 'do_not_contact' && (subject.personId || subject.sandboxContactId)) {
    // Every opt-out of a CRM person sets the CRM's Do not contact and clears its Next Action (D6).
    await optOutSubject(subject, { source: 'call_form', actor, now, createdById: user.id, guard });
    if (subject.personId) reminder = 'Do not contact is set on this person in the CRM too.';
  } else if (subject.personId || subject.sandboxContactId) {
    const open = await prisma.nextAction.findFirst({ where: { state: 'OPEN', ...openWhere }, select: { id: true, foUserId: true, label: true, dueDate: true } });
    const owner = subject.personId ? await crmOwnerOf(subject.personId) : (await prisma.sandboxContact.findUnique({ where: { id: subject.sandboxContactId! }, select: { ownerId: true } }))?.ownerId ?? null;
    // B027: a colleague's form never replaces the owner's next step; it goes to them as a suggestion.
    const colleague = Boolean(open && open.foUserId !== user.id && owner !== user.id);
    if (colleague && open) {
      await suggestNextStep({ to: open.foUserId, from: user, subject, callId, what: step.label, how: step.action, when: v.nextStepDate });
      reminder = `${await nameOf(open.foUserId)} owns the next step (${open.label}, ${open.dueDate}), so it was not changed. They were sent your suggestion.`;
    } else if (step.key === 'none') {
      if (open) await stopNextAction(open.id, actor, now);
    } else if (subject.personId) {
      // B004: an opted-out or Do not contact person gets no next step; the call and form are saved.
      const check = await contactability(personRef(subject.personId), { act: 'form_next_step', channel: channelOfAction(step.action), now });
      if (!check.ok && check.effect === 'block') reminder = `No next step was set: ${check.reason}`;
      else await setNextActions([subject.personId], { label: step.label, action: step.action!, dueDate: v.nextStepDate!, repeat: 'NONE', foUserId: owner && owner !== user.id ? owner : user.id }, actor, user.id);
    } else {
      // B004, B008, B053: a contact opted out, removed, moved or in the CRM since the call gets no
      // next step, and neither does one this rep may not work. The call and its form are saved.
      const r = await setColdNextStep(subject.sandboxContactId!, { label: step.label, action: step.action!, dueDate: v.nextStepDate!, foUserId: owner && owner !== user.id ? owner : user.id }, actor, { guard, act: 'form_next_step', user });
      if (!r.ok && r.code === 'not_yours' && owner) {
        await suggestNextStep({ to: owner, from: user, subject, callId, what: step.label, how: step.action, when: v.nextStepDate });
        reminder = `No next step was set: ${r.reason} They were sent your suggestion.`;
      } else if (!r.ok) reminder = `No next step was set: ${r.reason}`;
    }
    const nextActionId = (await prisma.nextAction.findFirst({ where: { state: 'OPEN', ...openWhere }, select: { id: true } }))?.id ?? null;
    if (nextActionId) await prisma.callForm.update({ where: { id: form.id }, data: { nextActionId } });
  }
  if (subject.sandboxContactId) await prisma.sandboxContact.updateMany({ where: { id: subject.sandboxContactId }, data: { lastActivityAt: now, lastOutcome: v.outcome, lastOutcomeAt: now } });
  await logAudit({ entityType: 'call', entityId: callId, action: 'call_form_submitted', actor, details: { outcome: v.outcome, nextStep: v.nextStep, nextStepDate: v.nextStepDate } });
  return { ok: true, message: 'Saved. The call is complete.', reminder };
}

/** The Cadence user who owns a CRM person (Twenty's Assigned To), when there is one. */
async function crmOwnerOf(personId: string): Promise<string | null> {
  const p = await prisma.personCache.findUnique({ where: { id: personId }, select: { ownerMemberId: true } });
  if (!p?.ownerMemberId) return null;
  return (await prisma.user.findFirst({ where: { twentyMemberId: p.ownerMemberId, active: true }, select: { id: true } }))?.id ?? null;
}

const nameOf = async (userId: string) => (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? 'Someone else';

/** B027: a colleague's next step, offered to the owner instead of replacing theirs (accepted through the same checks later, W4). */
async function suggestNextStep(s: { to: string; from: { id: string; name: string }; subject: { personId: string | null; sandboxContactId: string | null }; callId: string; what: string; how: ActionType | null; when: string | null }) {
  await prisma.notification.create({ data: { userId: s.to, kind: 'next_step_suggestion', personId: s.subject.personId, sandboxContactId: s.subject.sandboxContactId, fromUserId: s.from.id, payload: { what: s.what, how: s.how, when: s.when, callId: s.callId, from: s.from.name } } });
}

/** A call made off Twilio (a mobile, say): logged by hand, with the same form. */
export async function logManualCall(input: { userId: string; personId?: string | null; sandboxContactId?: string | null; taskId?: string | null; startedAt?: Date; talkSec?: number | null; direction?: 'OUTBOUND' | 'INBOUND' }, now = new Date()) {
  const task = input.taskId ? await prisma.task.findUnique({ where: { id: input.taskId }, select: { enrollmentId: true, enrollment: { select: { campaignId: true } } } }) : null;
  const subject = { personId: input.personId ?? null, sandboxContactId: input.personId ? null : input.sandboxContactId ?? null };
  return prisma.callLog.create({
    data: {
      source: 'MANUAL', direction: input.direction ?? 'OUTBOUND', status: 'COMPLETED', statusRank: 4, userId: input.userId, repMatchedBy: 'manual',
      ...subject, matchedBy: 'chosen',
      taskId: input.taskId ?? null, enrollmentId: task?.enrollmentId ?? null, campaignId: task?.enrollment.campaignId ?? null,
      startedAt: input.startedAt ?? now, endedAt: now, talkSec: input.talkSec ?? null, formDueAt: now,
      // Stamped once, when the call is written (PLAN 8.4): who it was with, and the pod it counts for (B040).
      audience: await audienceFor(subject), podId: await callPodFor({ enrollmentId: task?.enrollmentId ?? null, sandboxContactId: subject.sandboxContactId, userId: input.userId }),
    },
  });
}

/** The day the form offers for the next step. */
export async function nextStepDefault(timezone: string, now = new Date()): Promise<LocalDate> {
  const { rules } = await getSettings();
  return defaultNextStepDate(todayIn(timezone || workspaceTimezone(), now), rules.workingDays);
}
