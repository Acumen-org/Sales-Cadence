import { Prisma, type LinkedInEvent, type LinkedInLink } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { logAudit, SYSTEM_ACTOR } from '../audit';
import { completeTask } from '../engine/tasks';
import { closeFromTouch } from '../engine/observed-evidence';
import { markReplied, OCCUPYING_STATUSES } from '../engine/enrollment';
import { audienceOf } from '../outreach/audience';
import { sandboxSortName } from '../sandbox/normalize';
import { suppressionHash } from '../sandbox/suppression';
import { getSettings } from '../settings';
import { profileKeyOf, splitName } from './keys';
import { closeFollowUps, openFollowUp, subjectWhere, type LinkedInSubject } from './follow-ups';

/**
 * Events from the LinkedIn Console (the Console developer's spec, "Event format"): a teammate sent or
 * withdrew a connection request, a request was accepted, a message went out or came in. They arrive by a
 * signed webhook and by the feed the worker reads; both are kept once, by the Console's sequence number,
 * and the worker processes them in that order. Cadence only reads them: it never acts on LinkedIn.
 */

export const LINKEDIN_EVENT_TYPES = ['invitation.sent', 'invitation.withdrawn', 'connection.accepted', 'message.sent', 'message.received'] as const;
export type LinkedInEventType = (typeof LINKEDIN_EVENT_TYPES)[number];

const nullishText = z.string().nullish();
export const ConsoleEventSchema = z.object({
  seq: z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,18}$/)]),
  type: z.enum(LINKEDIN_EVENT_TYPES),
  at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a time'),
  // The Console sends the account's name as `name` (docs/event-feed.md); the spec's `linkedinName` is read too.
  account: z.object({ id: z.string().min(1), name: nullishText, linkedinName: nullishText }).nullish(),
  user: z.object({ email: nullishText, name: nullishText }).nullish(),
  person: z.object({ memberUrn: nullishText, publicId: nullishText, profileUrl: nullishText, name: nullishText }).nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
});
export type ConsoleEvent = z.infer<typeof ConsoleEventSchema>;

/**
 * A per-type field (invitedByUs, note, source, conversationId). The Console puts them beside the envelope's own
 * fields (docs/event-feed.md); the spec had them under `data`. Both are read.
 */
export function eventField(payload: unknown, key: string): unknown {
  const p = (payload ?? {}) as Record<string, unknown> & { data?: Record<string, unknown> | null };
  return p.data && key in p.data ? p.data[key] : p[key];
}

/** A person whose profile link never arrives is given up on after this long. */
const WAIT_FOR_PROFILE_MS = 30 * 86_400_000;

/** Keep events, each once. A later event that carries the profile link of a member waiting for one wakes them. */
export async function storeEvents(raw: unknown[], via: 'webhook' | 'feed' | 'test'): Promise<{ stored: number; duplicates: number; invalid: number; lastSeq: bigint | null }> {
  const rows: Prisma.LinkedInEventCreateManyInput[] = [];
  let invalid = 0;
  let lastSeq: bigint | null = null;
  for (const item of raw) {
    const parsed = ConsoleEventSchema.safeParse(item);
    if (!parsed.success) { invalid++; continue; }
    const e = parsed.data;
    const seq = BigInt(e.seq);
    if (lastSeq === null || seq > lastSeq) lastSeq = seq;
    rows.push({
      seq, type: e.type, at: new Date(e.at), via,
      accountId: e.account?.id ?? null,
      userEmail: e.user?.email?.trim().toLowerCase() || null,
      memberUrn: e.person?.memberUrn || null,
      profileKey: profileKeyOf(e.person?.profileUrl, e.person?.publicId),
      name: e.person?.name?.trim() || null,
      // Kept as the Console sent it, so its per-type fields stay (see eventField).
      payload: item as Prisma.InputJsonValue,
    });
  }
  const { count } = rows.length ? await prisma.linkedInEvent.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
  for (const r of rows) {
    if (r.memberUrn && r.profileKey) await prisma.linkedInEvent.updateMany({ where: { memberUrn: r.memberUrn, profileKey: null, processedAt: null }, data: { profileKey: r.profileKey, result: null } });
  }
  return { stored: count, duplicates: rows.length - count, invalid, lastSeq };
}

type Resolved =
  | { kind: 'subject'; subject: LinkedInSubject }
  | { kind: 'do_not_contact' }
  | { kind: 'ambiguous'; personIds: string[] }
  | { kind: 'unknown' };

/**
 * Who a profile is, by its link: a CRM person first (an "Also in CRM" cold contact is the CRM person's),
 * then a cold contact; a cold contact that moved is its CRM person. Never by name.
 */
