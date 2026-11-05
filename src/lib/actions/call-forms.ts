'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '../db';
import { requireUser, toActor } from '../auth/current-user';
import { canAttachCalls, canManageSettings, isAdmin, isBizOps } from '../auth/rbac';
import { logAudit, userActor } from '../audit';
import { coldRef, personRef } from '../subject';
import { canAct, loadSubject, refuse, RefusedError, withSubjectLock } from '../outreach/guard';
import { contactability } from '../outreach/contactability';
import { audienceFor, callPodFor } from '../outreach/audience';
import { toE164 } from '../sandbox/normalize';
import { logManualCall, submitCallForm, type CallFormInput } from '../calls/form';
import { importTwilioCalls } from '../calls/import';
import { getTwilioReader } from '../calls/twilio';
import { recordCallTouch } from '../calls/call-log';
import type { ActionResult } from './users';

function refresh() {
  revalidatePath('/', 'layout');
}

/**
 * Cadence's Call button was pressed (N008). The check runs again here, at the click, on the server:
 * a form waiting, the contact's status and owner, an opt-out or the suppression list on any key or
 * on this exact number, "Also in CRM", calling hours. Only then is the intent recorded and the
 * dialpad opened; otherwise the reason comes back for the button to show. `confirmed` answers a
 * question asked once (a number marked wrong, calling hours set to warn).
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
    if (ask && !input.confirmed) return { ok: true, message: `${ask} Call anyway?`, data: { confirm: true } };
  } else if (isBizOps(user)) {
    return { ok: false, error: 'Biz Ops can view calls but cannot make them from Cadence.' };
  }
  await prisma.callIntent.create({ data: { userId: user.id, toNumber, taskId: input.taskId ?? null, nextActionId: input.nextActionId ?? null, personId: input.personId ?? null, sandboxContactId: input.personId ? null : input.sandboxContactId ?? null } });
  return { ok: true };
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
  };
  const r = await submitCallForm(callId, input, { id: user.id, name: user.name, timezone: user.timezone, role: user.role, podIds: user.podIds });
  refresh();
  return r.ok ? { ok: true, message: r.reminder ? `${r.message} ${r.reminder}` : r.message } : { ok: false, error: r.error };
}

/** A call made off Twilio: logged by hand, and its form opens straight away. */
export async function logManualCallAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const personId = String(formData.get('personId') ?? '') || null;
  const sandboxContactId = String(formData.get('sandboxContactId') ?? '') || null;
  const taskId = String(formData.get('taskId') ?? '') || null;
  if (!personId && !sandboxContactId) return { ok: false, error: 'Choose who the call was with.' };
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
  const minutes = Number(formData.get('minutes') ?? 0);
  const call = await logManualCall({ userId: user.id, personId, sandboxContactId, taskId, talkSec: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null });
  await recordCallTouch(call);
  await logAudit({ entityType: 'call', entityId: call.id, action: 'call_logged', actor: userActor(user) });
  refresh();
  return { ok: true, message: 'Call logged. Fill in its form.', data: { callId: call.id } };
}

/** Unmatched list: give a call to the rep who made it. Their form opens if the call is recent enough. */
export async function assignCallRepAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canAttachCalls(toActor(user))) return { ok: false, error: 'Only Senior FOs, Sales Leaders, Pod Managers and admins can attach calls.' };
  const callId = String(formData.get('callId') ?? '');
  const userId = String(formData.get('userId') ?? '');
  const rep = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, active: true, name: true } });
  if (!rep?.active) return { ok: false, error: 'Choose an active rep.' };
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
  const subject = { personId: kind === 'person' ? id : null, sandboxContactId: kind === 'sandbox' ? id : null };
  // Stamped once, when the call is matched (PLAN 8.4): an unmatched call had no audience until now.
  const stamp = { ...(before.audience ? {} : { audience: await audienceFor(subject) }), ...(before.podId ? {} : { podId: await callPodFor({ enrollmentId: before.enrollmentId, sandboxContactId: subject.sandboxContactId, userId: before.userId }) }) };
  const call = await prisma.callLog.update({ where: { id: callId }, data: { ...subject, matchedBy: 'chosen', ...stamp } });
  if (call.statusRank >= 4) await recordCallTouch(call);
  await logAudit({ entityType: 'call', entityId: callId, action: 'contact_chosen', actor: userActor(user), details: { kind, id } });
  refresh();
  return { ok: true, message: 'Attached.' };
}

/** Settings > Calling: read calls from Twilio now, instead of waiting for the worker's next run. */
export async function importCallsNowAction(): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageSettings(toActor(user))) return { ok: false, error: 'Only admins can import calls.' };
  const stats = await importTwilioCalls();
  refresh();
  if (!stats.ran) return { ok: false, error: stats.reason ?? 'Twilio is not configured.' };
  if (stats.error) return { ok: false, error: `Twilio refused: ${stats.error}` };
  return { ok: true, message: `Read ${stats.read} calls from Twilio: ${stats.created} new, ${stats.forms} forms opened, ${stats.recordings} recordings.` };
}

/** Settings > Calling: the admin confirms which rep a Twilio number belongs to (User.callerNumber). */
export async function setCallerNumberAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!isAdmin(user)) return { ok: false, error: 'Only admins can assign numbers.' };
  const number = toE164(String(formData.get('number') ?? ''));
  const userId = String(formData.get('userId') ?? '') || null;
  if (!number) return { ok: false, error: 'That number could not be read.' };
  const reader = getTwilioReader();
  if (reader && !(await reader.listNumbers()).some((n) => toE164(n.phoneNumber) === number)) return { ok: false, error: 'That number is not on the Twilio account.' };
  await prisma.$transaction(async (tx) => {
    await tx.user.updateMany({ where: { callerNumber: number }, data: { callerNumber: null } });
    if (userId) await tx.user.update({ where: { id: userId }, data: { callerNumber: number } });
  });
  await logAudit({ entityType: 'settings', entityId: 'calling', action: 'caller_number_set', actor: userActor(user), details: { number, userId } });
  refresh();
  return { ok: true, message: userId ? 'Number assigned.' : 'Number cleared.' };
}
