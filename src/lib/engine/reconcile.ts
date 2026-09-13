import { prisma } from '../db';
import { logAudit, RECONCILE_ACTOR, type AuditActor } from '../audit';
import { refreshPersonCache } from '../person-cache';
import { getSettings } from '../settings';
import { getTwentyClient, type TwentyClient } from '../twenty';
import { paginate } from '../twenty/client';
import { ingestEvent, type IngestResult } from './ingest';

export type ReconcileStats = {
  since: string;
  people: number;
  /** Records Twenty returned that could not be cached, and the first reason. */
  cacheFailed: number;
  cacheError: string | null;
  notes: number;
  messages: number;
  opportunities: number;
  tasks: number;
  processed: number;
  duplicates: number;
  completions: number;
  replies: number;
  meetings: number;
  errors: number;
  needsReview: number;
  /** A pass that stopped part-way, by stage (`people`, `notes`, `cache.companies`...). The other passes still ran. */
  stageErrors: Record<string, string>;
};

function tally(stats: ReconcileStats, r: IngestResult) {
  if (r.status === 'duplicate') stats.duplicates += 1;
  else if (r.status === 'error') stats.errors += 1;
  else stats.processed += 1;
  if (r.needsReview) stats.needsReview += 1;
  if (r.result.endsWith('_completed')) stats.completions += 1;
  if (r.result === 'replied') stats.replies += 1;
  if (r.result.startsWith('meeting_from')) stats.meetings += 1;
}

/**
 * Nightly and on-demand: re-scan Twenty activity for the last N days and run it through the
 * same ingestion pipeline as webhooks. Dedupe makes this safe to run any time.
 */
export async function reconcile(opts: { days?: number; since?: string; sinceByStage?: Record<string, string>; actor?: AuditActor; now?: Date; skipSync?: boolean } = {}, client?: TwentyClient): Promise<ReconcileStats> {
  const settings = await getSettings();
  const c = client ?? (await getTwentyClient());
  const days = opts.days ?? settings.rules.reconcileLookbackDays;
  const now = opts.now ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - days * 86_400_000).toISOString();
  const stageSince = (name: string) => opts.sinceByStage?.[name] ?? since;
  const actor = opts.actor ?? RECONCILE_ACTOR;
  const stats: ReconcileStats = { since, people: 0, notes: 0, messages: 0, opportunities: 0, tasks: 0, processed: 0, duplicates: 0, completions: 0, replies: 0, meetings: 0, errors: 0, needsReview: 0, cacheFailed: 0, cacheError: null, stageErrors: {} };
  const common = { source: 'RECONCILE' as const, now, skipSync: opts.skipSync };
  // Every pass is its own stage: a permission the API key lacks for messages, or an object the
  // workspace renamed, used to stop the whole reconcile at that point and leave the watermark
  // where it was, so the same failure repeated every minute and nothing after it ever ran.
  const stage = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      stats.stageErrors[name] = err instanceof Error ? err.message : String(err);
      console.warn(`[reconcile] ${name} stopped: ${stats.stageErrors[name]}`);
    }
  };

  // People first so dnd flips and new people are known before activity is matched.
  const cache = await refreshPersonCache(c, { since, sinceByStage: Object.fromEntries(['people', 'companies', 'deletedPeople', 'deletedCompanies'].map((name) => [name, stageSince(`cache.${name}`)])) });
  stats.people = cache.people;
  stats.cacheFailed = cache.failed;
  stats.cacheError = cache.firstError;
  for (const [name, message] of Object.entries(cache.stageErrors)) if (message) stats.stageErrors[`cache.${name}`] = message;
  await stage('people', async () => {
    for await (const person of paginate((after) => c.listPeople({ updatedSince: stageSince('people'), after, limit: 100, includeDeleted: true }))) {
      tally(stats, await ingestEvent({ ...common, objectType: 'person', eventName: person.deletedAt ? 'person.deleted' : 'person.updated', record: (person.raw as Record<string, unknown> | undefined) ?? rawFromPerson(person), recordId: person.id, updatedAt: person.updatedAt }, c));
    }
  });

  // Soft deletes do not touch updatedAt, so they need their own pass: a deleted person exits
  // their sequence the same way a webhook would have made them.
  await stage('deletedPeople', async () => {
    for await (const person of paginate((after) => c.listPeople({ deletedSince: stageSince('deletedPeople'), after, limit: 100 }))) {
      tally(stats, await ingestEvent({ ...common, objectType: 'person', eventName: 'person.deleted', record: (person.raw as Record<string, unknown> | undefined) ?? rawFromPerson(person), recordId: person.id, updatedAt: person.deletedAt ?? person.updatedAt }, c));
    }
  });

  await stage('notes', async () => {
    for await (const note of paginate((after) => c.listNotes({ updatedSince: stageSince('notes'), after, limit: 100 }))) {
      stats.notes += 1;
      tally(stats, await ingestEvent({ ...common, objectType: 'note', eventName: 'note.updated', record: rawFromNote(note), recordId: note.id, updatedAt: note.updatedAt }, c));
    }
  });

  await stage('messages', async () => {
    for await (const message of paginate((after) => c.listMessages({ updatedSince: stageSince('messages'), after, limit: 100 }))) {
      stats.messages += 1;
      tally(stats, await ingestEvent({ ...common, objectType: 'message', eventName: 'message.updated', record: rawFromMessage(message), recordId: message.id, updatedAt: message.updatedAt }, c));
    }
  });

  await stage('opportunities', async () => {
    for await (const opp of paginate((after) => c.listOpportunities({ updatedSince: stageSince('opportunities'), after, limit: 100 }))) {
      stats.opportunities += 1;
      tally(stats, await ingestEvent({ ...common, objectType: 'opportunity', eventName: 'opportunity.updated', record: rawFromOpportunity(opp), recordId: opp.id, updatedAt: opp.updatedAt }, c));
    }
  });

  await stage('tasks', async () => {
    for await (const task of paginate((after) => c.listTasks({ updatedSince: stageSince('tasks'), after, limit: 100 }))) {
      stats.tasks += 1;
      tally(stats, await ingestEvent({ ...common, objectType: 'task', eventName: 'task.updated', record: rawFromTask(task), recordId: task.id, updatedAt: task.updatedAt }, c));
    }
  });

  await prisma.setting.upsert({ where: { key: 'lastReconcile' }, create: { key: 'lastReconcile', value: { at: now.toISOString(), stats } }, update: { value: { at: now.toISOString(), stats } } });
  await logAudit({ entityType: 'settings', entityId: 'reconcile', action: 'reconcile_ran', actor, details: stats });
  return stats;
}

