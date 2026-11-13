import type { ActionType, NextActionKind, Role } from '@prisma/client';
import { databaseNow, prisma } from '../db';
import { logAudit, type AuditActor } from '../audit';
import { addDays, formatLocalDate, isLocalDate, todayIn, type LocalDate } from '../dates';
import { getSettings, type RulesSettings } from '../settings';
import { nextWorkingDay } from '../engine/clock';
import { callOutcomes, completeCall, OPT_OUT_OUTCOME, setSubjectFlags } from '../engine/outcomes';
import { exitEnrollment, markReplied } from '../engine/enrollment';
import { completeNextAction, setNextActions, stopNextAction } from '../next-actions';
import { ANSWERED_CALL_PREFIX } from '../reply-credit';
import { getTwentyClient } from '../twenty';
import { optOutSubject } from '../sandbox/opt-out';
import { addSuppressions } from '../sandbox/suppression';
import { toE164 } from '../sandbox/normalize';
import { setColdNextStep } from '../sandbox/work';
import { callNoteDraft, writeNote } from '../sandbox/history-notes';
import { coldRef, personRef, subjectHref } from '../subject';
import { audienceFor, callPodFor } from '../outreach/audience';
import { channelOfAction, contactability } from '../outreach/contactability';
import type { GuardActor } from '../outreach/guard';
import { formHolderOf, formsHeldBy } from './form-holder';
import { callStepChoices, linkData, ownerOfSubject, runningEnrollment, type CallItem } from './link';
import { talkWords, zonedInstant } from './words';
import { recordCallTouch } from './call-log';
import { formOwnerChoices } from './form-owner';
import { assignContact } from '../sandbox/contacts';

/**
 * The post-call form (plan section 10, cold outreach PLAN 4.6): after every call, and a call is
 * complete only once it is in. It says which step the call closes and closes it first (a repeating
 * next action rolls on: N054), then sets what happens next, worked out from the outcome:
 *   - not reached, in a campaign: the campaign continues, with no parallel next step (B023);
 *   - reached: the campaign ends as a reply, and a dated next step is needed;
 *   - Meeting booked: a meeting on a day, with its time (B028, B183), and Add meeting / Move to CRM after (N061);
 *   - Not interested, Wrong number, Asked not to be contacted: the Stop group (N042). An opt-out ends
 *     the campaign as Opted out, never Replied (B091);
 *   - a colleague's form suggests a step to the owner instead of replacing theirs (B027);
 *   - a contact no longer active keeps the call and the form but gets no next step, with the reason (B004).
 * One call is one touch (B043): the step it closes takes the call's own touch.
 */

type NextStep = { key: string; label: string; action: ActionType | null; kind: NextActionKind | null };

export const NEXT_STEPS: readonly NextStep[] = [
  { key: 'call_again', label: 'Call again', action: 'CALL', kind: 'ACTION' },
  { key: 'email', label: 'Email', action: 'EMAIL', kind: 'ACTION' },
  { key: 'linkedin', label: 'LinkedIn', action: 'LINKEDIN_MESSAGE', kind: 'ACTION' },
  // B183: a meeting is its own kind of next step, on a day and at a time; there is nobody to call.
  { key: 'meeting', label: 'Meeting', action: 'CALL', kind: 'MEETING' },
  { key: 'keep', label: 'Keep the current next step', action: null, kind: null },
  { key: 'campaign', label: 'The campaign continues', action: null, kind: null },
  { key: 'none', label: 'No further action', action: null, kind: null },
];
export type NextStepKey = 'call_again' | 'email' | 'linkedin' | 'meeting' | 'keep' | 'campaign' | 'none';
export const INTEREST = ['hot', 'warm', 'cold'] as const;
export const DECISION_MAKER = ['yes', 'no', 'unknown'] as const;
const dated = (key: string) => ['call_again', 'email', 'linkedin', 'meeting'].includes(key);

/** Two working days on from today, the date the next step opens on unless the rep picks another. */
export function defaultNextStepDate(today: LocalDate, workingDays: number[]): LocalDate {
  return nextWorkingDay(addDays(nextWorkingDay(addDays(today, 1), workingDays), 1), workingDays);
}

