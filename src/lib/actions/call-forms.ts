'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canAttachCalls, canManageSettings, isAdmin, isBizOps, needsPod } from '../auth/rbac';
import { logAudit, userActor } from '../audit';
import { coldRef, personRef } from '../subject';
import { canAct, loadSubject, refuse, RefusedError, withSubjectLock } from '../outreach/guard';
import { contactability } from '../outreach/contactability';
import { audienceFor, callPodFor } from '../outreach/audience';
import { acceptSuggestion, dismissSuggestion } from '../outreach/suggestions';
import { toE164 } from '../sandbox/normalize';
import { createContact } from '../sandbox/contacts';
import { logManualCall, submitCallForm, type CallFormInput } from '../calls/form';
import { callFormContext, chooseCallContact, discardCall, searchCallContacts, type CallContactOption, type CallFormContext } from '../calls/form-context';
import { pendingFormBlock } from '../calls/gate';
import { intentStep } from '../calls/link';
import { importTwilioCalls } from '../calls/import';
import { getTwilioReader } from '../calls/twilio';
import { recordCallTouch } from '../calls/call-log';
import { zonedInstant } from '../calls/words';
import { closeFormWithoutForm, handFormTo } from '../calls/form-tools';
import type { ActionResult } from './users';

function refresh() {
  revalidatePath('/', 'layout');
}

/**
 * Cadence's Call button was pressed (N008). The check runs again here, at the click, on the server:
 * a form waiting, the contact's status and owner, an opt-out or the suppression list on any key or
 * on this exact number, "Also in CRM". Only then is the intent recorded and the
 * dialpad opened; otherwise the reason comes back for the button to show. `confirmed` answers a
 * question asked once (a number marked wrong). The step it names counts
 * only when it is a call step (N013).
 */
export async function recordCallIntentAction(input: { phone: string; taskId?: string | null; nextActionId?: string | null; personId?: string | null; sandboxContactId?: string | null; confirmed?: boolean }): Promise<ActionResult> {
  const user = await requireUser();
  const toNumber = toE164(input.phone);
  if (!toNumber) return { ok: false, error: 'That number could not be read.' };
  const ref = input.personId ? personRef(input.personId) : input.sandboxContactId ? coldRef(input.sandboxContactId) : null;
  if (ref) {
    const subject = await loadSubject(ref);
    if (!subject) return { ok: false, error: ref.kind === 'cold' ? 'This contact is no longer in Cold outreach.' : 'This person is no longer in the CRM.' };
    const verdict = canAct(toActor(user), subject, 'call');
    if (!verdict.ok) return { ok: false, error: verdict.reason };
    const check = await contactability(ref, { act: 'call', channel: 'CALL', number: toNumber, user });
    if (!check.ok) return { ok: false, error: check.reason };
    const ask = [check.confirm, check.warning].filter(Boolean).join(' ');
    if (ask && !input.confirmed) return { ok: true, message: ask, data: { confirm: true } };
  } else if (isBizOps(user)) {
    return { ok: false, error: 'Biz Ops can view calls but cannot make them from Cadence.' };
  }
  const step = await intentStep({ taskId: input.taskId ?? null, nextActionId: input.nextActionId ?? null });
  await prisma.callIntent.create({ data: { userId: user.id, toNumber, taskId: step.taskId, nextActionId: step.nextActionId, personId: input.personId ?? null, sandboxContactId: input.personId ? null : input.sandboxContactId ?? null } });
  return { ok: true };
}

/** What the post-call form shows for one call, read when it opens (PLAN 4.6). */
export async function loadCallFormAction(callId: string): Promise<{ ok: true; context: CallFormContext } | { ok: false; error: string }> {
  const user = await requireUser();
  return callFormContext(callId, user);
}

