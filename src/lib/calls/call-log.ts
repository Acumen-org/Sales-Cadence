import type { CallLog, CallStatus, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { toE164 } from '../sandbox/normalize';
import type { TwilioCall } from './twilio';
import { identityOf, matchContact, matchRep } from './match';
import { intentStep, linkData, stepByRule } from './link';
import { audienceFor, callPodFor } from '../outreach/audience';
import { isUniqueViolation } from '../engine/tasks';
import { logAudit, SYSTEM_ACTOR } from '../audit';
import { notify, podLeaders } from '../notifications';
import { findSuppressed, maskValue } from '../sandbox/suppression';

/**
 * One call read from Twilio, stored once and kept up to date: its status only moves forward, the
 * rep and contact are matched once, and an ended call of a matched rep opens their post-call form.
 * One call is one record (N014): a call the rep already logged by hand (Log a call), or recorded with
 * the CRM's quick Log call on its step, is joined to that record, with no second form, note or touch.
 * The step it closes follows PLAN 8.7 (link.ts). An incoming call opens a form only when it was
 * answered (B093), and a call older than a week opens none (N049).
 */

export const STATUS_OF: Record<string, CallStatus> = {
  queued: 'QUEUED', initiated: 'INITIATED', ringing: 'RINGING', 'in-progress': 'IN_PROGRESS', completed: 'COMPLETED', busy: 'BUSY', 'no-answer': 'NO_ANSWER', failed: 'FAILED', canceled: 'CANCELED',
};
export const RANK: Record<CallStatus, number> = { QUEUED: 0, INITIATED: 1, RINGING: 2, IN_PROGRESS: 3, COMPLETED: 4, BUSY: 4, NO_ANSWER: 4, FAILED: 4, CANCELED: 4 };
export const isFinal = (s: CallStatus) => RANK[s] === 4;

/** A leg with a browser or SIP end is the dialpad's own leg, not the conversation. */
export const hasClientEnd = (c: Pick<TwilioCall, 'from' | 'to'>) => /^(client|sip):/i.test(c.from) || /^(client|sip):/i.test(c.to);

export type RepUser = { id: string; callerNumber: string | null; callerNumberSince?: Date | null; aliases: string[] };
export type UpsertContext = { users: RepUser[]; formsFrom: Date; now: Date };

const INTENT_WINDOW_MS = 30 * 60_000;
/** How far apart a hand-logged call and Twilio's record of it may start and still be one call (N014). */
const JOIN_WINDOW_MS = 60 * 60_000;
/** Catch-up after an outage opens forms only for calls this recent (N049). */
export const FORM_CATCH_UP_MS = 7 * 86_400_000;

/** The newest unclaimed press of Call to this number before the call started: the task it was for. */
async function findIntent(number: string | null, startedAt: Date | null, userId: string | null) {
  if (!number || !startedAt) return null;
  const window = { gte: new Date(startedAt.getTime() - INTENT_WINDOW_MS), lte: new Date(startedAt.getTime() + 2 * 60_000) };
  if (userId) return prisma.callIntent.findFirst({ where: { userId, toNumber: number, callId: null, createdAt: window }, orderBy: { createdAt: 'desc' } });
  const intents = await prisma.callIntent.findMany({ where: { toNumber: number, callId: null, createdAt: window }, orderBy: { createdAt: 'desc' }, take: 5 });
  const reps = new Set(intents.map((i) => i.userId));
  return reps.size === 1 ? intents[0] : null;
}

/** A call the rep already logged by hand, with the same person, close in time: the import joins it (N014). */
async function loggedByHand(userId: string | null, subject: { personId: string | null; sandboxContactId: string | null }, startedAt: Date | null, other: string | null) {
  // M45: a call to a firm's main line has nobody matched; the hand log of someone at that number is it.
  const who: Prisma.CallLogWhereInput | null = subject.personId ? { personId: subject.personId } : subject.sandboxContactId ? { sandboxContactId: subject.sandboxContactId }
    : other?.startsWith('+') ? { OR: [{ sandboxContact: { OR: [{ phone: other }, { companyPhone: other }] } }, { person: { OR: [{ phoneE164: other }, { additionalPhoneE164: other }] } }] } : null;
  if (!userId || !startedAt || !who) return null;
  return prisma.callLog.findFirst({
    // M09: a call is logged by hand after it was made, so a log written before this call began is another call.
    where: { source: 'MANUAL', twilioCallSid: null, userId, discardedAt: null, ...who, startedAt: { gte: new Date(startedAt.getTime() - JOIN_WINDOW_MS), lte: new Date(startedAt.getTime() + JOIN_WINDOW_MS) }, createdAt: { gte: new Date(startedAt.getTime() - 60_000) } },
    orderBy: { startedAt: 'desc' },
  });
}

/**
 * The CRM's quick Log call on a call step, done by the same rep for the same person close in time,
 * with no call record of its own yet (N014): the import becomes that step's call, already filed.
 */
async function loggedOnStep(userId: string | null, personId: string | null, startedAt: Date | null, endedAt: Date | null, intentTaskId: string | null) {
  if (!userId || !personId || !startedAt) return null;
  const from = new Date(startedAt.getTime() - 15 * 60_000);
  const to = new Date((endedAt ?? startedAt).getTime() + 2 * JOIN_WINDOW_MS);
  const task = await prisma.task.findFirst({
    where: { ...(intentTaskId ? { id: intentTaskId } : {}), action: 'CALL', state: 'DONE', disposition: { not: null }, completedById: userId, completedAt: { gte: from, lte: to }, enrollment: { personId } },
    orderBy: { completedAt: 'desc' },
    select: { id: true, completedAt: true, enrollmentId: true, enrollment: { select: { campaignId: true } } },
  });
  if (!task || (await prisma.callLog.count({ where: { taskId: task.id } }))) return null;
  const touch = await prisma.touch.findUnique({ where: { externalId: `task:${task.id}` }, select: { id: true } });
  if (touch && (await prisma.callLog.count({ where: { touchId: touch.id } }))) return null;
  return { task, touchId: touch?.id ?? null };
}

export async function upsertImportedCall(leg: TwilioCall, parent: TwilioCall | null, ctx: UpsertContext, clientLegs?: TwilioCall[]): Promise<{ call: CallLog; created: boolean; formOpened: boolean; joined?: 'logged_call' | 'log_call_step' }> {
  const status = STATUS_OF[leg.status] ?? 'QUEUED';
  const direction = leg.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND';
  const fromNumber = toE164(leg.from) ?? (leg.from || null);
  const toNumber = toE164(leg.to) ?? (leg.to || null);
  // M11, M12: an incoming call rung through to the dialpad was answered only if a browser leg was, and
  // that leg names the rep; the incoming leg alone reads "completed" even when nobody picked up.
  const answeredLeg = clientLegs?.length ? clientLegs.find((c) => c.status === 'completed' && (c.durationSec ?? 0) > 0) ?? null : undefined;
  const repIdentity = identityOf(leg.from, leg.to, parent?.from, parent?.to, answeredLeg?.from, answeredLeg?.to, ...(clientLegs ?? []).flatMap((c) => [c.from, c.to]));
  const startedAt = leg.startTime ? new Date(leg.startTime) : null;
  const endedAt = leg.endTime ? new Date(leg.endTime) : null;
  const other = direction === 'OUTBOUND' ? toNumber : fromNumber;
  let existing = await prisma.callLog.findUnique({ where: { twilioCallSid: leg.sid } });
  const wasFinal = Boolean(existing && existing.statusRank >= 4);

  // Talk time is the leg to the phone network, from when it was answered: the dialpad's own leg, which
  // rings first, is never counted (B025, PLAN 8.7).
  const facts: Prisma.CallLogUncheckedUpdateInput = { twilioStatus: leg.status, importedAt: ctx.now, parentCallSid: leg.parentCallSid ?? parent?.sid ?? null, repIdentity };
  if (!existing || RANK[status] >= existing.statusRank) {
    const talked = answeredLeg === undefined ? leg.durationSec ?? 0 : answeredLeg ? answeredLeg.durationSec ?? 0 : 0;
    Object.assign(facts, { status, statusRank: RANK[status], fromNumber, toNumber, startedAt, endedAt, talkSec: isFinal(status) ? talked : null, priceUsd: leg.price != null ? Math.abs(leg.price) : null });
  }

  let userId = existing?.userId ?? null;
  let repMatchedBy = existing?.repMatchedBy ?? null;
  if (!userId && repMatchedBy !== 'chosen') {
    const rep = matchRep({ direction, fromNumber, toNumber, repIdentity, startedAt }, ctx.users);
    userId = rep.userId; repMatchedBy = rep.by ?? 'none';
  }
  let link: Prisma.CallLogUncheckedUpdateInput = {};
  let intentId: string | null = null;
  let intentTaskId: string | null = null;
  if (!existing || (!existing.personId && !existing.sandboxContactId && existing.matchedBy !== 'chosen')) {
    const intent = direction === 'OUTBOUND' ? await findIntent(other, startedAt, userId) : null;
    if (intent) {
      intentId = intent.id;
      intentTaskId = intent.taskId;
      if (!userId) { userId = intent.userId; repMatchedBy = 'intent'; }
      // N013: the step pressed counts only when it is a call step; an Email or LinkedIn step never takes the call.
      const step = await intentStep(intent);
      const task = step.taskId ? await prisma.task.findUnique({ where: { id: step.taskId }, select: { enrollmentId: true, enrollment: { select: { campaignId: true } } } }) : null;
      link = { personId: intent.personId, sandboxContactId: intent.sandboxContactId, matchedBy: 'dialed', taskId: step.taskId, nextActionId: step.nextActionId, enrollmentId: task?.enrollmentId ?? null, campaignId: task?.enrollment.campaignId ?? null, candidates: undefined };
    } else {
      const m = await matchContact(other, userId);
      link = m.matchedBy === 'number' ? { personId: m.personId, sandboxContactId: m.sandboxContactId, matchedBy: 'number' } : m.matchedBy === 'ambiguous' ? { matchedBy: 'ambiguous', candidates: m.candidates } : { matchedBy: 'none' };
    }
  }
  const subject = { personId: (link.personId as string | null | undefined) ?? existing?.personId ?? null, sandboxContactId: (link.sandboxContactId as string | null | undefined) ?? existing?.sandboxContactId ?? null };

  // N014: one call, one record. A call logged by hand is this call: it takes Twilio's facts and keeps its form.
  if (!existing) {
    const manual = await loggedByHand(userId, subject, startedAt, other);
    if (manual) {
      const merged = await prisma.callLog.update({ where: { id: manual.id }, data: { ...facts, twilioCallSid: leg.sid } });
      if (intentId) await prisma.callIntent.updateMany({ where: { id: intentId, callId: null }, data: { callId: merged.id } });
      return { call: merged, created: false, formOpened: false, joined: 'logged_call' };
    }
  }

  const finalNow = isFinal((facts.status as CallStatus | undefined) ?? existing?.status ?? status);
  const started = startedAt ?? existing?.startedAt ?? null;
  const talkSec = (facts.talkSec as number | null | undefined) ?? existing?.talkSec ?? null;
  const finalStatus = (facts.status as CallStatus | undefined) ?? existing?.status ?? status;
  // B093: an incoming call asks for a form only when someone answered it. N049: never for an old call.
  const answeredIfIncoming = direction === 'OUTBOUND' || (finalStatus === 'COMPLETED' && (talkSec ?? 0) > 0);
  let formOpened = Boolean(finalNow && userId && answeredIfIncoming && !existing?.formDueAt && !existing?.formDoneAt && started && started >= ctx.formsFrom && ctx.now.getTime() - started.getTime() < FORM_CATCH_UP_MS);

  // N014: the CRM's quick Log call already filed this call on its step: no second form, note or touch.
  let joined: 'log_call_step' | undefined;
  let filed: Prisma.CallLogUncheckedUpdateInput = {};
  // M25: also when the call was first read while still in progress, and ends now.
  if ((!existing || existing.statusRank < 4) && finalNow && subject.personId && !existing?.formDoneAt) {
    const step = await loggedOnStep(userId, subject.personId, started, endedAt, intentTaskId);
    if (step) {
      joined = 'log_call_step';
      formOpened = false;
      filed = { taskId: step.task.id, nextActionId: null, enrollmentId: step.task.enrollmentId, campaignId: step.task.enrollment.campaignId, formDoneAt: step.task.completedAt, touchId: step.touchId };
    }
  }

  // Stamped once, when the call is first matched to someone (PLAN 8.4): its audience, and the pod it counts for (B040).
  const stamp: Prisma.CallLogUncheckedUpdateInput = {};
  if (!existing?.audience) { const audience = await audienceFor(subject); if (audience) stamp.audience = audience; }
  if (!existing?.podId) { const podId = await callPodFor({ enrollmentId: (filed.enrollmentId as string | null | undefined) ?? (link.enrollmentId as string | null | undefined) ?? existing?.enrollmentId ?? null, sandboxContactId: subject.sandboxContactId, userId, personId: subject.personId }); if (podId) stamp.podId = podId; }
  const data = { ...facts, ...link, ...filed, userId, repMatchedBy, ...stamp, ...(formOpened ? { formDueAt: endedAt ?? ctx.now } : {}) };

  let created = false;
  if (existing) existing = await prisma.callLog.update({ where: { id: existing.id }, data });
  else {
    try {
      existing = await prisma.callLog.create({ data: { ...(data as Prisma.CallLogUncheckedCreateInput), source: 'TWILIO_IMPORT', direction, twilioCallSid: leg.sid } });
      created = true;
    } catch (err) {
      // B166: another import stored the same call a moment ago; it is one call, so update that one.
      if (!isUniqueViolation(err)) throw err;
      existing = await prisma.callLog.update({ where: { twilioCallSid: leg.sid }, data: facts });
    }
  }
  let call = existing;
  if (intentId) await prisma.callIntent.updateMany({ where: { id: intentId, callId: null }, data: { callId: call.id } });
  // PLAN 8.7, B023: with no call step from an intent, a completed outgoing call takes the one call step due.
  if (finalNow && !call.taskId && !call.nextActionId && !call.formDoneAt && (call.personId || call.sandboxContactId)) {
    const step = await stepByRule(call);
    if (step) call = await prisma.callLog.update({ where: { id: call.id }, data: linkData(step) });
  }
  if (finalNow) await recordCallTouch(call);
  if (finalNow && !wasFinal && direction === 'OUTBOUND') await alertCallToDoNotContact(call);
  return { call: await prisma.callLog.findUniqueOrThrow({ where: { id: call.id } }), created, formOpened, joined };
}

export const CALL_TO_DO_NOT_CONTACT = 'call_to_do_not_contact';

/**
 * M07: a call made (from the dialpad too) to a number on the suppression list, or to someone opted out,
 * removed or Do not contact: counted once (audit) and the rep and their pod's leaders are told, whether
 * or not the number still belongs to anyone.
 */
async function alertCallToDoNotContact(call: CallLog): Promise<void> {
  const number = call.toNumber && call.toNumber.startsWith('+') ? call.toNumber : null;
  const cold = call.sandboxContactId ? await prisma.sandboxContact.findUnique({ where: { id: call.sandboxContactId }, select: { status: true, firstName: true, lastName: true, podId: true } }) : null;
  const person = call.personId ? await prisma.personCache.findUnique({ where: { id: call.personId }, select: { optedOut: true, dnd: true, firstName: true, lastName: true } }) : null;
  const why = cold?.status === 'OPTED_OUT' || person?.optedOut ? 'They asked not to be contacted.'
    : cold?.status === 'REMOVED' ? 'They were removed from Cold outreach.'
    : person?.dnd ? 'They are marked Do not contact in the CRM.'
    : number && (await findSuppressed([{ kind: 'phone', value: number }])) ? 'The number is on the suppression list.'
    : null;
  if (!why) return;
  if (await prisma.auditLog.count({ where: { action: CALL_TO_DO_NOT_CONTACT, entityId: call.id } })) return;
  await logAudit({ entityType: 'call', entityId: call.id, action: CALL_TO_DO_NOT_CONTACT, actor: SYSTEM_ACTOR, details: { userId: call.userId, number: number ? maskValue('phone', number) : null, why } });
  const rep = call.userId ? await prisma.user.findUnique({ where: { id: call.userId }, select: { name: true, pods: { select: { podId: true } } } }) : null;
  const leaders = await podLeaders([call.podId ?? cold?.podId ?? null, ...(call.podId || cold?.podId ? [] : rep?.pods.map((p) => p.podId) ?? [])]);
  const name = (cold && `${cold.firstName} ${cold.lastName}`.trim()) || (person && `${person.firstName} ${person.lastName}`.trim()) || (number ? maskValue('phone', number) : 'an unknown number');
  const text = `${rep?.name ?? 'Someone'} called ${name}. ${why} Do not email, call or message this person.`;
  await notify([call.userId, ...leaders], { kind: 'compliance_alert', sandboxContactId: cold ? call.sandboxContactId : null, personId: person ? call.personId : null, fromUserId: call.userId, payload: { text, name, address: number ? maskValue('phone', number) : null, why, at: (call.startedAt ?? call.createdAt).toISOString(), href: `/calls/${call.id}` } });
}

const talk = (sec: number | null) => (!sec ? 'not connected' : sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);

/** The call on the contact's timeline, once: `twilio:<CallSid>` merges with the dialpad's own note. */
export async function recordCallTouch(call: CallLog): Promise<void> {
  // M13: a discarded call counts nowhere, even when the import reads it again.
  if (call.touchId || call.discardedAt || (!call.personId && !call.sandboxContactId)) return;
  const at = call.startedAt ?? call.createdAt;
  const externalId = call.twilioCallSid ? `twilio:${call.twilioCallSid}` : `call:${call.id}`;
  const user = call.userId ? await prisma.user.findUnique({ where: { id: call.userId }, select: { name: true } }) : null;
  const audience = call.audience ?? await audienceFor(call);
  const upsert = () => prisma.touch.upsert({
    where: { externalId },
    create: { personId: call.personId, sandboxContactId: call.sandboxContactId, channel: 'CALL', direction: call.direction, occurredAt: at, summary: `${call.direction === 'OUTBOUND' ? 'Call made' : 'Call received'} (${talk(call.talkSec)})`, externalId, actorUserId: call.userId, actorLabel: user?.name ?? null, audience },
    update: {},
  });
  // B184: two saves of one call's form at once both reach here; the upsert is not atomic, so the one
  // that loses the insert takes the touch the other wrote (one call, one touch).
  const touch = await upsert().catch((err) => {
    if (!isUniqueViolation(err)) throw err;
    return prisma.touch.findUniqueOrThrow({ where: { externalId } });
  });
  await prisma.callLog.update({ where: { id: call.id }, data: { touchId: touch.id } });
  if (call.sandboxContactId) await prisma.sandboxContact.updateMany({ where: { id: call.sandboxContactId, OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: at } }] }, data: { lastActivityAt: at } });
}