// The ingest pipeline normalises raw records; normalised fixtures are re-expressed in the default
// field shapes so the same code path is exercised for webhooks, reconcile and the mock.
import type { TwentyCompany, TwentyMessage, TwentyNote, TwentyOpportunity, TwentyPerson, TwentyTask } from '../twenty/types';
import { defaultTwentySchema } from '../twenty/twenty-schema';

export function rawFromPerson(p: TwentyPerson): Record<string, unknown> {
  return {
    id: p.id,
    name: { firstName: p.firstName, lastName: p.lastName },
    emails: { primaryEmail: p.email, additionalEmails: p.additionalEmails },
    phones: { primaryPhoneNumber: p.phone },
    linkedinLink: { primaryLinkUrl: p.linkedinUrl },
    additionalNumber: { primaryPhoneNumber: p.additionalPhone },
    xLink: { primaryLinkUrl: p.xUrl },
    jobTitle: p.jobTitle,
    city: p.city,
    companyId: p.companyId,
    company: p.companyId ? { id: p.companyId, name: p.companyName } : null,
    createdBy: { source: p.createdBySource, name: p.createdByName, workspaceMemberId: p.createdByMemberId },
    assignedToId: p.ownerMemberId,
    podOwner: p.podOwner,
    rotationTracking: p.rotatedTo,
    rotationChangedAt: p.rotationChangedAt,
    // dnd is a select: round-trip the value that set it, or the default one when a caller
    // (a test, a fixture) only said "true". Emitting a bare boolean would read back as false.
    dnd: p.dndReason ?? (p.dnd ? defaultTwentySchema.personValues.dnd[0] : null),
    tags: p.tags,
    leadSource: p.leadSource,
    leadSourceNotes: p.leadSourceNotes,
    tier: p.tier,
    contactType: p.contactType,
    listCategory: p.listCategory,
    previousCadence: p.previousCadence,
    pipelineStageField: p.pipelineStage,
    productInterest: p.productInterest,
    primaryProduct: p.primaryProduct,
    onGoingCampaigns: p.campaigns,
    alisaCallingList: p.onCallingList,
    dealSignalStrength: p.dealSignalStrength,
    nextAction: p.nextAction,
    nextActionDueDate: p.nextActionDueDate,
    nextStep: p.nextStep,
    nextActionDueDatePoc: p.nextActionDueDatePoc,
    lastNote: p.lastNote,
    latestCallActivity: p.lastCallAt,
    lastEmailActivity: p.lastEmailAt,
    salesCallRecordingLink: { primaryLinkUrl: p.recordingUrl },
    meetingLink: { primaryLinkUrl: p.meetingUrl },
    bookingId: p.bookingId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    deletedAt: p.deletedAt,
  };
}

/** Shape a cached company the way Twenty's GraphQL returns one, for the ingest path. */
export function rawFromCompany(c: TwentyCompany): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    domainName: { primaryLinkUrl: c.domain },
    accountOwnerId: c.ownerMemberId,
    industry: c.industry,
    employees: c.employees,
    address: { addressCity: c.city },
    linkedinLink: { primaryLinkUrl: c.linkedinUrl },
    updatedAt: c.updatedAt,
    deletedAt: c.deletedAt,
  };
}

export function rawFromNote(n: TwentyNote): Record<string, unknown> {
  return {
    id: n.id,
    title: n.title,
    bodyV2: { markdown: n.bodyMarkdown },
    createdBy: { workspaceMemberId: n.createdByMemberId, name: n.createdByName, source: n.createdBySource },
    noteTargets: [...n.personIds.map((personId) => ({ personId })), ...n.companyIds.map((companyId) => ({ companyId }))],
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

export function rawFromMessage(m: TwentyMessage): Record<string, unknown> {
  return {
    id: m.id,
    subject: m.subject,
    text: m.text,
    receivedAt: m.receivedAt,
    messageThreadId: m.threadId,
    messageParticipants: m.participants.map((p) => ({ id: p.id, messageId: p.messageId, role: p.role, handle: p.handle, displayName: p.displayName, personId: p.personId, workspaceMemberId: p.workspaceMemberId })),
    updatedAt: m.updatedAt,
  };
}

export function rawFromOpportunity(o: TwentyOpportunity): Record<string, unknown> {
  return { id: o.id, name: o.name, stage: o.stage, pointOfContactId: o.pointOfContactId, companyId: o.companyId, createdAt: o.createdAt, updatedAt: o.updatedAt };
}

export function rawFromTask(t: TwentyTask): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    bodyV2: { markdown: t.bodyMarkdown },
    status: t.status,
    dueAt: t.dueAt,
    assigneeId: t.assigneeMemberId,
    taskTargets: t.personIds.map((personId) => ({ personId })),
    cadenceTaskId: t.cadenceTaskId,
    createdBy: { workspaceMemberId: t.createdByMemberId },
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