export async function resolveProfile(profileKey: string): Promise<Resolved> {
  const people = await prisma.personCache.findMany({ where: { linkedinKey: profileKey, deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' }, take: 5 });
  if (people.length === 1) return { kind: 'subject', subject: { personId: people[0].id } };
  if (people.length > 1) return { kind: 'ambiguous', personIds: people.map((p) => p.id) };
  const contacts = await prisma.sandboxContact.findMany({ where: { linkedinUrl: profileKey, status: { in: ['ACTIVE', 'MOVED', 'OPTED_OUT'] } }, select: { id: true, status: true, twentyPersonId: true }, orderBy: { createdAt: 'desc' } });
  const active = contacts.find((c) => c.status === 'ACTIVE');
  if (active) return { kind: 'subject', subject: { sandboxContactId: active.id } };
  const moved = contacts.find((c) => c.status === 'MOVED' && c.twentyPersonId);
  if (moved && (await prisma.personCache.count({ where: { id: moved.twentyPersonId!, deletedAt: null } }))) return { kind: 'subject', subject: { personId: moved.twentyPersonId! } };
  if (contacts.some((c) => c.status === 'OPTED_OUT')) return { kind: 'do_not_contact' };
  if (await prisma.suppression.count({ where: { kind: 'linkedin', valueHash: suppressionHash('linkedin', profileKey) } })) return { kind: 'do_not_contact' };
  return { kind: 'unknown' };
}

/**
 * Someone a teammate reached on LinkedIn who is in neither the CRM nor Cold outreach becomes a cold contact
 * with no owner (owner's rule: nobody owns them until they accept or write back). Their pod is the sender's.
 */
async function createColdContact(e: LinkedInEvent, profileKey: string, userId: string | null, accountName: string | null): Promise<string> {
  const { firstName, lastName } = splitName(e.name);
  const pod = userId ? await prisma.userPod.findFirst({ where: { userId }, select: { podId: true }, orderBy: { podId: 'asc' } }) : null;
  const c = await prisma.sandboxContact.create({
    data: {
      source: 'LINKEDIN', firstName, lastName, sortName: sandboxSortName(firstName, lastName), linkedinUrl: profileKey,
      podId: pod?.podId ?? null, createdById: userId, lastActivityAt: e.at,
      sourceNote: `Reached on LinkedIn${accountName ? ` from ${accountName}'s account` : ''}.`,
    },
  });
  await logAudit({ entityType: 'sandbox_contact', entityId: c.id, action: 'created', actor: SYSTEM_ACTOR, details: { source: 'linkedin', eventSeq: e.seq.toString(), accountId: e.accountId } });
  return c.id;
}

const touchKey = (e: Pick<LinkedInEvent, 'seq'>) => `linkedin:${e.seq.toString()}`;

async function recordTouch(e: LinkedInEvent, subject: LinkedInSubject, direction: 'OUTBOUND' | 'INBOUND', summary: string, userId: string | null, accountName: string | null) {
  const status = 'sandboxContactId' in subject ? (await prisma.sandboxContact.findUnique({ where: { id: subject.sandboxContactId }, select: { status: true } }))?.status : null;
  const who = 'personId' in subject ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId };
  const touch = await prisma.touch.upsert({
    where: { externalId: touchKey(e) },
    create: { ...who, channel: 'LINKEDIN', direction, occurredAt: e.at, summary, externalId: touchKey(e), actorUserId: direction === 'OUTBOUND' ? userId : null, actorLabel: accountName, audience: audienceOf(who, status) },
    update: {},
  });
  if ('sandboxContactId' in subject) await prisma.sandboxContact.updateMany({ where: { id: subject.sandboxContactId, OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: e.at } }] }, data: { lastActivityAt: e.at } });
  return touch;
}

/** Where this account stands with the person, kept on their subject. */
async function upsertLink(e: LinkedInEvent, profileKey: string, subject: LinkedInSubject, create: Omit<Prisma.LinkedInLinkUncheckedCreateInput, 'accountId' | 'profileKey'>): Promise<LinkedInLink> {
  const accountId = e.accountId ?? 'unknown';
  const who = 'personId' in subject ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId };
  return prisma.linkedInLink.upsert({
    where: { accountId_profileKey: { accountId, profileKey } },
    create: { accountId, profileKey, memberUrn: e.memberUrn, name: e.name, ...who, ...create },
    update: { ...who, ...(e.memberUrn ? { memberUrn: e.memberUrn } : {}), ...(e.name ? { name: e.name } : {}) },
  });
}

