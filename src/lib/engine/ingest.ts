import type { ActivityEvent, EventSource, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, webhookActor, RECONCILE_ACTOR, type AuditActor } from '../audit';
import { markPersonDeleted, upsertCompanyCache, upsertPersonCache } from '../person-cache';
import { getSettings, getTwentySchema, type MatchingSettings, type Settings } from '../settings';
import { getTwentyClient, type TwentyClient } from '../twenty';
import {
  canonicalObjectType,
  normalizeCompany,
  normalizeMessage,
  normalizeNote,
  normalizeOpportunity,
  normalizeParticipant,
  normalizePerson,
  normalizeTask,
  type CanonicalObject,
} from '../twenty/normalize';
import type { TwentyCompany, TwentyMessage, TwentyNote, TwentyOpportunity, TwentyPerson, TwentyTask } from '../twenty/types';
import { OCCUPYING_STATUSES, applyPersonFlags, markMeeting, markReplied } from './enrollment';
import { actionTypesFor, classifyMessage, classifyNoteTitle, resolveNoteActor, type UserLike } from './matching';
import { completeTask, type EngineContext } from './tasks';
import { channelOf } from '../sequences/steps';

export type IngestInput = {
  source: EventSource;
  /** Twenty object name (singular or plural) or canonical type. */
  objectType: string;
  /** e.g. note.created, person.updated, messageParticipant.created */
  eventName: string;
  record: Record<string, unknown>;
  recordId?: string;
  /** The record's updatedAt (dedupe key). Null = dedupe on eventName only. */
  updatedAt?: string | null;
  now?: Date;
  skipSync?: boolean;
};

export type IngestResult = {
  status: 'processed' | 'duplicate' | 'ignored' | 'error';
  result: string;
  eventId?: string;
  needsReview?: boolean;
  details?: Record<string, unknown>;
};

export type ProcessOutcome = { result: string; needsReview?: boolean; reviewNote?: string; details?: Record<string, unknown> };

export function dedupeKeyFor(objectType: string, recordId: string, updatedAt: string | null | undefined, eventName: string): string {
  return `${objectType}:${recordId}:${updatedAt ?? eventName}`;
}

/**
 * Rule 6: every inbound event is stored once (dedupe on object + id + updatedAt), then processed.
 * Processing is idempotent by construction (single-use evidence, no-op state transitions), so a
 * lost race or a reconcile re-scan can never advance a step twice.
 */
export async function ingestEvent(input: IngestInput, client?: TwentyClient): Promise<IngestResult> {
  const schema = await getTwentySchema();
  const canonical = canonicalObjectType(input.objectType, schema) ?? (input.objectType as CanonicalObject);
  const recordId = input.recordId ?? (typeof input.record.id === 'string' ? input.record.id : String(input.record.id ?? ''));
  if (!recordId) return { status: 'ignored', result: 'no_record_id' };
  const updatedAt = input.updatedAt ?? (typeof input.record.updatedAt === 'string' ? input.record.updatedAt : null);
  const dedupeKey = dedupeKeyFor(canonical, recordId, updatedAt, input.eventName);

  const existing = await prisma.activityEvent.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) return { status: 'duplicate', result: 'duplicate', eventId: existing.id, details: { dedupeKey } };

  let event: ActivityEvent;
  try {
    event = await prisma.activityEvent.create({
      data: {
        source: input.source,
        objectType: canonical,
        eventName: input.eventName,
        externalId: recordId,
        externalUpdatedAt: updatedAt ? new Date(updatedAt) : null,
        dedupeKey,
        payload: input.record as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return { status: 'duplicate', result: 'duplicate', details: { dedupeKey } };
    throw err;
  }

  const actor: AuditActor = input.source === 'RECONCILE' ? RECONCILE_ACTOR : webhookActor(input.eventName, recordId);
  const ctx: EngineContext = { actor, now: input.now, skipSync: input.skipSync };
  try {
    const settings = await getSettings();
    const outcome = await process(canonical, input, ctx, settings, client);
    await prisma.activityEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), result: outcome.result, needsReview: Boolean(outcome.needsReview), reviewNote: outcome.reviewNote ?? null },
    });
    return { status: outcome.result.startsWith('ignored') ? 'ignored' : 'processed', result: outcome.result, eventId: event.id, needsReview: outcome.needsReview, details: outcome.details };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.activityEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), result: `error: ${message}`, needsReview: true, reviewNote: message } });
    await logAudit({ entityType: 'event', entityId: event.id, action: 'ingest_failed', actor, details: { message, eventName: input.eventName } });
    return { status: 'error', result: message, eventId: event.id, needsReview: true };
  }
}