export type OutcomeGroup = 'reached' | 'not_reached' | 'stop';
/** The red Stop group (N042): each ends the outreach, so choosing one asks first. */
export const STOP_OUTCOMES = new Set(['not_interested', 'wrong_number', OPT_OUT_OUTCOME]);
/** Which of the form's three labelled groups an outcome sits in (B182). */
export function outcomeGroup(o: { key: string; answered: boolean; badPhone: boolean }): OutcomeGroup {
  if (STOP_OUTCOMES.has(o.key) || o.badPhone) return 'stop';
  return o.answered ? 'reached' : 'not_reached';
}
/** Outcomes a call with talk time cannot have had (B025): somebody picked up. */
export const SILENT_OUTCOMES = new Set(['no_answer', 'busy']);
/** A voicemail longer than this is flagged to leaders (B025). */
export const LONG_VOICEMAIL_SEC = 120;

export type CallFormInput = {
  outcome: string;
  rating?: number | null;
  notes?: string | null;
  nextStep: string;
  nextStepDate?: string | null;
  interest?: string | null;
  productsDiscussed?: string[];
  decisionMaker?: string | null;
  /** N043: what the next step is, as its next action reads. */
  what?: string | null;
  /** B183: a meeting's time, HH:MM in the rep's zone. */
  meetingTime?: string | null;
  /** What the call closes: `task:<id>`, `next:<id>`, or `none` ("Not for this step"). Absent: the step it is linked to. */
  closes?: string | null;
  /** B092: an unclaimed contact is claimed by the form's next step unless the rep unticks it. */
  claim?: boolean | null;
  /** An owned cold contact given to someone else in its pod from the form (owner, 10 Nov 2026). */
  newOwnerId?: string | null;
};
export type CallFormValue = {
  outcome: string; rating: number | null; notes: string | null; nextStep: NextStepKey; nextStepDate: string | null; interest: string | null;
  productsDiscussed: string[]; decisionMaker: string | null; what: string | null; meetingTime: string | null;
};

export type FormRulesContext = {
  rules: RulesSettings;
  today: LocalDate;
  /** The answered leg's talk time, for B025. */
  talkSec?: number | null;
  connectSeconds?: number;
  /** A running campaign holds the contact: "The campaign continues" is a choice. */
  inCampaign?: boolean;
  /** A next step is open that this call does not close: "Keep" is a choice. */
  hasOpenStep?: boolean;
  /** Nobody is matched to the call yet: no next step can be kept, whatever the outcome (B026). */
  noSubject?: boolean;
  /** B004: the person or contact can take no next step now (opted out, removed, moved, Do not contact). */
  subjectGone?: boolean;
};

