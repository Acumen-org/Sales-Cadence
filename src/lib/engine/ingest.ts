import type { ActivityEvent, EventSource, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logAudit, webhookActor, RECONCILE_ACTOR, type AuditActor } from '../audit';
import { markCompanyDeleted, markPersonDeleted, upsertCompanyCache, upsertPersonCache } from '../person-cache';
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
import { actionTypesFor, classifyMessage, classifyNoteTitle, isInternalAddress, resolveNoteActor, type UserLike } from './matching';
import { completeTask, type EngineContext } from './tasks';
import { closeFromTouch } from './observed-evidence';
import { closeEmailNextAction } from '../next-actions';
import { coldOnlyAddresses, coldTouchOf, recordColdReply, recordColdSent } from '../mail/cold-email';
import { asksToStop } from '../mail/stop-request';
import { optOutPerson } from '../sandbox/opt-out';

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
  /** Read it again even if it was read before: idempotent, for a one-off pass after a rule change. */
  reread?: boolean;
  /** The stored event's own key, when the sweep replays a row saved but never processed (N03). */
  dedupeKey?: string;
};

export type IngestResult = {
  status: 'processed' | 'duplicate' | 'ignored' | 'error';
  result: string;
  eventId?: string;
  needsReview?: boolean;
  details?: Record<string, unknown>;
};

export type ProcessOutcome = { result: string; needsReview?: boolean; reviewNote?: string; details?: Record<string, unknown> };

/**
 * N20: what is kept of an event. An email's text is read while it is processed (a reply asking to
 * stop) but never stored: Cadence's database is no archive of the CRM's mail. A replay of a stored
 * email (N03) reads it from the CRM again.
 */
const TEXT_OMITTED = '_cadenceTextOmitted';
function storedPayload(canonical: CanonicalObject, record: Record<string, unknown>, textField: string): Prisma.InputJsonValue {
  if (canonical !== 'message' || record[textField] == null) return record as Prisma.InputJsonValue;
  return { ...record, [textField]: null, [TEXT_OMITTED]: true } as Prisma.InputJsonValue;
}

/** N21: the objects Cadence acts on. Twenty's webhook sends every object; the rest are not stored. */
const HANDLED = new Set<string>(['person', 'company', 'note', 'noteTarget', 'message', 'messageParticipant', 'task', 'opportunity']);

/** N21: processed events older than this are deleted each night; the nightly re-read looks back 90 days at most. */
export const EVENT_RETENTION_DAYS = 120;

/** N21: forget processed events past the retention, in batches so no long lock is held. Needs-review rows stay. */
export async function pruneActivityEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000);
  let removed = 0;
  for (let i = 0; i < 50; i++) {
    const n = await prisma.$executeRaw`DELETE FROM "ActivityEvent" WHERE id IN (SELECT id FROM "ActivityEvent" WHERE "receivedAt" < ${cutoff} AND "needsReview" = false AND "result" IS NOT NULL LIMIT 5000)`;
    removed += n;
    if (n < 5000) break;
  }
  return removed;
}

export function dedupeKeyFor(objectType: string, recordId: string, updatedAt: string | null | undefined, eventName: string): string {
  if (eventName.endsWith('.deleted') || eventName.endsWith('.destroyed')) return `${objectType}:${recordId}:deleted:${updatedAt ?? eventName}`;
  return `${objectType}:${recordId}:${updatedAt ?? eventName}`;
}

/**
 * Results that mean Twenty sent the record before it was whole: a note not yet attached to its
 * person (the tools that log calls and emails attach the person a moment after the note), an email
 * whose people Twenty had not matched yet, or a read that failed. The same record seen again - the
 * sync's next listing, a later webhook - is read again rather than skipped as done, or that call or
 * email would never close its step.
 */
const INCOMPLETE = new Set(['ignored_note_no_person', 'ignored_note_not_found', 'ignored_outbound_no_person', 'message_outbound_partial', 'ignored_message_not_found', 'ignored_message_unknown_direction']);
export const isIncompleteResult = (result: string | null | undefined) => Boolean(result && (INCOMPLETE.has(result) || result.startsWith('error:')));