export async function submitCallFormAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const callId = String(formData.get('callId') ?? '');
  const input: CallFormInput = {
    outcome: String(formData.get('outcome') ?? ''),
    rating: formData.get('rating') ? Number(formData.get('rating')) : null,
    notes: String(formData.get('notes') ?? ''),
    nextStep: String(formData.get('nextStep') ?? ''),
    nextStepDate: String(formData.get('nextStepDate') ?? '') || null,
    interest: String(formData.get('interest') ?? '') || null,
    productsDiscussed: formData.getAll('productsDiscussed').map(String).filter(Boolean),
    decisionMaker: String(formData.get('decisionMaker') ?? '') || null,
    what: String(formData.get('what') ?? '') || null,
    meetingTime: String(formData.get('meetingTime') ?? '') || null,
    closes: formData.has('closes') ? String(formData.get('closes') ?? '') || 'none' : null,
    claim: formData.has('claimShown') ? formData.get('claim') === '1' : null,
    newOwnerId: String(formData.get('newOwnerId') ?? '') || null,
  };
  const r = await submitCallForm(callId, input, { id: user.id, name: user.name, timezone: user.timezone, role: user.role, podIds: user.podIds });
  // B184: a refused save changes nothing, so the page keeps the form and what was typed.
  if (!r.ok) return { ok: false, error: r.error };
  refresh();
  return { ok: true, message: r.reminder ? `${r.message} ${r.reminder}` : r.message, data: { followUp: r.followUp ?? null } };
}

/** B024: a call made or logged by mistake leaves every count, before its form and within a day. */
export async function discardCallAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const r = await discardCall(String(formData.get('callId') ?? ''), String(formData.get('reason') ?? ''), user, userActor(user));
  if (r.ok) refresh();
  return r;
}

/** B026: the rep says who an unmatched call was with: a CRM person or a cold contact. */
export async function chooseCallContactAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const r = await chooseCallContact(String(formData.get('callId') ?? ''), String(formData.get('contact') ?? ''), user, userActor(user));
  if (r.ok) refresh();
  return r.ok ? { ok: true, message: 'Matched.' } : r;
}

/** B026: or adds the person they spoke to as a new cold contact, with the call's number. */
export async function addCallContactAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!isAdmin(user) && !needsPod(user.role)) return { ok: false, error: 'Biz Ops can view cold contacts but cannot add them.' };
  const callId = String(formData.get('callId') ?? '');
  const call = await prisma.callLog.findUnique({ where: { id: callId }, select: { direction: true, toNumber: true, fromNumber: true, userId: true, formUserId: true } });
  if (!call) return { ok: false, error: 'Call not found.' };
  const created = await createContact({
    firstName: String(formData.get('firstName') ?? ''), lastName: String(formData.get('lastName') ?? ''), companyName: String(formData.get('companyName') ?? '') || null,
    phone: (call.direction === 'INBOUND' ? call.fromNumber : call.toNumber) ?? null, phoneType: 'unknown',
  }, { id: user.id, podIds: user.podIds, ownsContacts: needsPod(user.role) }, userActor(user), String(formData.get('podId') ?? '') || null, { source: 'CALL' });
  if (!created.ok) return created;
  const r = await chooseCallContact(callId, `sandbox:${created.id}`, user, userActor(user));
  if (r.ok) refresh();
  return r.ok ? { ok: true, message: 'Added to Cold outreach and matched.' } : r;
}

export async function searchCallContactsAction(query: string): Promise<CallContactOption[]> {
  await requireUser();
  return searchCallContacts(query);
}

/**
 * Log a call made off Twilio (a mobile, say). Nothing is saved until the dialog's Save (B024): it asks
 * when, how long, which way and which step, then the call's form opens. While another form waits, a
 * new call is not logged (B161).
 */