export function validateCallForm(input: CallFormInput, ctx: FormRulesContext): { ok: true; value: CallFormValue } | { ok: false; error: string; field: string } {
  const outcome = callOutcomes(ctx.rules).find((o) => o.key === input.outcome);
  if (!outcome) return { ok: false, error: 'Pick the outcome of the call.', field: 'outcome' };
  // B025: a call with talk time was picked up; No answer and Busy are not what happened.
  if (SILENT_OUTCOMES.has(outcome.key) && (ctx.talkSec ?? 0) >= (ctx.connectSeconds ?? 30)) return { ok: false, error: `This call lasted ${talkWords(ctx.talkSec)}, so someone picked up. Pick Voicemail, Gatekeeper, Line connected with no conversation, or what was said.`, field: 'outcome' };
  const rating = input.rating == null || (input.rating as unknown) === '' ? null : Number(input.rating);
  const notes = input.notes?.trim() || null;
  // M46: notes too long are refused, never cut short without a word.
  if (notes && notes.length > 10_000) return { ok: false, error: `Keep the notes under 10,000 characters (they are ${notes.length.toLocaleString('en-US')}).`, field: 'notes' };
  if (outcome.answered) {
    if (rating == null || !Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'Rate the call from 1 to 5.', field: 'rating' };
    if (!notes) return { ok: false, error: 'Write what was said.', field: 'notes' };
  } else if (rating != null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) return { ok: false, error: 'A rating is from 1 to 5.', field: 'rating' };
  if (outcome.key === 'no_conversation' && !notes) return { ok: false, error: 'Say why there was no conversation.', field: 'notes' };
  const step = NEXT_STEPS.find((s) => s.key === input.nextStep);
  if (!step) return { ok: false, error: 'Pick the next step.', field: 'nextStep' };
  const group = outcomeGroup(outcome);
  if (ctx.noSubject) {
    if (step.key !== 'none') return { ok: false, error: 'Nobody is matched to this call, so no next step can be saved. Say who it was with first, or pick No further action.', field: 'nextStep' };
  } else if (ctx.subjectGone) {
    // B004: the call and form are kept whatever was said, and no next step is set (the save says so),
    // so the rules about which step follows which outcome do not apply.
  } else if (outcome.key === OPT_OUT_OUTCOME || outcome.key === 'not_interested') {
    if (step.key !== 'none') return { ok: false, error: `After "${outcome.label}" there is no next step: pick No further action.`, field: 'nextStep' };
  } else if (outcome.badPhone) {
    if (!['email', 'linkedin', 'none'].includes(step.key)) return { ok: false, error: 'The number is wrong, so only an Email, a LinkedIn message or nothing can follow.', field: 'nextStep' };
  } else if (outcome.key === 'meeting_booked') {
    // B028: a booked meeting is never "No further action".
    if (!dated(step.key)) return { ok: false, error: 'A booked meeting needs its day: pick Meeting and its date.', field: 'nextStep' };
  } else if (group === 'reached' && !dated(step.key) && step.key !== 'keep') {
    return { ok: false, error: 'They answered, so the campaign ends: set a dated next step.', field: 'nextStep' };
  }
  if (step.key === 'campaign' && !ctx.subjectGone) {
    if (!ctx.inCampaign) return { ok: false, error: 'This contact is not in a running campaign. Pick another next step.', field: 'nextStep' };
    if (group !== 'not_reached') return { ok: false, error: 'They were reached, so the campaign ends. Pick a dated next step.', field: 'nextStep' };
  }
  if (step.key === 'keep' && !ctx.hasOpenStep && !ctx.subjectGone) return { ok: false, error: 'There is no next step to keep. Pick one.', field: 'nextStep' };
  const date = input.nextStepDate?.trim() || null;
  if (dated(step.key) && !ctx.subjectGone) {
    if (!date || !isLocalDate(date)) return { ok: false, error: `Pick the day for "${step.label}".`, field: 'nextStepDate' };
    if (date < ctx.today) return { ok: false, error: 'The next step cannot be in the past.', field: 'nextStepDate' };
  }
  const meetingTime = step.key === 'meeting' ? input.meetingTime?.trim() || null : null;
  if (meetingTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(meetingTime)) return { ok: false, error: 'Give the meeting\'s time as hours and minutes, like 14:30.', field: 'meetingTime' };
  const what = input.what?.trim().replace(/\s+/g, ' ') || null;
  if (what && what.length > 200) return { ok: false, error: 'Keep the next step under 200 characters.', field: 'what' };
  if (input.interest && !(INTEREST as readonly string[]).includes(input.interest)) return { ok: false, error: 'Interest is hot, warm or cold.', field: 'interest' };
  if (input.decisionMaker && !(DECISION_MAKER as readonly string[]).includes(input.decisionMaker)) return { ok: false, error: 'Decision maker is yes, no or unknown.', field: 'decisionMaker' };
  return { ok: true, value: { outcome: outcome.key, rating: outcome.answered ? rating : null, notes, nextStep: step.key as NextStepKey, nextStepDate: dated(step.key) ? date : null, interest: input.interest || null, productsDiscussed: [...new Set(input.productsDiscussed ?? [])].slice(0, 10), decisionMaker: input.decisionMaker || null, what: dated(step.key) ? what : null, meetingTime } };
}

const pendingInclude = { person: { select: { firstName: true, lastName: true } }, sandboxContact: { select: { firstName: true, lastName: true } } } as const;

/** Calls whose form this rep must fill (their own, or handed to them: N010), oldest first. */
export async function pendingForms(userId: string) {
  return prisma.callLog.findMany({ where: formsHeldBy(userId), orderBy: { formDueAt: 'asc' }, include: pendingInclude, take: 50 });
}

/** The real number of forms this rep owes, for the notice (B088): never capped. */
export async function pendingFormCount(userId: string): Promise<number> {
  return prisma.callLog.count({ where: formsHeldBy(userId) });
}

export type SubmitResult =
  | { ok: true; message: string; reminder: string | null; /** N061: after Meeting booked, what to do next. */ followUp?: { addMeeting: string | null; moveToCrm: string | null } }
  | { ok: false; error: string; field?: string };

/** A call's subject: the CRM person once there is one, else the cold contact. */
const subjectOfCall = (call: { personId: string | null; sandboxContactId: string | null }) => ({ personId: call.personId, sandboxContactId: call.personId ? null : call.sandboxContactId });

