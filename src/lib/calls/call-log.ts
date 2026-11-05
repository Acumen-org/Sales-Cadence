import type { CallLog, CallStatus, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { toE164 } from '../sandbox/normalize';
import type { TwilioCall } from './twilio';
import { identityOf, matchContact, matchRep } from './match';
import { audienceFor, callPodFor } from '../outreach/audience';

/**
 * One call read from Twilio, stored once and kept up to date: its status only moves forward, the
 * rep and contact are matched once, and an ended call of a matched rep opens their post-call form.
 */

export const STATUS_OF: Record<string, CallStatus> = {
  queued: 'QUEUED', initiated: 'INITIATED', ringing: 'RINGING', 'in-progress': 'IN_PROGRESS', completed: 'COMPLETED', busy: 'BUSY', 'no-answer': 'NO_ANSWER', failed: 'FAILED', canceled: 'CANCELED',
};
export const RANK: Record<CallStatus, number> = { QUEUED: 0, INITIATED: 1, RINGING: 2, IN_PROGRESS: 3, COMPLETED: 4, BUSY: 4, NO_ANSWER: 4, FAILED: 4, CANCELED: 4 };
export const isFinal = (s: CallStatus) => RANK[s] === 4;

/** A leg with a browser or SIP end is the dialpad's own leg, not the conversation. */
export const hasClientEnd = (c: Pick<TwilioCall, 'from' | 'to'>) => /^(client|sip):/i.test(c.from) || /^(client|sip):/i.test(c.to);

export type RepUser = { id: string; callerNumber: string | null; aliases: string[] };
export type UpsertContext = { users: RepUser[]; formsFrom: Date; now: Date };

const INTENT_WINDOW_MS = 30 * 60_000;

/** The newest unclaimed press of Call to this number before the call started: the task it was for. */
async function findIntent(number: string | null, startedAt: Date | null, userId: string | null) {
  if (!number || !startedAt) return null;
  const window = { gte: new Date(startedAt.getTime() - INTENT_WINDOW_MS), lte: new Date(startedAt.getTime() + 2 * 60_000) };
  if (userId) return prisma.callIntent.findFirst({ where: { userId, toNumber: number, callId: null, createdAt: window }, orderBy: { createdAt: 'desc' } });
  const intents = await prisma.callIntent.findMany({ where: { toNumber: number, callId: null, createdAt: window }, orderBy: { createdAt: 'desc' }, take: 5 });
  const reps = new Set(intents.map((i) => i.userId));
  return reps.size === 1 ? intents[0] : null;
}

export async function upsertImportedCall(leg: TwilioCall, parent: TwilioCall | null, ctx: UpsertContext): Promise<{ call: CallLog; created: boolean; formOpened: boolean }> {
  const status = STATUS_OF[leg.status] ?? 'QUEUED';
  const direction = leg.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND';
  const fromNumber = toE164(leg.from) ?? (leg.from || null);
  const toNumber = toE164(leg.to) ?? (leg.to || null);
  const repIdentity = identityOf(leg.from, leg.to, parent?.from, parent?.to);
  const startedAt = leg.startTime ? new Date(leg.startTime) : null;
  const endedAt = leg.endTime ? new Date(leg.endTime) : null;
  const other = direction === 'OUTBOUND' ? toNumber : fromNumber;
  const existing = await prisma.callLog.findUnique({ where: { twilioCallSid: leg.sid } });

  const facts: Prisma.CallLogUncheckedUpdateInput = { twilioStatus: leg.status, importedAt: ctx.now, parentCallSid: leg.parentCallSid ?? parent?.sid ?? null, repIdentity };
  if (!existing || RANK[status] >= existing.statusRank) {
    Object.assign(facts, { status, statusRank: RANK[status], fromNumber, toNumber, startedAt, endedAt, talkSec: isFinal(status) ? leg.durationSec ?? 0 : null, priceUsd: leg.price != null ? Math.abs(leg.price) : null });
  }

  let userId = existing?.userId ?? null;
  let repMatchedBy = existing?.repMatchedBy ?? null;
  if (!userId && repMatchedBy !== 'chosen') {
    const rep = matchRep({ direction, fromNumber, toNumber, repIdentity }, ctx.users);
    userId = rep.userId; repMatchedBy = rep.by ?? 'none';
  }
  let link: Prisma.CallLogUncheckedUpdateInput = {};
  let intentId: string | null = null;
  if (!existing || (!existing.personId && !existing.sandboxContactId && existing.matchedBy !== 'chosen')) {
    const intent = await findIntent(other, startedAt, userId);
    if (intent) {
      intentId = intent.id;
      if (!userId) { userId = intent.userId; repMatchedBy = 'intent'; }
      const task = intent.taskId ? await prisma.task.findUnique({ where: { id: intent.taskId }, select: { enrollmentId: true, enrollment: { select: { campaignId: true } } } }) : null;
      link = { personId: intent.personId, sandboxContactId: intent.sandboxContactId, matchedBy: 'dialed', taskId: intent.taskId, nextActionId: intent.nextActionId, enrollmentId: task?.enrollmentId ?? null, campaignId: task?.enrollment.campaignId ?? null, candidates: undefined };
    } else {
      const m = await matchContact(other, userId);
      link = m.matchedBy === 'number' ? { personId: m.personId, sandboxContactId: m.sandboxContactId, matchedBy: 'number' } : m.matchedBy === 'ambiguous' ? { matchedBy: 'ambiguous', candidates: m.candidates } : { matchedBy: 'none' };
    }
  }
  const finalNow = isFinal((facts.status as CallStatus | undefined) ?? existing?.status ?? status);
  const started = startedAt ?? existing?.startedAt ?? null;
  const formOpened = Boolean(finalNow && userId && !existing?.formDueAt && !existing?.formDoneAt && started && started >= ctx.formsFrom);
  // Stamped once, when the call is first matched to someone (PLAN 8.4): its audience, and the pod it counts for (B040).
  const subject = { personId: (link.personId as string | null | undefined) ?? existing?.personId ?? null, sandboxContactId: (link.sandboxContactId as string | null | undefined) ?? existing?.sandboxContactId ?? null };
  const stamp: Prisma.CallLogUncheckedUpdateInput = {};
  if (!existing?.audience) { const audience = await audienceFor(subject); if (audience) stamp.audience = audience; }
  if (!existing?.podId) { const podId = await callPodFor({ enrollmentId: (link.enrollmentId as string | null | undefined) ?? existing?.enrollmentId ?? null, sandboxContactId: subject.sandboxContactId, userId }); if (podId) stamp.podId = podId; }
  const data = { ...facts, ...link, userId, repMatchedBy, ...stamp, ...(formOpened ? { formDueAt: endedAt ?? ctx.now } : {}) };

  const call = existing
    ? await prisma.callLog.update({ where: { id: existing.id }, data })
    : await prisma.callLog.create({ data: { ...(data as Prisma.CallLogUncheckedCreateInput), source: 'TWILIO_IMPORT', direction, twilioCallSid: leg.sid } });
  if (intentId) await prisma.callIntent.updateMany({ where: { id: intentId, callId: null }, data: { callId: call.id } });
  if (finalNow) await recordCallTouch(call);
  return { call: await prisma.callLog.findUniqueOrThrow({ where: { id: call.id } }), created: !existing, formOpened };
}

const talk = (sec: number | null) => (!sec ? 'not connected' : sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);

/** The call on the contact's timeline, once: `twilio:<CallSid>` merges with the dialpad's own note. */
export async function recordCallTouch(call: CallLog): Promise<void> {
  if (call.touchId || (!call.personId && !call.sandboxContactId)) return;
  const at = call.startedAt ?? call.createdAt;
  const externalId = call.twilioCallSid ? `twilio:${call.twilioCallSid}` : `call:${call.id}`;
  const user = call.userId ? await prisma.user.findUnique({ where: { id: call.userId }, select: { name: true } }) : null;
  const audience = call.audience ?? await audienceFor(call);
  const touch = await prisma.touch.upsert({
    where: { externalId },
    create: { personId: call.personId, sandboxContactId: call.sandboxContactId, channel: 'CALL', direction: call.direction, occurredAt: at, summary: `${call.direction === 'OUTBOUND' ? 'Call made' : 'Call received'} (${talk(call.talkSec)})`, externalId, actorUserId: call.userId, actorLabel: user?.name ?? null, audience },
    update: {},
  });
  await prisma.callLog.update({ where: { id: call.id }, data: { touchId: touch.id } });
  if (call.sandboxContactId) await prisma.sandboxContact.updateMany({ where: { id: call.sandboxContactId, OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: at } }] }, data: { lastActivityAt: at } });
}