export async function logManualCallAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const personId = String(formData.get('personId') ?? '') || null;
  const sandboxContactId = String(formData.get('sandboxContactId') ?? '') || null;
  const closes = String(formData.get('closes') ?? '');
  if (!personId && !sandboxContactId) return { ok: false, error: 'Choose who the call was with.' };
  const waiting = await pendingFormBlock(user.id, user.timezone);
  if (waiting) return { ok: false, error: waiting };
  // The day and time as the rep typed them, in Cadence's time like every other time on the page.
  const [day, time] = String(formData.get('startedAt') ?? '').split('T');
  const startedAt = day ? zonedInstant(day, (time ?? '').slice(0, 5), user.timezone) : new Date();
  if (!startedAt) return { ok: false, error: 'Give the day and time of the call.' };
  if (startedAt.getTime() > Date.now() + 5 * 60_000) return { ok: false, error: 'A call cannot be logged ahead of time.' };
  if (Date.now() - startedAt.getTime() > 7 * 86_400_000) return { ok: false, error: 'Only calls from the last 7 days can be logged.' };
  const direction = formData.get('direction') === 'INBOUND' ? 'INBOUND' : 'OUTBOUND';
  // B008, B053: only someone who may work the contact logs a call on it, and only while it is active
  // and not "Also in CRM". An unclaimed contact is claimed by it (PLAN 8.1).
  if (sandboxContactId && !personId) {
    const r = await withSubjectLock(coldRef(sandboxContactId), toActor(user), 'log_call', async (tx) => {
      const row = (await tx.sandboxContact.findUnique({ where: { id: sandboxContactId } }))!;
      if (row.crmMatchPersonId || row.crmAutoPersonId) throw new RefusedError(refuse('in_crm', 'This person is in the CRM now, so their outreach has stopped. Move to CRM to work them there.', { label: 'Move to CRM' }));
    }, { audit: userActor(user) });
    if (!r.ok) return { ok: false, error: r.reason };
  } else if (personId) {
    const subject = await loadSubject(personRef(personId));
    if (!subject) return { ok: false, error: 'This person is no longer in the CRM.' };
    const verdict = canAct(toActor(user), subject, 'log_call');
    if (!verdict.ok) return { ok: false, error: verdict.reason };
  }
  // The step it closes, when the rep picked one: a call step only (N013). An incoming call closes none (B093).
  const [kind, id] = closes.split(':');
  const step = direction === 'OUTBOUND' && id ? await intentStep({ taskId: kind === 'task' ? id : null, nextActionId: kind === 'next' ? id : null }) : { taskId: null, nextActionId: null };
  const minutes = Number(formData.get('minutes') ?? 0);
  const call = await logManualCall({ userId: user.id, personId, sandboxContactId, taskId: step.taskId, nextActionId: step.nextActionId, startedAt, direction, talkSec: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null });
  await recordCallTouch(call);
  await logAudit({ entityType: 'call', entityId: call.id, action: 'call_logged', actor: userActor(user) });
  refresh();
  return { ok: true, message: 'Call logged. Fill in its form.', data: { callId: call.id } };
}

/** B027: the owner takes a colleague's suggested next step, through the same checks as setting one. */
export async function acceptSuggestionAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const r = await acceptSuggestion(String(formData.get('id') ?? ''), { id: user.id, role: user.role, podIds: user.podIds, name: user.name, timezone: user.timezone }, userActor(user));
  if (r.ok) refresh();
  return r;
}

export async function dismissSuggestionAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const r = await dismissSuggestion(String(formData.get('id') ?? ''), user.id);
  if (r.ok) refresh();
  return r;
}

/** The reps a call can be given to: active sales reps only (B127). */
const SALES = { active: true, role: { in: ['JUNIOR_FO', 'SENIOR_FO', 'SALES_LEADER', 'POD_MANAGER'] as ('JUNIOR_FO' | 'SENIOR_FO' | 'SALES_LEADER' | 'POD_MANAGER')[] } };

/** Unmatched list: give a call to the rep who made it. Their form opens if the call is recent enough. */
export async function assignCallRepAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAttachCalls(toActor(user))) return { ok: false, error: 'Only Senior FOs, Sales Leaders, Pod Managers and admins can attach calls.' };
  const callId = String(formData.get('callId') ?? '');
  const userId = String(formData.get('userId') ?? '');
  const rep = await prisma.user.findFirst({ where: { id: userId, ...SALES }, select: { id: true, name: true } });
  if (!rep) return { ok: false, error: 'Choose an active sales rep: only reps make calls.' };
  const call = await prisma.callLog.findUnique({ where: { id: callId } });
  if (!call) return { ok: false, error: 'Call not found.' };
  const final = call.statusRank >= 4;
  const opensForm = final && !call.formDueAt && !call.formDoneAt && Boolean(call.startedAt && Date.now() - call.startedAt.getTime() < 7 * 86_400_000);
  await prisma.callLog.update({ where: { id: callId }, data: { userId: rep.id, repMatchedBy: 'chosen', ...(opensForm ? { formDueAt: new Date() } : {}) } });
  await logAudit({ entityType: 'call', entityId: callId, action: 'rep_chosen', actor: userActor(user), details: { userId: rep.id } });
  refresh();
  return { ok: true, message: `Given to ${rep.name}.` };
}