/** The open next action a call leaves standing: one it does not close, or a repeating one it rolls on. */
async function openStepAfter(subject: { personId: string | null; sandboxContactId: string | null }, closes: CallItem | null) {
  const where = subject.personId ? { personId: subject.personId } : subject.sandboxContactId ? { sandboxContactId: subject.sandboxContactId, personId: null } : null;
  if (!where) return null;
  const open = await prisma.nextAction.findFirst({ where: { ...where, state: 'OPEN' }, select: { id: true, foUserId: true, label: true, dueDate: true, repeat: true } });
  if (!open) return null;
  if (closes?.kind === 'next' && closes.id === open.id && !closes.repeats) return null;
  return open;
}

/** Which step the form closes: the rep's choice among the call steps due, or the one the call is linked to. */
export async function resolveCloses(call: Parameters<typeof callStepChoices>[0], choice: string | null | undefined): Promise<{ ok: true; item: CallItem | null } | { ok: false; error: string }> {
  const { linked, choices } = await callStepChoices(call);
  if (choice === 'none') return { ok: true, item: null };
  if (!choice) return { ok: true, item: linked };
  const item = choices.find((i) => `${i.kind}:${i.id}` === choice);
  return item ? { ok: true, item } : { ok: false, error: 'That step is no longer open. Reload the form and pick again.' };
}

/** How the subject's next step reads after the form, for the result line: "Email 2 of Q4 Harbor on Thu 5 Nov". */
async function nextWords(subject: { personId: string | null; sandboxContactId: string | null }): Promise<string | null> {
  const running = await runningEnrollment(subject);
  const task = running?.tasks[0];
  if (task) return `${task.label} of ${running!.campaign?.name ?? running!.sequence.name} on ${formatLocalDate(task.snoozedTo ?? task.dueDate, 'long')}`;
  const where = subject.personId ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId, personId: null };
  const open = await prisma.nextAction.findFirst({ where: { ...where, state: 'OPEN' }, select: { label: true, kind: true, dueDate: true } });
  return open ? `${open.kind === 'MEETING' ? `${open.label === 'Meeting' ? 'Meeting' : `Meeting: ${open.label}`}` : open.label} on ${formatLocalDate(open.dueDate, 'long')}` : null;
}

/** B004: the form's subject can take no next step (the form offers only No further action then). */
async function subjectGone(subject: { personId: string | null; sandboxContactId: string | null }): Promise<boolean> {
  if (subject.sandboxContactId && !subject.personId) {
    const c = await prisma.sandboxContact.findUnique({ where: { id: subject.sandboxContactId }, select: { status: true } });
    return !c || c.status !== 'ACTIVE';
  }
  if (!subject.personId) return false;
  const p = await prisma.personCache.findUnique({ where: { id: subject.personId }, select: { deletedAt: true, optedOut: true, dnd: true } });
  return !p || Boolean(p.deletedAt || p.optedOut || p.dnd);
}