async function process(type: CanonicalObject, input: IngestInput, ctx: EngineContext, settings: Settings, client?: TwentyClient): Promise<ProcessOutcome> {
  const schema = await getTwentySchema();
  const deleted = input.eventName.endsWith('.deleted') || input.eventName.endsWith('.destroyed');
  switch (type) {
    case 'person':
      return handlePerson(normalizePerson(input.record, schema), deleted, ctx, settings);
    case 'company':
      return handleCompany(normalizeCompany(input.record, schema), deleted);
    case 'note':
      if (deleted) return { result: 'ignored_deleted' };
      return handleNote(normalizeNote(input.record, schema), ctx, settings);
    case 'message': {
      if (deleted) return { result: 'ignored_deleted' };
      const inline = normalizeMessage(input.record, schema);
      const full = inline.participants.length ? inline : await fetchMessage(inline.id, client);
      if (!full) return { result: 'ignored_message_not_found' };
      return handleMessage(full, ctx, settings);
    }
    case 'messageParticipant': {
      if (deleted) return { result: 'ignored_deleted' };
      const p = normalizeParticipant(input.record, schema);
      if (!p.messageId) return { result: 'ignored_no_message_id' };
      const full = await fetchMessage(p.messageId, client);
      if (!full) return { result: 'ignored_message_not_found', needsReview: true, reviewNote: `message ${p.messageId} not found in Twenty` };
      return handleMessage(full, ctx, settings);
    }
    case 'task':
      if (deleted) return handleTwentyTaskDeleted(String(input.record.id));
      return handleTwentyTask(normalizeTask(input.record, schema), ctx, settings);
    case 'opportunity':
      if (deleted) return { result: 'ignored_deleted' };
      return handleOpportunity(normalizeOpportunity(input.record, schema), ctx, settings);
    default:
      return { result: `ignored_object_${type}` };
  }
}

async function fetchMessage(id: string, client?: TwentyClient): Promise<TwentyMessage | null> {
  const c = client ?? (await getTwentyClient());
  return c.getMessage(id);
}

async function loadUsers(): Promise<UserLike[]> {
  return prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true, twentyMemberId: true, aliases: true } });
}

// ---------------------------------------------------------------------------
// person
// ---------------------------------------------------------------------------

/**
 * A company changed in Twenty. Cadence keeps a cache of accounts (name, owner, firmographics)
 * so the Accounts section, the account timeline and "accounts I own" are right the moment Twenty
 * fires the webhook, rather than at the next nightly refresh.
 */
async function handleCompany(company: TwentyCompany, deleted: boolean): Promise<ProcessOutcome> {
  if (deleted) {
    await prisma.companyCache.updateMany({ where: { id: company.id }, data: { deletedAt: new Date(), syncedAt: new Date() } });
    return { result: 'company_deleted' };
  }
  const before = await prisma.companyCache.findUnique({ where: { id: company.id }, select: { name: true, ownerMemberId: true } });
  await upsertCompanyCache(company);
  const renamed = before && before.name !== company.name;
  const reowned = before && before.ownerMemberId !== (company.ownerMemberId ?? null);
  return {
    result: before ? (renamed || reowned ? 'company_updated' : 'company_unchanged') : 'company_cached',
    details: { name: company.name, ...(renamed ? { renamedFrom: before!.name } : {}), ...(reowned ? { ownerMemberId: company.ownerMemberId ?? null } : {}) },
  };
}