/**
 * N03: an event is saved first and processed second. A row still without a result this long after
 * it was saved (or last claimed) was cut off by a restart or a crash, not merely in progress.
 */
export const STALE_EVENT_MS = 10 * 60_000;
const isStaleClaim = (row: { result: string | null; receivedAt: Date; processedAt: Date | null }, now = Date.now()) =>
  row.result === null && (row.processedAt ?? row.receivedAt).getTime() < now - STALE_EVENT_MS;

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
  if (!HANDLED.has(canonical)) return { status: 'ignored', result: `ignored_object_${canonical}` };
  const deletionAt = (input.eventName.endsWith('.deleted') || input.eventName.endsWith('.destroyed')) && typeof input.record.deletedAt === 'string' ? input.record.deletedAt : null;
  const updatedAt = deletionAt ?? input.updatedAt ?? (typeof input.record.updatedAt === 'string' ? input.record.updatedAt : null);
  const dedupeKey = input.dedupeKey ?? dedupeKeyFor(canonical, recordId, updatedAt, input.eventName);

  const existing = await prisma.activityEvent.findUnique({ where: { dedupeKey }, select: { id: true, result: true, receivedAt: true, processedAt: true } });
  const stale = existing ? isStaleClaim(existing) : false;
  if (existing && !stale && !isIncompleteResult(existing.result) && !(input.reread && existing.result !== null)) return { status: 'duplicate', result: 'duplicate', eventId: existing.id, details: { dedupeKey } };

  let event: Pick<ActivityEvent, 'id'>;
  if (existing) {
    // Claimed on the result it had, so two readers arriving at once do not both read it again. A
    // row cut off before it had a result is claimed on its claim time, which the claim moves on.
    const claimed = await prisma.activityEvent.updateMany({
      where: { id: existing.id, result: existing.result, ...(stale ? { processedAt: existing.processedAt } : {}) },
      data: { source: input.source, eventName: input.eventName, payload: storedPayload(canonical, input.record, schema.message.text), processedAt: stale ? new Date() : null, result: null },
    });
    if (!claimed.count) return { status: 'duplicate', result: 'duplicate', eventId: existing.id, details: { dedupeKey } };
    event = existing;
  } else {
    try {
      event = await prisma.activityEvent.create({
        data: {
          source: input.source,
          objectType: canonical,
          eventName: input.eventName,
          externalId: recordId,
          externalUpdatedAt: updatedAt ? new Date(updatedAt) : null,
          dedupeKey,
          payload: storedPayload(canonical, input.record, schema.message.text),
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { status: 'duplicate', result: 'duplicate', details: { dedupeKey } };
      throw err;
    }
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

/**
 * N03: events saved but never processed (the app was restarted between the two) are processed now,
 * from the payload they were saved with. The worker runs this each pass; anything that fails is
 * marked for review in the Activity log, as any other failed event is.
 */
export async function sweepUnprocessedEvents(now = new Date(), limit = 50): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_EVENT_MS);
  const rows = await prisma.activityEvent.findMany({
    where: { result: null, receivedAt: { lt: cutoff }, OR: [{ processedAt: null }, { processedAt: { lt: cutoff } }] },
    orderBy: { receivedAt: 'asc' },
    take: limit,
  });
  let swept = 0;
  for (const row of rows) {
    const record = (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {}) as Record<string, unknown>;
    const out = await ingestEvent({ source: row.source, objectType: row.objectType, eventName: row.eventName, record, recordId: row.externalId, updatedAt: row.externalUpdatedAt?.toISOString() ?? null, dedupeKey: row.dedupeKey });
    if (out.status !== 'duplicate') swept += 1;
  }
  return swept;
}

async function process(type: CanonicalObject, input: IngestInput, ctx: EngineContext, settings: Settings, client?: TwentyClient): Promise<ProcessOutcome> {
  const schema = await getTwentySchema();
  const deleted = input.eventName.endsWith('.deleted') || input.eventName.endsWith('.destroyed');
  switch (type) {
    case 'person':
      return handlePerson(normalizePerson(input.record, schema), deleted, ctx);
    case 'company':
      return handleCompany(normalizeCompany(input.record, schema), deleted);
    case 'note': {
      if (deleted) return { result: 'ignored_deleted' };
      // A webhook carries a note without the people it is about: a logged call or email is read whole.
      const note = normalizeNote(input.record, schema);
      const kind = classifyNoteTitle(note.title, settings.matching).kind;
      const partial = !note.personIds.length && kind !== 'other' && kind !== 'cadence';
      return handleNote(partial ? ((await fetchNote(note.id, client).catch(() => null)) ?? note) : note, ctx, settings);
    }
    case 'noteTarget': {
      // The person a note is about arrives as its own record, just after the note: read the note again.
      if (deleted) return { result: 'ignored_deleted' };
      const personKeys = [schema.noteTarget.personId, 'targetPersonId'].filter((k) => k in input.record);
      if (personKeys.length && personKeys.every((k) => !input.record[k])) return { result: 'ignored_note_target_not_person' };
      const noteId = input.record[schema.noteTarget.noteId];
      if (typeof noteId !== 'string' || !noteId) return { result: 'ignored_no_note_id' };
      const note = await fetchNote(noteId, client);
      if (!note) return { result: 'ignored_note_not_found' };
      return handleNote(note, ctx, settings);
    }
    case 'message': {
      if (deleted) return { result: 'ignored_deleted' };
      const inline = normalizeMessage(input.record, schema);
      const full = inline.participants.length && !input.record[TEXT_OMITTED] ? inline : await fetchMessage(inline.id, client);
      if (!full) return { result: 'ignored_message_not_found' };
      return handleMessage(full, ctx, settings);
    }
    case 'messageParticipant': {
      if (deleted) return { result: 'ignored_deleted' };
      const p = normalizeParticipant(input.record, schema);
      if (!p.messageId) return { result: 'ignored_no_message_id' };
      const full = await fetchMessage(p.messageId, client);
      if (!full) return { result: 'ignored_message_not_found', needsReview: true, reviewNote: `message ${p.messageId} not found in the CRM` };
      return handleMessage(full, ctx, settings);
    }
    case 'task':
      if (deleted) return handleTwentyTaskDeleted(String(input.record.id));
      return handleTwentyTask(normalizeTask(input.record, schema), ctx, settings);
    case 'opportunity':
      if (deleted) return { result: 'ignored_deleted' };
      // N10: the rule is "a meeting when an opportunity is created": a later edit of an old one is not.
      if (!input.eventName.endsWith('.created')) return { result: 'ignored_opportunity_not_created' };
      return handleOpportunity(normalizeOpportunity(input.record, schema), ctx, settings);
    default:
      return { result: `ignored_object_${type}` };
  }
}

async function fetchMessage(id: string, client?: TwentyClient): Promise<TwentyMessage | null> {
  const c = client ?? (await getTwentyClient());
  return c.getMessage(id);
}

async function fetchNote(id: string, client?: TwentyClient): Promise<TwentyNote | null> {
  const c = client ?? (await getTwentyClient());
  return c.getNote(id);
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
    await markCompanyDeleted(company.id, company.deletedAt ? new Date(company.deletedAt) : new Date());
    return { result: 'company_deleted' };
  }
  const before = await prisma.companyCache.findUnique({ where: { id: company.id }, select: { name: true, ownerMemberId: true } });
  const current = await upsertCompanyCache(company);
  const renamed = before && before.name !== current.name;
  const reowned = before && before.ownerMemberId !== current.ownerMemberId;
  return {
    result: before ? (renamed || reowned ? 'company_updated' : 'company_unchanged') : 'company_cached',
    details: { name: current.name, ...(renamed ? { renamedFrom: before!.name } : {}), ...(reowned ? { ownerMemberId: current.ownerMemberId } : {}) },
  };
}

/**
 * A person changed in Twenty: refresh the cache and honour consent. Nothing on the person is
 * treated as evidence that a step happened or that a meeting was booked - that comes from
 * notes, messages, mirrored tasks and opportunities.
 */
async function handlePerson(person: TwentyPerson, deleted: boolean, ctx: EngineContext): Promise<ProcessOutcome> {
  if (deleted) {
    const at = person.deletedAt ? new Date(person.deletedAt) : ctx.now ?? new Date();
    const marked = await markPersonDeleted(person.id, at);
    if (!marked.count) return { result: 'person_unchanged' };
    const { exited } = await applyPersonFlags({ id: person.id, dnd: false, deletedAt: at.toISOString() }, ctx);
    return { result: exited.length ? 'person_deleted_exited' : 'person_deleted', details: { exited } };
  }
  const current = await upsertPersonCache(person);
  const { exited } = await applyPersonFlags({ id: current.id, dnd: current.dnd, deletedAt: current.deletedAt?.toISOString() ?? null }, ctx);
  if (exited.length) return { result: 'dnd_exited', details: { exited } };
  return { result: 'person_cached' };
}

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

/** Subjects mail systems write, not people: nothing to read and nothing answered. */
export const AUTO_REPLY_SUBJECT = /^(?:\s*(?:re|fwd?)\s*:\s*)*(?:automatic reply|auto(?:matic)?[- ]?reply|autoreply|auto response|out of (?:the )?office(?=\s*(?:[:\-–(]|until|till|through|thru|re\b|$))|ooo\b|undeliverable|delivery (?:status notification|failure|has failed)|mail delivery|message not delivered|read:|accepted:|declined:|tentative:)/i;
export const isAutomaticReply = (subject: string | null | undefined) => AUTO_REPLY_SUBJECT.test((subject ?? '').trim());

async function recordTouch(data: { personId: string; channel: 'EMAIL' | 'CALL' | 'LINKEDIN' | 'MEETING'; direction: 'OUTBOUND' | 'INBOUND'; occurredAt: Date; summary: string; externalId: string; actorUserId?: string | null; actorLabel?: string | null }) {
  const person = await prisma.personCache.findUnique({ where: { id: data.personId }, select: { id: true } });
  if (!person) return false;
  // One email counts once (PLAN 6, 8.14): Outlook tracking may hold this email already as a cold
  // contact's touch, the contact being "Also in CRM" as this person; then this record is its copy.
  const copyOf = data.channel === 'EMAIL' ? await coldTouchOf({ personId: data.personId, direction: data.direction, occurredAt: data.occurredAt, summary: data.summary }) : null;
  await prisma.touch.upsert({
    where: { externalId: data.externalId },
    create: { ...data, actorUserId: data.actorUserId ?? null, actorLabel: data.actorLabel ?? null, audience: 'CRM', copyOfTouchId: copyOf },
    update: { summary: data.summary, occurredAt: data.occurredAt },
  });
  return true;
}

/**
 * Close the earliest open step of one of `types` on the person's running campaign. An email or call
 * from our side counts whoever made it: the FO, a colleague writing from their own or a shared
 * mailbox, or a note the team's tools logged. A step counts what happened from its own date on, and
 * a touch counts once (observed-evidence.ts). Returns a result code.
 */
async function completeFromEvidence(params: {
  personId: string;
  types: Array<'EMAIL' | 'CALL'>;
  evidenceId: string;
  occurredAt: Date;
  /** What the touch says (the note title or "Email sent: <subject>"), to know the same email seen twice. */
  summary: string;
  source: 'OBSERVED_NOTE' | 'OBSERVED_MESSAGE';
  channel: 'EMAIL' | 'CALL';
  matching: MatchingSettings;
  ctx: EngineContext;
}): Promise<{ code: string; taskId?: string }> {
  const { channel } = params;
  return closeFromTouch({
    personId: params.personId,
    types: params.types,
    touch: { externalId: params.evidenceId, channel, occurredAt: params.occurredAt, summary: params.summary },
    source: params.source,
    matching: params.matching,
    ctx: params.ctx,
  });
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
    // N098: an email logged by a tool closes the Email next step due that day, as a synced one does.
    if (cls.kind === 'outbound_email') await closeEmailNextAction({ personId }, occurredAt, `note:${note.id}:person:${personId}`);
    if (!types.length) {
      outcomes[personId] = 'touch_only';
      continue;
    }
    const r = await completeFromEvidence({ personId, types, evidenceId: `note:${note.id}:person:${personId}`, occurredAt, summary: note.title, source: 'OBSERVED_NOTE', channel, matching: settings.matching, ctx });
    outcomes[personId] = r.code;
    if (r.code === 'completed') anyCompleted = true;
  }

  if (anyCompleted) return { result: `note_${cls.kind}_completed`, details: outcomes };
  // Logged by a tool or someone without a Cadence login: the touch counts all the same, only unnamed.
  return { result: `note_${cls.kind}_touch`, details: actor ? outcomes : { ...outcomes, loggedBy: note.createdByName ?? cls.actorHandle ?? null } };
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/**
 * Recipients Twenty has not matched to a person yet (a contact added after the email, a second
 * address): the person whose address it is, when exactly one person has it. Our own addresses
 * never count.
 */
async function recipientsByAddress(message: TwentyMessage, users: UserLike[], internalDomains: readonly string[], skip: ReadonlySet<string> = new Set()): Promise<{ ids: string[]; unresolved: number }> {
  const ours = new Set(users.flatMap((u) => [u.email, ...u.aliases]).map((a) => a.trim().toLowerCase()));
  const handles = [...new Set(message.participants.filter((p) => p.role !== 'from' && !p.personId && !p.workspaceMemberId).map((p) => (p.handle ?? '').trim().toLowerCase()))].filter(
    (h) => h.includes('@') && !ours.has(h) && !isInternalAddress(h, internalDomains) && !skip.has(h),
  );
  if (!handles.length) return { ids: [], unresolved: 0 };
  // Second addresses are stored as typed, so they are compared lower-cased on both sides.
  const people = await prisma.$queryRaw<Array<{ id: string; email: string | null; additionalEmails: string[] }>>`
    SELECT id, email, "additionalEmails" FROM "PersonCache"
    WHERE "deletedAt" IS NULL
      AND (lower(email) = ANY(${handles}::text[]) OR EXISTS (SELECT 1 FROM unnest("additionalEmails") a WHERE lower(a) = ANY(${handles}::text[])))`;
  const ids = handles.flatMap((h) => {
    const owners = people.filter((p) => p.email?.toLowerCase() === h || p.additionalEmails.some((a) => a.toLowerCase() === h));
    return owners.length === 1 ? [owners[0].id] : [];
  });
  return { ids, unresolved: handles.length - ids.length };
}

async function handleMessage(message: TwentyMessage, ctx: EngineContext, settings: Settings): Promise<ProcessOutcome> {
  const users = await loadUsers();
  const cls = classifyMessage(message, users, settings.rules.internalDomains);
  const occurredAt = new Date(message.receivedAt);
  const subject = message.subject ?? '(no subject)';

  if (cls.direction === 'outbound') {
    // N028: an address of a live cold contact with no real CRM person behind it (none, or only the
    // one Twenty's mail sync made for it, which the cleanup deletes) is the cold contact's email.
    const cold = await coldOnlyAddresses(message.participants.filter((p) => p.role !== 'from').map((p) => ({ handle: p.handle, personId: p.personId })));
    const coldPeople = new Set([...cold.values()].flat());
    const coldSent = cold.size ? await recordColdSent([...cold.keys()], { key: `message:${message.id}`, conversationId: message.threadId, subject: message.subject, at: occurredAt, mailboxUserId: cls.actor?.id ?? null, via: 'crm' }) : null;
    const coldDetails = coldSent ? { coldContacts: coldSent.recorded.length, coldAlerts: coldSent.alerts } : {};
    const byAddress = await recipientsByAddress(message, users, settings.rules.internalDomains, new Set(cold.keys()));
    const recipientPersonIds = [...new Set([...cls.recipientPersonIds, ...byAddress.ids])].filter((id) => !coldPeople.has(id));
    if (!recipientPersonIds.length) return coldSent ? { result: 'message_outbound_cold', details: coldDetails } : { result: 'ignored_outbound_no_person' };
    const outcomes: Record<string, string> = {};
    let anyCompleted = false;
    for (const personId of recipientPersonIds) {
      await recordTouch({
        personId,
        channel: 'EMAIL',
        direction: 'OUTBOUND',
        occurredAt,
        summary: `Email sent: ${subject}`,
        externalId: `message:${message.id}:person:${personId}`,
        actorUserId: cls.actor?.id ?? null,
        actorLabel: cls.actor?.name ?? cls.fromHandle,
      });
      const r = await completeFromEvidence({
        personId,
        types: ['EMAIL'],
        evidenceId: `message:${message.id}:person:${personId}`,
        occurredAt,
        summary: `Email sent: ${subject}`,
        source: 'OBSERVED_MESSAGE',
        channel: 'EMAIL',
        matching: settings.matching,
        ctx,
      });
      outcomes[personId] = r.code;
      if (r.code === 'completed') anyCompleted = true;
      // N098: the Email next step due that day closes too, by the rep's own date, as a cold one does.
      await closeEmailNextAction({ personId }, occurredAt, `message:${message.id}:person:${personId}`);
    }
    if (anyCompleted) return { result: 'message_outbound_completed', details: { ...outcomes, ...coldDetails } };
    // Someone it went to is not a contact yet (Twenty links them a moment later): read it again then.
    if (byAddress.unresolved) return { result: 'message_outbound_partial', details: { ...outcomes, ...coldDetails, unmatchedRecipients: byAddress.unresolved } };
    return { result: 'message_outbound_touch', details: { ...outcomes, ...coldDetails } };
  }

  if (cls.direction === 'inbound') {
    // N028: a cold contact's reply in the CRM's mail is theirs: it stops their campaign and rings
    // their rep, instead of landing on a person the cleanup then deletes with it.
    const from = (cls.fromHandle ?? '').trim().toLowerCase();
    const cold = from ? await coldOnlyAddresses([{ handle: from, personId: cls.fromPersonId }]) : new Map<string, string[]>();
    if (cold.size) {
      const automatic = isAutomaticReply(subject);
      // L02: a reply through the CRM carries its text too: a request to stop opts them out everywhere.
      const r = await recordColdReply(from, { key: `message:${message.id}`, conversationId: message.threadId, subject: message.subject, at: occurredAt, mailboxUserId: cls.recipientUsers[0]?.id ?? null, via: 'crm' }, automatic, !automatic && asksToStop(message.subject, message.text));
      return { result: automatic ? 'inbound_cold_automatic_reply' : r.optedOut ? 'inbound_cold_opt_out' : 'inbound_cold_reply', details: { coldContacts: r.contacts.length } };
    }
    let personId = cls.fromPersonId;
    if (!personId && cls.fromHandle) {
      const p = await prisma.personCache.findFirst({ where: { email: { equals: cls.fromHandle, mode: 'insensitive' } }, select: { id: true } });
      personId = p?.id ?? null;
    }
    if (!personId) return { result: 'ignored_inbound_unknown_sender' };
    // An out-of-office or "automatic reply" is a machine answering: it is recorded as what it is,
    // counts as no reply anywhere, and never finishes a sequence.
    const automatic = isAutomaticReply(subject);
    await recordTouch({
      personId,
      channel: 'EMAIL',
      direction: 'INBOUND',
      occurredAt,
      summary: `${automatic ? 'Auto-reply' : 'Reply'}: ${subject}`,
      externalId: `message:${message.id}:person:${personId}`,
      actorLabel: cls.fromHandle,
    });
    if (automatic) return { result: 'inbound_automatic_reply' };
    // L02: "stop emailing me" is an opt-out across every campaign (and the CRM's Do not contact), not one reply.
    if (asksToStop(message.subject, message.text)) {
      const r = await optOutPerson(personId, { source: 'email_reply', actor: ctx.actor, reason: `Replied asking not to be contacted: ${subject}`.slice(0, 300), now: occurredAt });
      return { result: 'inbound_opt_out', details: { personId, changed: r.changed } };
    }
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
    personId: enrollment.personId!,
    channel: 'MEETING',
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