export async function submitCallForm(callId: string, input: CallFormInput, user: { id: string; name: string; timezone: string; role?: Role; podIds?: string[] }, now = new Date()): Promise<SubmitResult> {
  const settings = await getSettings();
  const call = await prisma.callLog.findUnique({ where: { id: callId }, include: { form: true } });
  if (!call) return { ok: false, error: 'Call not found.' };
  if (call.discardedAt) return { ok: false, error: 'This call was discarded, so it needs no form.' };
  if (formHolderOf(call) !== user.id) return { ok: false, error: call.formUserId ? 'This form was handed to someone else to fill in.' : 'Only the rep who made this call can fill in its form.' };
  // B184: a second tab, or a leader who closed it meanwhile.
  if (call.form || call.formDoneAt) return { ok: false, error: 'This call already has its form: it was saved, perhaps in another tab. Copy anything you typed that is not in it.' };
  const today = todayIn(user.timezone, now);
  const subject = subjectOfCall(call);
  const hasSubject = Boolean(subject.personId || subject.sandboxContactId);

  const closing = call.direction === 'INBOUND' ? { ok: true as const, item: null } : await resolveCloses(call, input.closes);
  if (!closing.ok) return { ok: false, error: closing.error, field: 'closes' };
  const closes = closing.item;
  const running = await runningEnrollment(subject);
  const open = await openStepAfter(subject, closes);
  // B026: with nobody to set it on, no next step can be kept; the rep says who it was first.
  const valid = validateCallForm(input, { rules: settings.rules, today, talkSec: call.talkSec, connectSeconds: settings.calling.connectSeconds, inCampaign: Boolean(running), hasOpenStep: Boolean(open), noSubject: !hasSubject, subjectGone: hasSubject && (await subjectGone(subject)) });
  if (!valid.ok) return valid;
  const v = valid.value;
  const actor: AuditActor & { id: string } = { type: 'USER', id: user.id, label: user.name };
  const guard: GuardActor | null = user.role ? { id: user.id, role: user.role, podIds: user.podIds ?? [] } : null;
  const outcome = callOutcomes(settings.rules).find((o) => o.key === v.outcome)!;
  const step = NEXT_STEPS.find((s) => s.key === v.nextStep)!;
  const stop = v.outcome === OPT_OUT_OUTCOME;

  // Owner, 10 Nov 2026: whoever fills the form may give an owned cold contact to someone in its pod,
  // within the same rules as Assign (V01): the choices are only those this user may give it to.
  const giveTo = subject.sandboxContactId && input.newOwnerId ? input.newOwnerId : null;
  if (giveTo) {
    const { choices } = await formOwnerChoices(subject.sandboxContactId!, guard);
    if (!choices.some((c) => c.id === giveTo)) return { ok: false, error: guard ? 'You cannot give this contact to that person: pick an owner from the list, or ask a leader of its pod.' : 'Pick an owner from the pod this contact is in.', field: 'newOwnerId' };
  }

  // N077: a next step the contact cannot be reached by is refused before anything is saved, so the rep picks another.
  if (step.action && step.kind !== 'MEETING' && !stop && hasSubject) {
    const check = await contactability(subject.personId ? personRef(subject.personId) : coldRef(subject.sandboxContactId!), { act: 'form_next_step', channel: channelOfAction(step.action), now });
    if (!check.ok && check.block === 'no_channel') return { ok: false, error: check.reason, field: 'nextStep' };
  }

  // What leaders look at: a long voicemail, a line picked up with nobody on it, a call to someone opted out (B025, B029).
  const subjectRow = subject.sandboxContactId ? await prisma.sandboxContact.findUnique({ where: { id: subject.sandboxContactId }, select: { status: true, optedOutAt: true, firstName: true, lastName: true, ownerId: true, owner: { select: { active: true } } } }) : null;
  const personRow = subject.personId ? await prisma.personCache.findUnique({ where: { id: subject.personId }, select: { optedOut: true, optedOutAt: true, dnd: true, firstName: true, lastName: true } }) : null;
  // M32: an opt-out counts against the call only when it came before the call did.
  const callAt = call.startedAt ?? call.createdAt;
  const before = (at: Date | null | undefined) => !at || at <= callAt;
  const flags = [
    ...(v.outcome === 'voicemail' && (call.talkSec ?? 0) >= LONG_VOICEMAIL_SEC ? ['long_voicemail'] : []),
    ...(v.outcome === 'no_conversation' ? ['no_conversation'] : []),
    ...((subjectRow?.status === 'OPTED_OUT' && before(subjectRow.optedOutAt)) || subjectRow?.status === 'REMOVED' || (personRow?.optedOut && before(personRow.optedOutAt)) || personRow?.dnd ? ['called_opted_out'] : []),
  ];
  const name = subjectRow ? `${subjectRow.firstName} ${subjectRow.lastName}`.trim() || 'This contact' : personRow ? `${personRow.firstName} ${personRow.lastName}`.trim() || 'This person' : 'They';

  // M04: "Asked not to be contacted" takes effect before anything else, so a restart or a failure part
  // way through the save can never leave the call recorded but the person still contactable.
  let stopMessage: string | null = null;
  let reminder: string | null = null;
  // The call's own touch, which the step it closes takes (B043).
  const touchId = call.touchId ?? (hasSubject ? (await recordCallTouch(call), (await prisma.callLog.findUnique({ where: { id: callId }, select: { touchId: true } }))?.touchId ?? null) : null);
  // The call step closes first, with this outcome (B023, N013); before an opt-out, which would end it otherwise.
  const closeTask = () => completeCall({ taskId: closes!.id, disposition: v.outcome, note: v.notes, callTouchId: touchId, optOut: false }, { actor, now });
  const stopClosed = stop && closes?.kind === 'task' ? await closeTask() : null;
  if (stop) {
    // Every opt-out of a CRM person sets the CRM's Do not contact and clears its Next Action (D6). The
    // campaign ends as Opted out (B091). It came from the form, so an admin can lift it (D4).
    const r = hasSubject ? await optOutSubject(subject, { source: 'call_form', actor, now, createdById: user.id, guard }) : null;
    if (r && !r.refused) {
      if (subject.personId) reminder = 'Do not contact is set on this person in the CRM too.';
      stopMessage = `Saved. ${name} is opted out: Cadence will not contact them again.`;
    } else {
      // M01: nobody to opt out (or the opt-out was refused): the number called is put on the suppression
      // list so it is never called again, and the message says exactly what was and was not done.
      const dialled = toE164(call.direction === 'INBOUND' ? call.fromNumber : call.toNumber);
      if (dialled) {
        await addSuppressions([{ kind: 'phone', value: dialled }], { reason: 'do_not_contact', source: 'call_form', createdById: user.id });
        await logAudit({ entityType: 'call', entityId: callId, action: 'suppression_added', actor, details: { kind: 'phone', source: 'call_form', refused: r?.refused ?? null } });
      }
      const why = r?.refused ? `${name} could not be opted out: ${r.refused}` : 'Nobody is matched to this call, so nobody was opted out.';
      stopMessage = `Saved, but ${why} ${dialled ? 'The number called is on the suppression list now, so Cadence will not call it again.' : 'No number was recorded for this call, so nothing was put on the suppression list.'} Say who it was with, or add them to the suppression list in Settings.`;
    }
  }

  // One form per call, even with two tabs at once (B184): the call row is claimed first.
  const form = await prisma.$transaction(async (tx) => {
    const claimed = await tx.callLog.updateMany({ where: { id: callId, formDoneAt: null, discardedAt: null }, data: { formDoneAt: now, formDueAt: call.formDueAt ?? now, ...(call.direction === 'INBOUND' ? {} : linkData(closes)) } });
    if (!claimed.count) return null;
    const audience = call.audience ?? await audienceFor(subject, tx);
    return tx.callForm.create({ data: { callId, userId: user.id, outcome: v.outcome, rating: v.rating, notes: v.notes, nextStep: v.nextStep, nextStepDate: v.nextStepDate, nextStepLabel: v.what, interest: v.interest, productsDiscussed: v.productsDiscussed, decisionMaker: v.decisionMaker, flags, submittedAt: now, audience } });
  });
  if (!form) return { ok: false, error: 'This call already has its form: it was saved, perhaps in another tab. Copy anything you typed that is not in it.' };
  if (flags.includes('long_voicemail')) await flagToLeaders(call, user, `${user.name} left a ${talkWords(call.talkSec)} voicemail for ${name}.`);

  // A CRM person's note goes to Twenty now, and stands in for the step's completion note.
  if (call.personId) {
    const draft = await callNoteDraft(callId);
    if (draft) {
      const client = await getTwentyClient().catch(() => null);
      const person = await prisma.personCache.findUnique({ where: { id: call.personId }, select: { companyId: true } });
      const taskId = closes?.kind === 'task' ? closes.id : null;
      const noteId = client ? await writeNote(client, { title: draft.title, bodyMarkdown: draft.bodyMarkdown, personId: call.personId, companyId: person?.companyId ?? null }, { taskId, callId }) : null;
      if (noteId) {
        await prisma.callForm.update({ where: { id: form.id }, data: { twentyNoteId: noteId } });
        if (taskId) await prisma.task.updateMany({ where: { id: taskId, twentyNoteId: null }, data: { twentyNoteId: noteId } });
      }
    }
  }

  // The call step closes first, with this outcome (B023, N013); a repeating next action rolls on (N054).
  let campaignEnded = false;
  if (closes?.kind === 'task') {
    const r = stopClosed ?? await closeTask();
    campaignEnded = Boolean(r.ok && (r.replied || stop));
    // M04: a step that would not close is said, never hidden behind "Saved".
    if (!r.ok) reminder = [reminder, `The call step was not closed (${r.detail ?? r.reason.replace(/_/g, ' ')}); close it from Tasks.`].filter(Boolean).join(' ');
  } else if (closes?.kind === 'next') {
    await completeNextAction(closes.id, actor, now);
  }
  if (outcome.badPhone && closes?.kind !== 'task') await setSubjectFlags(subject, { badPhone: true }, actor);
  // B043: one touch per call. An answered call is one reply; asking not to be contacted never is (B091).
  if (outcome.answered && !stop && closes?.kind !== 'task' && touchId) await prisma.touch.update({ where: { id: touchId }, data: { summary: `${ANSWERED_CALL_PREFIX} ${outcome.label}` } });
  // N013: an answered call that closed no campaign step still ends the campaign as a reply.
  if (outcome.answered && !stop && !campaignEnded && running && settings.rules.answeredCallIsReply) {
    await markReplied(running.id, { at: now, evidenceId: `call:${callId}:answered`, actor });
    campaignEnded = true;
  }

  const openWhere = subject.personId ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId, personId: null };
  if (!stop && hasSubject) {
    // The new owner first, with the contact's work (B049), so the next step below is theirs.
    let handedTo: string | null = null;
    if (giveTo && subjectRow?.ownerId && giveTo !== subjectRow.ownerId && subjectRow.status === 'ACTIVE') {
      const given = await assignContact(subject.sandboxContactId!, giveTo, actor, undefined, guard, subjectRow.ownerId);
      if (given.ok) handedTo = giveTo;
      else reminder = `The owner did not change: ${given.error}`;
    }
    const current = await openStepAfter(subject, null);
    const owner = await ownerOfSubject(subject);
    // B027: a colleague's form never replaces the owner's next step; it goes to them as a suggestion.
    // Giving the contact to someone in this form is the rep deciding, so their next step stands.
    const colleague = !handedTo && Boolean(current && current.foUserId !== user.id && owner !== user.id);
    const label = v.what ?? step.label;
    const meetingAt = step.kind === 'MEETING' && v.nextStepDate && v.meetingTime ? zonedInstant(v.nextStepDate, v.meetingTime, user.timezone) : null;
    const nextInput = step.action ? { label, action: step.action, dueDate: v.nextStepDate!, kind: step.kind ?? 'ACTION', meetingAt } : null;
    if (v.nextStep === 'keep' || v.nextStep === 'campaign') {
      // Nothing changes: the open next step stays, or the campaign holds the next touch.
    } else if (colleague && current && nextInput) {
      await suggestNextStep({ to: current.foUserId, from: user, subject, callId, what: label, how: step.action, kind: step.kind, when: v.nextStepDate });
      reminder = `${await nameOf(current.foUserId)} owns the next step (${current.label}, ${formatLocalDate(current.dueDate)}), so it was not changed. Your suggestion went to them.`;
    } else if (v.nextStep === 'none') {
      if (current && !colleague) await stopNextAction(current.id, actor, now);
    } else if (subjectRow && !subjectRow.ownerId && input.claim === false) {
      // B092: the rep chose not to claim, so the contact stays unclaimed and gets no next step.
      reminder = `${name} stays unclaimed, so no next step was set.`;
    } else if (nextInput) {
      // "Take Jane out and call again": a running campaign ends before a next step of the rep's own starts (B023).
      if (running && !campaignEnded) await exitEnrollment(running.id, { reason: 'taken_out', actor, now });
      if (subject.personId) {
        // B004: an opted-out or Do not contact person gets no next step; the call and form are saved.
        const check = await contactability(personRef(subject.personId), { act: 'form_next_step', channel: channelOfAction(step.action), now });
        if (!check.ok && check.effect === 'block') reminder = `No next step was set: ${check.reason}`;
        else await setNextActions([subject.personId], { ...nextInput, repeat: 'NONE', foUserId: owner && owner !== user.id ? owner : user.id }, actor, user.id);
      } else {
        // B004, B008, B053: a contact opted out, removed, moved or in the CRM since the call gets no
        // next step, and neither does one this rep may not work. The call and its form are saved.
        const r = await setColdNextStep(subject.sandboxContactId!, { ...nextInput, foUserId: owner && owner !== user.id ? owner : user.id }, actor, { guard: handedTo ? null : guard, act: 'form_next_step', user });
        if (!r.ok && r.code === 'not_yours' && owner) {
          await suggestNextStep({ to: owner, from: user, subject, callId, what: label, how: step.action, kind: step.kind, when: v.nextStepDate });
          reminder = `No next step was set: ${r.reason} Your suggestion went to them.`;
        } else if (!r.ok) reminder = `No next step was set: ${r.reason}`;
      }
    }
    const nextActionId = (await prisma.nextAction.findFirst({ where: { state: 'OPEN', ...openWhere }, select: { id: true } }))?.id ?? null;
    if (nextActionId) await prisma.callForm.update({ where: { id: form.id }, data: { nextActionId } });
    if (handedTo) reminder = [reminder, `${name} is ${handedTo === user.id ? 'yours' : `${await nameOf(handedTo)}'s`} now.`].filter(Boolean).join(' ');
  }
  // Bellwether shows the last outcome (contract 1.1): its 10-minute read finds the contact by statusChangedAt (B061, B062).
  if (subject.sandboxContactId) await prisma.sandboxContact.updateMany({ where: { id: subject.sandboxContactId }, data: { lastActivityAt: now, lastOutcome: v.outcome, lastOutcomeAt: now, statusChangedAt: await databaseNow() } });
  await logAudit({ entityType: 'call', entityId: callId, action: 'call_form_submitted', actor, details: { outcome: v.outcome, nextStep: v.nextStep, nextStepDate: v.nextStepDate, closes: closes ? `${closes.kind}:${closes.id}` : null, flags } });

  // The result says what happens next (B182): "Saved. Next: Email 2 of Q4 Harbor on Thu, 5 Nov 2026."
  const next = hasSubject && !stop ? await nextWords(subject) : null;
  const message = stop ? stopMessage! :v.nextStep === 'campaign' && next ? `Saved. The campaign continues: next is ${next}.` : next ? `Saved. Next: ${next}.` : 'Saved. No next step is set.';
  const followUp = v.outcome === 'meeting_booked' && hasSubject
    ? { addMeeting: subject.personId ? `/meetings/new?personId=${encodeURIComponent(subject.personId)}` : null, moveToCrm: subject.sandboxContactId ? `${subjectHref(coldRef(subject.sandboxContactId))}?move=1` : null }
    : undefined;
  return { ok: true, message, reminder, followUp };
}