async function handlePerson(person: TwentyPerson, deleted: boolean, ctx: EngineContext, settings: Settings): Promise<ProcessOutcome> {
  if (deleted) {
    await markPersonDeleted(person.id);
    const { exited } = await applyPersonFlags({ id: person.id, dnd: false, deletedAt: new Date().toISOString() }, ctx);
    return { result: exited.length ? 'person_deleted_exited' : 'person_deleted', details: { exited } };
  }
  await upsertPersonCache(person);
  const { exited } = await applyPersonFlags(person, ctx);
  if (exited.length) return { result: 'dnd_exited', details: { exited } };

  // A meeting time on the person is the workspace's own record that a meeting exists: the
  // scheduler writes it, so it is evidence in its own right and does not wait for an
  // opportunity to be created. The evidence id carries the timestamp, so a rebooking counts
  // again while the same booking never counts twice.
  if (settings.rules.meetingOnMeetingTime && person.meetingAt) {
    const e = await prisma.enrollment.findFirst({ where: { personId: person.id, status: { in: [...OCCUPYING_STATUSES, 'REPLIED'] } } });
    if (e) {
      const r = await markMeeting(e.id, { at: ctx.now ?? new Date(), evidenceId: `person:${person.id}:meetingTime:${person.meetingAt}`, actor: ctx.actor, skipSync: ctx.skipSync });
      if (r.changed) return { result: 'meeting_from_meeting_time', details: { enrollmentId: e.id, meetingAt: person.meetingAt } };
    }
  }
  return { result: 'person_cached' };
}

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

async function recordTouch(data: { personId: string; channel: 'EMAIL' | 'CALL' | 'LINKEDIN'; direction: 'OUTBOUND' | 'INBOUND'; occurredAt: Date; summary: string; externalId: string; actorUserId?: string | null; actorLabel?: string | null }) {
  const person = await prisma.personCache.findUnique({ where: { id: data.personId }, select: { id: true } });
  if (!person) return false;
  await prisma.touch.upsert({
    where: { externalId: data.externalId },
    create: { ...data, actorUserId: data.actorUserId ?? null, actorLabel: data.actorLabel ?? null },
    update: { summary: data.summary, occurredAt: data.occurredAt },
  });
  return true;
}

/**
 * Complete the earliest pending task of one of `types` on the person's active enrollment,
 * but only if `actor` is that enrollment's FO. Returns a result code.
 */
async function completeFromEvidence(params: {
  personId: string;
  actor: UserLike;
  types: Array<'EMAIL' | 'CALL'>;
  evidenceId: string;
  occurredAt: Date;
  source: 'OBSERVED_NOTE' | 'OBSERVED_MESSAGE';
  matching: MatchingSettings;
  ctx: EngineContext;
}): Promise<{ code: string; taskId?: string }> {
  const { personId, actor, types, evidenceId, occurredAt, source, ctx } = params;
  const enrollment = await prisma.enrollment.findFirst({ where: { personId, status: 'ACTIVE' } });
  if (!enrollment) return { code: 'no_active_enrollment' };
  if (enrollment.foUserId !== actor.id) return { code: 'ignored_non_fo' };
  const graceMs = params.matching.evidenceGraceDays * 86_400_000;
  if (occurredAt.getTime() < enrollment.createdAt.getTime() - graceMs) return { code: 'stale_evidence' };
  const task = await prisma.task.findFirst({
    where: { enrollmentId: enrollment.id, state: 'PENDING', OR: [{ action: { in: types } }, { altAction: { in: types } }] },
    orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }],
  });
  if (!task) return { code: 'no_pending_task' };
  const chosen = types.includes(task.action as 'EMAIL' | 'CALL') ? task.action : task.altAction!;
  const r = await completeTask({ taskId: task.id, source, evidenceId, chosenAction: chosen, occurredAt }, ctx);
  if (!r.ok) return { code: r.reason, taskId: task.id };
  return { code: 'completed', taskId: task.id };
}