/** Unmatched list: say who the call was with. */
export async function attachCallContactAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAttachCalls(toActor(user))) return { ok: false, error: 'Only Senior FOs, Sales Leaders, Pod Managers and admins can attach calls.' };
  const callId = String(formData.get('callId') ?? '');
  const [kind, id] = String(formData.get('contact') ?? '').split(':');
  if (!id || (kind !== 'person' && kind !== 'sandbox')) return { ok: false, error: 'Choose who the call was with.' };
  const before = await prisma.callLog.findUnique({ where: { id: callId }, select: { audience: true, podId: true, enrollmentId: true, userId: true } });
  if (!before) return { ok: false, error: 'Call not found.' };
  if (kind === 'sandbox' && !isAdmin(user)) {
    // B008: a pod leader attaches calls to contacts of their own pods (an unclaimed one, or one with no pod, too).
    const c = await prisma.sandboxContact.findUnique({ where: { id }, select: { podId: true, pod: { select: { name: true } } } });
    if (!c) return { ok: false, error: 'That contact is no longer in Cold outreach.' };
    if (c.podId && !user.podIds.includes(c.podId)) return { ok: false, error: `That contact is in ${c.pod?.name ?? 'another pod'}, which is not one of your pods.` };
  }
  await attachCallTo(callId, before, { personId: kind === 'person' ? id : null, sandboxContactId: kind === 'sandbox' ? id : null }, user);
  refresh();
  return { ok: true, message: 'Attached.' };
}

/** The call is with this person or contact: matched, stamped once (PLAN 8.4), its touch written, audited. */
async function attachCallTo(callId: string, before: { audience: string | null; podId: string | null; enrollmentId: string | null; userId: string | null }, subject: { personId: string | null; sandboxContactId: string | null }, user: Awaited<ReturnType<typeof requireUser>>) {
  // Stamped once, when the call is matched (PLAN 8.4): an unmatched call had no audience until now.
  const stamp = { ...(before.audience ? {} : { audience: await audienceFor(subject) }), ...(before.podId ? {} : { podId: await callPodFor({ enrollmentId: before.enrollmentId, sandboxContactId: subject.sandboxContactId, userId: before.userId }) }) };
  const call = await prisma.callLog.update({ where: { id: callId }, data: { ...subject, matchedBy: 'chosen', candidates: undefined, ...stamp } });
  if (call.statusRank >= 4) await recordCallTouch(call);
  await logAudit({ entityType: 'call', entityId: callId, action: 'contact_chosen', actor: userActor(user), details: subject.personId ? { kind: 'person', id: subject.personId } : { kind: 'sandbox', id: subject.sandboxContactId } });
}

/**
 * B127: Reports' Not matched yet list, a number nobody holds: the leader adds the person as a new cold
 * contact (source Call) with the call's number, and the call is attached to them. The contact is the
 * call's rep's when a sales rep made it, else unclaimed in the call's pod; the usual duplicate and
 * opt-out checks run first.
 */
export async function newColdContactFromCallAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAttachCalls(toActor(user))) return { ok: false, error: 'Only Senior FOs, Sales Leaders, Pod Managers and admins can attach calls.' };
  const callId = String(formData.get('callId') ?? '');
  const call = await prisma.callLog.findUnique({ where: { id: callId }, select: { direction: true, toNumber: true, fromNumber: true, userId: true, podId: true, audience: true, enrollmentId: true, personId: true, sandboxContactId: true } });
  if (!call) return { ok: false, error: 'Call not found.' };
  if (call.personId || call.sandboxContactId) return { ok: false, error: 'This call is already matched to someone.' };
  const rep = call.userId ? await prisma.user.findFirst({ where: { id: call.userId, ...SALES }, select: { id: true, pods: { select: { podId: true } } } }) : null;
  const podId = call.podId ?? user.podIds[0] ?? null;
  if (!isAdmin(user) && podId && !user.podIds.includes(podId)) return { ok: false, error: 'This call is in a pod that is not one of yours.' };
  const owner = rep && (!podId || rep.pods.some((p) => p.podId === podId)) ? { id: rep.id, podIds: rep.pods.map((p) => p.podId), ownsContacts: true } : { id: user.id, podIds: user.podIds, ownsContacts: false };
  const created = await createContact({
    firstName: String(formData.get('firstName') ?? ''), lastName: String(formData.get('lastName') ?? ''), companyName: String(formData.get('companyName') ?? '') || null,
    phone: (call.direction === 'INBOUND' ? call.fromNumber : call.toNumber) ?? null, phoneType: 'unknown',
  }, owner, userActor(user), podId, { source: 'CALL' });
  if (!created.ok) return created;
  await attachCallTo(callId, call, { personId: null, sandboxContactId: created.id }, user);
  refresh();
  return { ok: true, message: 'Added to Cold outreach and attached.' };
}