const nameOf = async (userId: string) => (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? 'Someone else';

/** B027: a colleague's next step, offered to the owner instead of replacing theirs; accepted through the same checks (suggestions.ts). */
async function suggestNextStep(s: { to: string; from: { id: string; name: string }; subject: { personId: string | null; sandboxContactId: string | null }; callId: string; what: string; how: ActionType | null; kind: NextActionKind | null; when: string | null }) {
  await prisma.notification.create({ data: { userId: s.to, kind: 'next_step_suggestion', personId: s.subject.personId, sandboxContactId: s.subject.sandboxContactId, fromUserId: s.from.id, payload: { what: s.what, how: s.how, kind: s.kind ?? 'ACTION', when: s.when, callId: s.callId, from: s.from.name } } });
}

/** B025: something on a call leaders should look at goes to the leaders of the call's pod. */
async function flagToLeaders(call: { id: string; podId: string | null }, from: { id: string }, text: string) {
  if (!call.podId) return;
  const leaders = await prisma.user.findMany({ where: { active: true, role: { in: ['SALES_LEADER', 'POD_MANAGER'] }, pods: { some: { podId: call.podId } }, id: { not: from.id } }, select: { id: true } });
  if (leaders.length) await prisma.notification.createMany({ data: leaders.map((l) => ({ userId: l.id, kind: 'call_flag', fromUserId: from.id, payload: { text, callId: call.id, href: `/calls/${call.id}` } })) });
}

/** A call made off Twilio (a mobile, say): logged by hand, with the same form. */
export async function logManualCall(input: { userId: string; personId?: string | null; sandboxContactId?: string | null; taskId?: string | null; nextActionId?: string | null; startedAt?: Date; talkSec?: number | null; direction?: 'OUTBOUND' | 'INBOUND' }, now = new Date()) {
  const task = input.taskId ? await prisma.task.findUnique({ where: { id: input.taskId }, select: { enrollmentId: true, enrollment: { select: { campaignId: true } } } }) : null;
  const subject = { personId: input.personId ?? null, sandboxContactId: input.personId ? null : input.sandboxContactId ?? null };
  const startedAt = input.startedAt ?? now;
  return prisma.callLog.create({
    data: {
      source: 'MANUAL', direction: input.direction ?? 'OUTBOUND', status: 'COMPLETED', statusRank: 4, userId: input.userId, repMatchedBy: 'manual',
      ...subject, matchedBy: 'chosen',
      taskId: input.taskId ?? null, nextActionId: input.nextActionId ?? null, enrollmentId: task?.enrollmentId ?? null, campaignId: task?.enrollment.campaignId ?? null,
      startedAt, endedAt: input.talkSec ? new Date(startedAt.getTime() + input.talkSec * 1000) : startedAt, talkSec: input.talkSec ?? null, formDueAt: now,
      // Stamped once, when the call is written (PLAN 8.4): who it was with, and the pod it counts for (B040).
      audience: await audienceFor(subject), podId: await callPodFor({ enrollmentId: task?.enrollmentId ?? null, sandboxContactId: subject.sandboxContactId, userId: input.userId, personId: subject.personId }),
    },
  });
}