/** A reply stops the campaign, as an email reply does (owner, 12 Nov 2026). */
async function stopCampaignsForReply(subject: LinkedInSubject, e: LinkedInEvent): Promise<number> {
  const running = await prisma.enrollment.findMany({ where: { ...subjectWhere(subject), status: { in: OCCUPYING_STATUSES } }, select: { id: true } });
  let n = 0;
  for (const r of running) if ((await markReplied(r.id, { at: e.at, evidenceId: touchKey(e), actor: SYSTEM_ACTOR })).changed) n++;
  return n;
}

/**
 * A campaign's "LinkedIn connect" step that has nothing left to do: the person is already connected to one
 * of the firm's accounts, or a request to them is already waiting. Done, saying why. Returns how many.
 */
export async function closeConnectStepsAlreadyDone(subject: LinkedInSubject | null, now = new Date()): Promise<number> {
  const tasks = await prisma.task.findMany({
    where: { state: 'PENDING', action: 'LINKEDIN_CONNECT', enrollment: { status: 'ACTIVE', ...(subject ? subjectWhere(subject) : {}) } },
    select: { id: true, enrollment: { select: { personId: true, sandboxContactId: true } } },
    take: 500,
  });
  let n = 0;
  for (const t of tasks) {
    const s: LinkedInSubject | null = t.enrollment.personId ? { personId: t.enrollment.personId } : t.enrollment.sandboxContactId ? { sandboxContactId: t.enrollment.sandboxContactId } : null;
    if (!s) continue;
    const link = await prisma.linkedInLink.findFirst({ where: { ...subjectWhere(s), status: { in: ['ACCEPTED', 'PENDING'] }, OR: [{ invitedAt: { not: null } }, { acceptedAt: { not: null } }, { status: 'ACCEPTED' }] }, orderBy: { updatedAt: 'desc' } });
    if (!link) continue;
    const account = await prisma.linkedInAccount.findUnique({ where: { id: link.accountId }, select: { name: true } });
    const note = link.status === 'ACCEPTED' ? `Already connected on LinkedIn${account ? ` (${account.name}'s account)` : ''}.` : `A connection request is already waiting${account ? ` (from ${account.name}'s account)` : ''}.`;
    const r = await completeTask({ taskId: t.id, source: 'SYSTEM', note, occurredAt: now }, { actor: SYSTEM_ACTOR, now });
    if (r.ok) n++;
  }
  return n;
}

type Outcome = { result: string; subject?: LinkedInSubject | null };