/** Settings > Calling: read calls from Twilio now, instead of waiting for the worker's next run. One run at a time (B166). */
export async function importCallsNowAction(): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageSettings(toActor(user))) return { ok: false, error: 'Only admins can import calls.' };
  const stats = await importTwilioCalls();
  if (stats.busy) return { ok: false, error: stats.reason ?? 'An import is already running.' };
  refresh();
  if (!stats.ran) return { ok: false, error: stats.reason ?? 'Twilio is not configured.' };
  if (stats.error) return { ok: false, error: `The import stopped: ${stats.error}` };
  return { ok: true, message: `Read ${stats.read} calls from Twilio: ${stats.created} new, ${stats.forms} forms opened, ${stats.recordings} recordings.` };
}

/**
 * Settings > Calling: the admin confirms which rep a Twilio number belongs to (User.callerNumber). It
 * counts from now: calls on it from before stay as they were (B165). A rep has one number, so a second
 * one moves them off the first, which the page asks about first and the result names (B164).
 */
export async function setCallerNumberAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!isAdmin(user)) return { ok: false, error: 'Only admins can assign numbers.' };
  const number = toE164(String(formData.get('number') ?? ''));
  const userId = String(formData.get('userId') ?? '') || null;
  if (!number) return { ok: false, error: 'That number could not be read.' };
  const reader = getTwilioReader();
  if (reader && !(await reader.listNumbers()).some((n) => toE164(n.phoneNumber) === number)) return { ok: false, error: 'That number is not on the Twilio account.' };
  const rep = userId ? await prisma.user.findFirst({ where: { id: userId, active: true, role: { not: 'BIZ_OPS' } }, select: { id: true, name: true, callerNumber: true } }) : null;
  if (userId && !rep) return { ok: false, error: 'Choose an active rep.' };
  if (rep?.callerNumber === number) return { ok: true, message: `${rep.name} has this number already.` };
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.user.updateMany({ where: { callerNumber: number }, data: { callerNumber: null, callerNumberSince: null } });
    if (rep) await tx.user.update({ where: { id: rep.id }, data: { callerNumber: number, callerNumberSince: now } });
  });
  await logAudit({ entityType: 'settings', entityId: 'calling', action: 'caller_number_set', actor: userActor(user), details: { number, userId, replaced: rep?.callerNumber ?? null } });
  refresh();
  if (!rep) return { ok: true, message: 'Number cleared.' };
  return { ok: true, message: `Assigned to ${rep.name} from now on.${rep.callerNumber ? ` ${rep.name} no longer has ${rep.callerNumber}.` : ''} Earlier calls on it keep their rep.` };
}

/** N010: a leader hands a call's waiting form to another rep (logged); the call keeps its rep. */
export async function handFormAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const callId = String(formData.get('callId') ?? '');
  const r = await handFormTo(callId, String(formData.get('userId') ?? ''), toActor(user), userActor(user));
  refresh();
  revalidatePath(`/calls/${callId}`);
  return r;
}

/** N010: a leader closes a call's form without one, with a reason (logged). */
export async function closeFormAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const callId = String(formData.get('callId') ?? '');
  const r = await closeFormWithoutForm(callId, String(formData.get('reason') ?? ''), toActor(user), userActor(user));
  refresh();
  revalidatePath(`/calls/${callId}`);
  return r;
}