async function handleNote(note: TwentyNote, ctx: EngineContext, settings: Settings): Promise<ProcessOutcome> {
  const cls = classifyNoteTitle(note.title, settings.matching);
  if (cls.kind === 'cadence') return { result: 'ignored_cadence_note' };
  if (cls.kind === 'other') return { result: 'ignored_note_other' };
  if (!note.personIds.length) return { result: 'ignored_note_no_person' };

  const users = await loadUsers();
  const actor = resolveNoteActor(note, cls.actorHandle, users);
  const types = actionTypesFor(cls.kind, settings.matching);
  const channel = cls.kind === 'outbound_email' ? 'EMAIL' : 'CALL';
  const occurredAt = new Date(note.createdAt);
  const outcomes: Record<string, string> = {};
  let anyCompleted = false;
  let anyNonFo = false;

  for (const personId of note.personIds) {
    await recordTouch({
      personId,
      channel,
      direction: 'OUTBOUND',
      occurredAt,
      summary: note.title,
      externalId: `note:${note.id}:person:${personId}`,
      actorUserId: actor?.id ?? null,
      actorLabel: actor?.name ?? note.createdByName ?? cls.actorHandle ?? null,
    });
    if (!actor) {
      outcomes[personId] = 'unknown_actor';
      continue;
    }
    if (!types.length) {
      outcomes[personId] = 'touch_only';
      continue;
    }
    const r = await completeFromEvidence({ personId, actor, types, evidenceId: `note:${note.id}:person:${personId}`, occurredAt, source: 'OBSERVED_NOTE', matching: settings.matching, ctx });
    outcomes[personId] = r.code;
    if (r.code === 'completed') anyCompleted = true;
    if (r.code === 'ignored_non_fo') anyNonFo = true;
  }

  if (!actor) {
    return { result: 'note_unknown_actor', needsReview: true, reviewNote: `Could not map "${note.createdByName ?? cls.actorHandle ?? 'unknown'}" to a Cadence user`, details: outcomes };
  }
  if (anyCompleted) return { result: `note_${cls.kind}_completed`, details: outcomes };
  if (anyNonFo) return { result: 'ignored_non_fo', details: outcomes };
  return { result: `note_${cls.kind}_touch`, details: outcomes };
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

async function handleMessage(message: TwentyMessage, ctx: EngineContext, settings: Settings): Promise<ProcessOutcome> {
  const users = await loadUsers();
  const cls = classifyMessage(message, users);
  const occurredAt = new Date(message.receivedAt);
  const subject = message.subject ?? '(no subject)';

  if (cls.direction === 'outbound') {
    if (!cls.recipientPersonIds.length) return { result: 'ignored_outbound_no_person' };
    const outcomes: Record<string, string> = {};
    let anyCompleted = false;
    let anyNonFo = false;
    for (const personId of cls.recipientPersonIds) {
      await recordTouch({
        personId,
        channel: 'EMAIL',
        direction: 'OUTBOUND',
        occurredAt,
        summary: `Email sent: ${subject}`,
        externalId: `message:${message.id}:person:${personId}`,
        actorUserId: cls.actor.id,
        actorLabel: cls.actor.name,
      });
      const r = await completeFromEvidence({
        personId,
        actor: cls.actor,
        types: ['EMAIL'],
        evidenceId: `message:${message.id}:person:${personId}`,
        occurredAt,
        source: 'OBSERVED_MESSAGE',
        matching: settings.matching,
        ctx,
      });
      outcomes[personId] = r.code;
      if (r.code === 'completed') anyCompleted = true;
      if (r.code === 'ignored_non_fo') anyNonFo = true;
    }
    if (anyCompleted) return { result: 'message_outbound_completed', details: outcomes };
    if (anyNonFo) return { result: 'ignored_non_fo', details: outcomes };
    return { result: 'message_outbound_touch', details: outcomes };
  }

  if (cls.direction === 'inbound') {
    let personId = cls.fromPersonId;
    if (!personId && cls.fromHandle) {
      const p = await prisma.personCache.findFirst({ where: { email: { equals: cls.fromHandle, mode: 'insensitive' } }, select: { id: true } });
      personId = p?.id ?? null;
    }
    if (!personId) return { result: 'ignored_inbound_unknown_sender' };
    await recordTouch({
      personId,
      channel: 'EMAIL',
      direction: 'INBOUND',
      occurredAt,
      summary: `Reply: ${subject}`,
      externalId: `message:${message.id}:person:${personId}`,
      actorLabel: cls.fromHandle,
    });
    const enrollment = await prisma.enrollment.findFirst({
      where: { personId, status: { in: [...OCCUPYING_STATUSES, 'REPLIED', 'MEETING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!enrollment) return { result: 'inbound_no_active_enrollment' };
    if (!OCCUPYING_STATUSES.includes(enrollment.status)) return { result: 'already_replied', details: { enrollmentId: enrollment.id, status: enrollment.status } };
    const r = await markReplied(enrollment.id, { at: occurredAt, evidenceId: `message:${message.id}`, actor: ctx.actor, skipSync: ctx.skipSync });
    return { result: r.changed ? 'replied' : 'already_replied', details: { enrollmentId: enrollment.id, pausedColleagues: r.pausedColleagues } };
  }

  return { result: 'ignored_message_unknown_direction', details: { reason: cls.reason } };
}

// ---------------------------------------------------------------------------
// Twenty tasks (mirrors) and opportunities
// ---------------------------------------------------------------------------

async function handleTwentyTask(t: TwentyTask, ctx: EngineContext, settings: Settings): Promise<ProcessOutcome> {
  const schema = await getTwentySchema();
  const task = await prisma.task.findFirst({ where: { OR: [{ twentyTaskId: t.id }, ...(t.cadenceTaskId ? [{ id: t.cadenceTaskId }] : [])] } });
  if (!task) return { result: 'ignored_not_cadence_task' };
  if (task.state !== 'PENDING') return { result: 'ignored_task_resolved' };
  if (t.status !== schema.taskStatus.done) return { result: 'twenty_task_open' };
  const r = await completeTask({ taskId: task.id, source: 'OBSERVED_TWENTY_TASK', evidenceId: `twentyTask:${t.id}`, occurredAt: new Date(t.updatedAt) }, ctx);
  void settings;
  return { result: r.ok ? 'twenty_task_done_completed' : `twenty_task_${r.reason}` };
}

async function handleTwentyTaskDeleted(twentyTaskId: string): Promise<ProcessOutcome> {
  const r = await prisma.task.updateMany({ where: { twentyTaskId, state: 'PENDING' }, data: { twentyTaskId: null } });
  return { result: r.count ? 'twenty_task_deleted_unlinked' : 'ignored_not_cadence_task' };
}

async function handleOpportunity(o: TwentyOpportunity, ctx: EngineContext, settings: Settings): Promise<ProcessOutcome> {
  if (!settings.rules.meetingOnOpportunityCreated) return { result: 'ignored_opportunity_disabled' };
  const candidates: string[] = [];
  if (o.pointOfContactId) candidates.push(o.pointOfContactId);
  if (!candidates.length) return { result: 'ignored_opportunity_no_contact' };
  const enrollment = await prisma.enrollment.findFirst({ where: { personId: { in: candidates }, status: { in: [...OCCUPYING_STATUSES, 'REPLIED'] } } });
  if (!enrollment) return { result: 'opportunity_no_active_enrollment' };
  await recordTouch({
    personId: enrollment.personId,
    channel: channelOf('CALL'),
    direction: 'INBOUND',
    occurredAt: new Date(o.createdAt),
    summary: `Opportunity created: ${o.name}`,
    externalId: `opportunity:${o.id}`,
  });
  const r = await markMeeting(enrollment.id, { at: new Date(o.createdAt), evidenceId: `opportunity:${o.id}`, actor: ctx.actor, skipSync: ctx.skipSync });
  return { result: r.changed ? 'meeting_from_opportunity' : 'already_meeting', details: { enrollmentId: enrollment.id } };
}

/** Recent events for the activity log. */
export async function recentEvents(limit = 100, onlyReview = false) {
  return prisma.activityEvent.findMany({ where: onlyReview ? { needsReview: true } : {}, orderBy: { receivedAt: 'desc' }, take: limit });
}

export async function resolveReview(eventId: string, actor: AuditActor, note?: string) {
  await prisma.activityEvent.update({ where: { id: eventId }, data: { needsReview: false, reviewNote: note ?? 'reviewed' } });
  await logAudit({ entityType: 'event', entityId: eventId, action: 'reviewed', actor, details: { note: note ?? null } });
}