async function handle(e: LinkedInEvent, profileKey: string, userId: string | null, accountName: string | null, now: Date): Promise<Outcome> {
  const { linkedin, matching } = await getSettings();
  const resolved = await resolveProfile(profileKey);
  if (resolved.kind === 'do_not_contact') return { result: 'do_not_contact' };
  if (resolved.kind === 'ambiguous') return { result: 'ambiguous_crm' };
  const ctx = { actor: SYSTEM_ACTOR, now };
  const from = accountName ? ` (${accountName}'s account)` : '';

  // Someone we did not know: only our own outreach brings them in (owner's rule: the Needs owner list is
  // for people we contacted first). A stranger who wrote to us, or asked to connect, stays out.
  let subject: LinkedInSubject | null = resolved.kind === 'subject' ? resolved.subject : null;
  if (!subject) {
    const accepted = e.type === 'connection.accepted' ? eventField(e.payload, 'invitedByUs') !== false : false;
    const ours = e.type === 'invitation.sent' || e.type === 'message.sent' || accepted
      || (e.type === 'message.received' && (await prisma.linkedInEvent.count({ where: { profileKey, type: { in: ['invitation.sent', 'message.sent'] }, seq: { lt: e.seq } } })) > 0);
    if (!ours) return { result: 'not_ours' };
    subject = { sandboxContactId: await createColdContact(e, profileKey, userId, accountName) };
  }

  switch (e.type) {
    case 'invitation.sent': {
      const prior = await prisma.linkedInLink.findUnique({ where: { accountId_profileKey: { accountId: e.accountId ?? 'unknown', profileKey } } });
      const resend = prior?.status === 'WITHDRAWN' && prior.withdrawnAt && prior.withdrawnAt <= e.at;
      const link = await upsertLink(e, profileKey, subject, { status: 'PENDING', invitedAt: e.at, invitedByUserId: userId, invitedByUs: true });
      if (prior && prior.status !== 'ACCEPTED') {
        // A request seen twice (the Sent list after the click) keeps its first time; a resend starts a new one.
        const invitedAt = resend || !prior.invitedAt || prior.status === 'WITHDRAWN' ? e.at : prior.invitedAt < e.at ? prior.invitedAt : e.at;
        await prisma.linkedInLink.update({ where: { id: link.id }, data: { status: 'PENDING', invitedAt, invitedByUs: true, ...(userId ? { invitedByUserId: userId } : {}), ...(resend ? { resends: { increment: 1 }, withdrawnAt: null } : {}) } });
      }
      const touch = await recordTouch(e, subject, 'OUTBOUND', `LinkedIn connection request sent${from}`, userId, accountName);
      if (!linkedin.enabled) return { result: 'recorded', subject };
      const closed = await closeFromTouch({ ...('personId' in subject ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId }), types: ['LINKEDIN_CONNECT'], touch: { externalId: touch.externalId, channel: 'LINKEDIN', occurredAt: e.at, summary: touch.summary }, source: 'OBSERVED_MESSAGE', matching, ctx });
      const resent = await closeFollowUps({ ...subjectWhere(subject), kind: 'RESEND', triggeredAt: { lte: e.at } }, { state: 'DONE', at: e.at, evidenceId: touchKey(e) });
      return { result: closed.code === 'completed' ? 'invitation_step_closed' : resent ? 'invitation_resend_done' : 'invitation_recorded', subject };
    }
    case 'invitation.withdrawn': {
      const link = await upsertLink(e, profileKey, subject, { status: 'WITHDRAWN', withdrawnAt: e.at });
      if (link.status === 'ACCEPTED') return { result: 'withdrawn_after_accept_ignored', subject };
      const updated = await prisma.linkedInLink.update({ where: { id: link.id }, data: { status: 'WITHDRAWN', withdrawnAt: e.at } });
      if (!linkedin.enabled) return { result: 'recorded', subject };
      await closeFollowUps({ linkId: link.id, kind: 'WITHDRAW' }, { state: 'DONE', at: e.at, evidenceId: touchKey(e) });
      // One resend, then stop (owner, 12 Nov 2026).
      if (updated.resends >= linkedin.maxResends) return { result: 'withdrawn_no_more_resends', subject };
      const opened = await openFollowUp({ kind: 'RESEND', trigger: 'withdrawn', triggeredAt: e.at, link: updated, subject }, now);
      return { result: opened ? 'withdrawn_resend_opened' : 'withdrawn', subject };
    }
    case 'connection.accepted': {
      const data = { invitedByUs: eventField(e.payload, 'invitedByUs') };
      const prior = await prisma.linkedInLink.findUnique({ where: { accountId_profileKey: { accountId: e.accountId ?? 'unknown', profileKey } } });
      const ours = data.invitedByUs === true || (data.invitedByUs !== false && Boolean(prior?.invitedAt)) || (data.invitedByUs === undefined && !prior);
      const link = await upsertLink(e, profileKey, subject, { status: 'ACCEPTED', acceptedAt: e.at, invitedByUs: ours });
      const updated = await prisma.linkedInLink.update({ where: { id: link.id }, data: { status: 'ACCEPTED', acceptedAt: e.at, invitedByUs: ours || (prior?.invitedByUs ?? false) } });
      if (!linkedin.enabled) return { result: 'recorded', subject };
      // A withdrawal or resend waiting for them is not needed any more.
      await closeFollowUps({ ...subjectWhere(subject), kind: { in: ['WITHDRAW', 'RESEND'] } }, { state: 'CANCELLED', at: e.at, reason: 'They accepted', evidenceId: touchKey(e) });
      await closeConnectStepsAlreadyDone(subject, now);
      if (!ours) return { result: 'accepted_not_ours', subject };
      // Messaged already since they accepted (any account): nothing to ask.
      const messaged = await prisma.touch.count({ where: { ...subjectWhere(subject), channel: 'LINKEDIN', direction: 'OUTBOUND', summary: { startsWith: 'LinkedIn message sent' }, occurredAt: { gte: e.at } } });
      if (messaged) return { result: 'accepted_already_messaged', subject };
      const opened = await openFollowUp({ kind: 'MESSAGE', trigger: 'accepted', triggeredAt: e.at, link: updated, subject }, now);
      return { result: opened ? 'accepted_message_opened' : 'accepted', subject };
    }
    case 'message.sent': {
      const link = await upsertLink(e, profileKey, subject, { status: 'ACCEPTED', invitedByUs: false, lastSentAt: e.at });
      await prisma.linkedInLink.updateMany({ where: { id: link.id, OR: [{ lastSentAt: null }, { lastSentAt: { lt: e.at } }] }, data: { lastSentAt: e.at } });
      const touch = await recordTouch(e, subject, 'OUTBOUND', `LinkedIn message sent${from}`, userId, accountName);
      if (!linkedin.enabled) return { result: 'recorded', subject };
      const closed = await closeFromTouch({ ...('personId' in subject ? { personId: subject.personId } : { sandboxContactId: subject.sandboxContactId }), types: ['LINKEDIN_MESSAGE'], touch: { externalId: touch.externalId, channel: 'LINKEDIN', occurredAt: e.at, summary: touch.summary }, source: 'OBSERVED_MESSAGE', matching, ctx });
      const done = await closeFollowUps({ ...subjectWhere(subject), kind: 'MESSAGE', triggeredAt: { lte: e.at } }, { state: 'DONE', at: e.at, evidenceId: touchKey(e) });
      return { result: closed.code === 'completed' ? 'message_step_closed' : done ? 'message_follow_up_done' : 'message_recorded', subject };
    }
    case 'message.received': {
      const link = await upsertLink(e, profileKey, subject, { status: 'ACCEPTED', invitedByUs: false, lastReplyAt: e.at });
      await prisma.linkedInLink.updateMany({ where: { id: link.id, OR: [{ lastReplyAt: null }, { lastReplyAt: { lt: e.at } }] }, data: { lastReplyAt: e.at } });
      await recordTouch(e, subject, 'INBOUND', `LinkedIn reply${from}`, userId, accountName);
      if (!linkedin.enabled) return { result: 'recorded', subject };
      const stopped = await stopCampaignsForReply(subject, e);
      // Answer them: the owner, or Needs owner for a cold contact nobody owns yet.
      await openFollowUp({ kind: 'MESSAGE', trigger: 'replied', triggeredAt: e.at, link, subject }, now);
      return { result: stopped ? 'reply_campaign_stopped' : 'reply_recorded', subject };
    }
  }
  return { result: 'unknown_type' };
}

/** Process one event: its teammate and account, then what it means. Each event once. */
export async function processEvent(e: LinkedInEvent, now = new Date()): Promise<string> {
  if (e.processedAt) return e.result ?? 'processed';
  const p = e.payload as ConsoleEvent;
  let accountName = p.account?.name?.trim() || p.account?.linkedinName?.trim() || null;
  if (e.accountId) {
    const acc = await prisma.linkedInAccount.upsert({ where: { id: e.accountId }, create: { id: e.accountId, name: accountName ?? e.accountId }, update: { ...(accountName ? { name: accountName } : {}), seenAt: now } });
    accountName = acc.name;
  }
  const user = e.userEmail ? await prisma.user.findFirst({ where: { email: { equals: e.userEmail, mode: 'insensitive' } }, select: { id: true } }) : null;
  if (!e.profileKey) {
    const result = now.getTime() - e.receivedAt.getTime() > WAIT_FOR_PROFILE_MS ? 'no_profile' : 'waiting_profile';
    await prisma.linkedInEvent.update({ where: { id: e.id }, data: { userId: user?.id ?? null, result, ...(result === 'no_profile' ? { processedAt: now } : {}) } });
    return result;
  }
  const out = await handle(e, e.profileKey, user?.id ?? null, accountName, now);
  const s = out.subject;
  await prisma.linkedInEvent.update({
    where: { id: e.id },
    data: { processedAt: now, result: out.result, userId: user?.id ?? null, personId: s && 'personId' in s ? s.personId : null, sandboxContactId: s && 'sandboxContactId' in s ? s.sandboxContactId : null },
  });
  return out.result;
}

/** Every event not processed yet that can be, oldest first. Returns a count per result. */
export async function processPendingEvents(now = new Date(), limit = 200): Promise<Record<string, number>> {
  const pending = await prisma.linkedInEvent.findMany({ where: { processedAt: null, OR: [{ result: null }, { result: { not: 'waiting_profile' } }, { receivedAt: { lt: new Date(now.getTime() - WAIT_FOR_PROFILE_MS) } }] }, orderBy: { seq: 'asc' }, take: limit });
  const counts: Record<string, number> = {};
  for (const e of pending) {
    let result: string;
    try {
      result = await processEvent(e, now);
    } catch (err) {
      result = 'error';
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[linkedin] event ${e.seq} failed: ${message}`);
      await prisma.linkedInEvent.update({ where: { id: e.id }, data: { result: `error: ${message.slice(0, 300)}` } });
    }
    counts[result] = (counts[result] ?? 0) + 1;
  }
  return counts;
}
