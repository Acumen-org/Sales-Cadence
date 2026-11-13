import { CallDirection, CallStatus, CampaignAudience, CampaignStatus, Channel, EnrollmentStatus, NextActionState, Prisma, Role, SandboxStatus, TaskState } from '@prisma/client';
import { prisma } from '../db';
import type { Scope } from './keys';

/**
 * What the read API serves (CONTRACT.md, Cadence scopes). Each resource names its scope, the column
 * `updatedSince` reads, its filters, and an explicit `select`: a field nobody listed here is never
 * sent, so a column added to the schema later stays private until someone adds it on purpose.
 * Never here: password hashes, Microsoft ids, Twenty's raw payloads, email drafts, call recordings,
 * suppression hashes, settings.
 */

type Where = Record<string, unknown>;
export type FindArgs = { where: Where; orderBy: Record<string, 'asc'>[]; take: number };
/** A filter's where clause, or the problem with the value. */
type Filter = { describe: string; where: (value: string) => Where | { problem: string } };

export type Resource = {
  path: string;
  scope: Scope;
  /** The column `updatedSince` and its ordering read. */
  changed: string;
  filters: Record<string, Filter>;
  /** Values a filter takes when the caller leaves it out (deleted records stay out unless asked for). */
  defaults?: Record<string, string>;
  find: (a: FindArgs) => Promise<object[]>;
  one: (id: string) => Promise<object | null>;
  /** Long fields left out of lists and sent only for one record. */
  oneOnly?: string;
};

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const eq = (field: string, describe: string): Filter => ({ describe, where: (v) => ({ [field]: v }) });
const oneOf = (field: string, values: readonly string[], describe = `One of ${values.join(', ')}`): Filter => ({
  describe,
  where: (v) => (values.includes(v) ? { [field]: v } : { problem: `Give one of ${values.join(', ')}.` }),
});
const bool = (field: string, describe: string): Filter => ({
  describe,
  where: (v) => (v === 'true' ? { [field]: true } : v === 'false' ? { [field]: false } : { problem: 'Give true or false.' }),
});
const deleted: Filter = {
  describe: 'exclude (default), include or only: records deleted in the CRM',
  where: (v) => (v === 'exclude' ? { deletedAt: null } : v === 'include' ? {} : v === 'only' ? { deletedAt: { not: null } } : { problem: 'Give exclude, include or only.' }),
};
const instant = (field: string, op: 'gte' | 'lt', describe: string): Filter => ({
  describe,
  where: (v) => {
    const d = new Date(v);
    return /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(d.getTime()) ? { [field]: { [op]: d } } : { problem: 'Give an ISO 8601 date or time.' };
  },
});
const localDate = (field: string, op: 'gte' | 'lte', describe: string): Filter => ({
  describe,
  where: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? { [field]: { [op]: v } } : { problem: 'Give a date as YYYY-MM-DD.' }),
});
const audience = oneOf('audience', Object.values(CampaignAudience), 'CRM or COLD');

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const pick = <T extends string>(...fields: T[]) => Object.fromEntries(fields.map((f) => [f, true])) as Record<T, true>;

const USER = { ...pick('id', 'email', 'name', 'role', 'active', 'timezone', 'twentyMemberId', 'dailyCap', 'createdAt', 'updatedAt'), pods: { select: { podId: true } } };
const POD = { ...pick('id', 'name', 'podOwnerValue', 'archived', 'discoveredAt', 'createdAt', 'updatedAt'), users: { select: { userId: true } } };
const PERSON = pick(
  'id', 'firstName', 'lastName', 'email', 'phone', 'phoneE164', 'additionalPhone', 'additionalPhoneE164', 'linkedinUrl', 'xUrl', 'jobTitle', 'companyId', 'companyName', 'city',
  'ownerMemberId', 'podOwner', 'dnd', 'dndReason', 'leadSourceNotes', 'tier', 'listCategory', 'previousCadence', 'pipelineStage', 'primaryProduct', 'onCallingList',
  'dealSignalStrength', 'emailMissing', 'phoneMissing', 'rotatedTo', 'rotationChangedAt', 'nextAction', 'nextActionDueDate', 'nextStep', 'nextActionDueDatePoc', 'lastNote',
  'lastCallAt', 'lastEmailAt', 'meetingUrl', 'bookingId', 'createdBySource', 'createdByName', 'optedOut', 'optedOutAt', 'optOutSource', 'optOutLiftedAt', 'badEmail', 'badPhone',
  'twentyUpdatedAt', 'deletedAt', 'syncedAt',
);
const COMPANY = pick('id', 'name', 'domain', 'ownerMemberId', 'industry', 'employees', 'aum', 'city', 'linkedinUrl', 'twentyUpdatedAt', 'deletedAt', 'syncedAt');
const SEQUENCE = pick('id', 'name', 'description', 'archived', 'campaignOwned', 'repeatEveryDays', 'durationDays', 'steps', 'createdAt', 'updatedAt');
const CAMPAIGN = pick(
  'id', 'name', 'sequenceId', 'podId', 'sourceType', 'sourceRef', 'assignmentMode', 'startDate', 'endDate', 'startsPerFoPerDay', 'hardStopAtEnd', 'status', 'description',
  'followupSourceId', 'followupSourceRun', 'followupWaitDays', 'approvedAt', 'approvedById', 'runNumber', 'audience', 'createdById', 'createdAt', 'updatedAt',
);
const ENROLLMENT = pick(
  'id', 'personId', 'sandboxContactId', 'companyId', 'foUserId', 'podId', 'campaignId', 'campaignRun', 'cycle', 'sequenceId', 'startDate', 'currentStep', 'currentStepId',
  'shiftDays', 'status', 'exitReason', 'pausedAt', 'pauseReason', 'repliedAt', 'meetingAt', 'completedAt', 'exitedAt', 'audience', 'createdById', 'createdAt', 'updatedAt',
);
const TASK = pick(
  'id', 'enrollmentId', 'foUserId', 'stepIndex', 'stepId', 'stepDay', 'actionIndex', 'actionId', 'action', 'chosenAction', 'label', 'dueDate', 'dueAt', 'plannedDate',
  'snoozedTo', 'state', 'completedAt', 'completedById', 'completionSource', 'evidenceId', 'skipReason', 'cancelReason', 'disposition', 'note', 'twentyTaskId', 'twentyNoteId',
  'createdAt', 'updatedAt',
);
const NEXT_ACTION = pick(
  'id', 'personId', 'sandboxContactId', 'foUserId', 'label', 'action', 'kind', 'meetingAt', 'dueDate', 'repeat', 'state', 'createdById', 'completedById', 'doneCount',
  'lastDoneAt', 'closedAt', 'crmPending', 'crmSyncedAt', 'audience', 'createdAt', 'updatedAt',
);
const TOUCH = pick('id', 'personId', 'sandboxContactId', 'channel', 'direction', 'occurredAt', 'summary', 'externalId', 'actorUserId', 'actorLabel', 'countedForTaskId', 'audience', 'copyOfTouchId', 'createdAt');
const CALL = pick(
  'id', 'source', 'direction', 'twilioCallSid', 'fromNumber', 'toNumber', 'status', 'twilioStatus', 'startedAt', 'endedAt', 'talkSec', 'priceUsd', 'userId', 'podId',
  'personId', 'sandboxContactId', 'matchedBy', 'taskId', 'nextActionId', 'enrollmentId', 'campaignId', 'touchId', 'recordingSec', 'recordingCount', 'formDueAt', 'formDoneAt',
  'formUserId', 'discardedAt', 'discardReason', 'audience', 'importedAt', 'createdAt', 'updatedAt',
);
const MEETING = pick(
  'id', 'title', 'provider', 'sourceUrl', 'occurredAt', 'durationSec', 'companyId', 'companyName', 'notes', 'meetingNumber', 'analysis', 'analysisStatus', 'analysedAt',
  'createdById', 'bookedById', 'review', 'reviewedById', 'reviewedAt', 'twentyMeetingId', 'createdAt', 'updatedAt',
);
const COLD_CONTACT = pick(
  // V08: every way to reach the person Cadence holds, with what it knows of them, as the record shows it.
  'id', 'status', 'source', 'firstName', 'lastName', 'jobTitle', 'email', 'additionalEmails', 'emailIsRole', 'emailVerification', 'phone', 'phoneType', 'phoneExtension', 'additionalPhones',
  'designations', 'tags', 'productInterest',
  'linkedinUrl', 'city', 'state', 'country', 'individualCrd', 'companyName', 'companyDomain', 'companyWebsite', 'companyCrd', 'companyCity', 'companyState', 'companyCountry',
  'companyPhone', 'companyAumUsd', 'companyEmployees', 'ownerId', 'podId', 'claimedAt', 'firstClaimedAt', 'bellwetherContactId', 'bellwetherUrl', 'sourceNote', 'collectedAt',
  'pushedByEmail', 'pushedByName', 'createdById', 'badEmail', 'badPhone', 'possibleBounceAt', 'optedOutAt', 'optOutReason', 'optOutSource', 'optOutLiftedAt', 'removedById',
  'removedReason', 'lastOutcome', 'lastOutcomeAt', 'erasedAt', 'lawfulBasis', 'lastActivityAt', 'statusChangedAt', 'movedAt', 'movedById', 'twentyPersonId', 'twentyCompanyId',
  'piiClearedAt', 'createdAt', 'updatedAt',
);
const COLD_NOTE = pick('id', 'sandboxContactId', 'authorId', 'authorName', 'body', 'twentyNoteId', 'createdAt');
// The suppressed value itself is only kept hashed; the label is what a person reads.
const SUPPRESSION = pick('id', 'kind', 'label', 'reason', 'source', 'sandboxContactId', 'personId', 'createdById', 'createdAt');

// Prisma's per-model argument types differ; each resource hands its own delegate the generic args.
/* eslint-disable @typescript-eslint/no-explicit-any */
const args = (a: FindArgs, select: object): any => ({ where: a.where, orderBy: a.orderBy, take: a.take, select });
const byId = (select: object): any => (id: string) => ({ where: { id }, select });
/* eslint-enable @typescript-eslint/no-explicit-any */

const users = (rows: object[]) => (rows as { pods: { podId: string }[] }[]).map(({ pods, ...u }) => ({ ...u, podIds: pods.map((p) => p.podId) }));
const pods = (rows: object[]) => (rows as { users: { userId: string }[] }[]).map(({ users: members, ...p }) => ({ ...p, userIds: members.map((m) => m.userId) }));
const first = <T>(rows: T[]) => rows[0] ?? null;

export const RESOURCES: Resource[] = [
  {
    path: 'users', scope: 'team', changed: 'updatedAt',
    filters: { active: bool('active', 'true or false'), role: oneOf('role', Object.values(Role)) },
    find: async (a) => users(await prisma.user.findMany(args(a, USER))),
    one: async (id) => first(users(await prisma.user.findMany(byId(USER)(id)))),
  },
  {
    path: 'pods', scope: 'team', changed: 'updatedAt',
    filters: { archived: bool('archived', 'true or false') },
    find: async (a) => pods(await prisma.pod.findMany(args(a, POD))),
    one: async (id) => first(pods(await prisma.pod.findMany(byId(POD)(id)))),
  },
  {
    path: 'people', scope: 'crm', changed: 'syncedAt',
    filters: { deleted, podOwner: eq('podOwner', 'The pod value in Twenty, e.g. ALISA'), ownerMemberId: eq('ownerMemberId', 'Twenty workspace member id of Assigned To'), companyId: eq('companyId', 'Company id'), optedOut: bool('optedOut', 'true or false') },
    defaults: { deleted: 'exclude' },
    find: (a) => prisma.personCache.findMany(args(a, PERSON)),
    one: (id) => prisma.personCache.findUnique(byId(PERSON)(id)),
  },
  {
    path: 'companies', scope: 'crm', changed: 'syncedAt',
    filters: { deleted, ownerMemberId: eq('ownerMemberId', 'Twenty workspace member id of the owner') },
    defaults: { deleted: 'exclude' },
    find: (a) => prisma.companyCache.findMany(args(a, COMPANY)),
    one: (id) => prisma.companyCache.findUnique(byId(COMPANY)(id)),
  },
  {
    path: 'sequences', scope: 'campaigns', changed: 'updatedAt',
    filters: { archived: bool('archived', 'true or false') },
    find: (a) => prisma.sequence.findMany(args(a, SEQUENCE)),
    one: (id) => prisma.sequence.findUnique(byId(SEQUENCE)(id)),
  },
  {
    path: 'campaigns', scope: 'campaigns', changed: 'updatedAt',
    filters: { status: oneOf('status', Object.values(CampaignStatus)), podId: eq('podId', 'Pod id'), audience },
    find: (a) => prisma.campaign.findMany(args(a, CAMPAIGN)),
    one: (id) => prisma.campaign.findUnique(byId(CAMPAIGN)(id)),
  },
  {
    path: 'enrollments', scope: 'campaigns', changed: 'updatedAt',
    filters: { status: oneOf('status', Object.values(EnrollmentStatus)), campaignId: eq('campaignId', 'Campaign id'), foUserId: eq('foUserId', 'User id of the rep'), podId: eq('podId', 'Pod id'), personId: eq('personId', 'Person id'), audience },
    find: (a) => prisma.enrollment.findMany(args(a, ENROLLMENT)),
    one: (id) => prisma.enrollment.findUnique(byId(ENROLLMENT)(id)),
  },
  {
    path: 'tasks', scope: 'tasks', changed: 'updatedAt',
    filters: { state: oneOf('state', Object.values(TaskState)), foUserId: eq('foUserId', 'User id of the rep'), enrollmentId: eq('enrollmentId', 'Enrollment id'), dueFrom: localDate('dueDate', 'gte', 'Due on or after, YYYY-MM-DD'), dueTo: localDate('dueDate', 'lte', 'Due on or before, YYYY-MM-DD') },
    find: (a) => prisma.task.findMany(args(a, TASK)),
    one: (id) => prisma.task.findUnique(byId(TASK)(id)),
  },
  {
    path: 'next-actions', scope: 'tasks', changed: 'updatedAt',
    filters: { state: oneOf('state', Object.values(NextActionState)), foUserId: eq('foUserId', 'User id of the rep'), personId: eq('personId', 'Person id'), audience },
    find: (a) => prisma.nextAction.findMany(args(a, NEXT_ACTION)),
    one: (id) => prisma.nextAction.findUnique(byId(NEXT_ACTION)(id)),
  },
  {
    path: 'touches', scope: 'activity', changed: 'createdAt',
    filters: { channel: oneOf('channel', Object.values(Channel)), personId: eq('personId', 'Person id'), sandboxContactId: eq('sandboxContactId', 'Cold contact id'), from: instant('occurredAt', 'gte', 'Happened at or after'), to: instant('occurredAt', 'lt', 'Happened before'), audience },
    find: (a) => prisma.touch.findMany(args(a, TOUCH)),
    one: (id) => prisma.touch.findUnique(byId(TOUCH)(id)),
  },
  {
    path: 'calls', scope: 'activity', changed: 'updatedAt',
    filters: { userId: eq('userId', 'User id of the rep'), personId: eq('personId', 'Person id'), status: oneOf('status', Object.values(CallStatus)), direction: oneOf('direction', Object.values(CallDirection)), from: instant('startedAt', 'gte', 'Started at or after'), to: instant('startedAt', 'lt', 'Started before'), audience },
    find: (a) => prisma.callLog.findMany(args(a, CALL)),
    one: (id) => prisma.callLog.findUnique(byId(CALL)(id)),
  },
  {
    // S03: a scope of its own, and only approved meetings, as the screens show them.
    path: 'meetings', scope: 'meetings', changed: 'updatedAt', oneOnly: 'transcript',
    filters: { companyId: eq('companyId', 'Company id'), from: instant('occurredAt', 'gte', 'Held at or after'), to: instant('occurredAt', 'lt', 'Held before') },
    find: (a) => prisma.meeting.findMany(args({ ...a, where: { ...a.where, review: 'APPROVED' } }, MEETING)),
    one: (id) => prisma.meeting.findFirst({ where: { id, review: 'APPROVED' }, select: { ...MEETING, transcript: true, transcriptFormat: true } }),
  },
  {
    path: 'cold-outreach/contacts', scope: 'cold-outreach', changed: 'updatedAt',
    filters: { status: oneOf('status', Object.values(SandboxStatus)), ownerId: eq('ownerId', 'User id of the owner'), podId: eq('podId', 'Pod id'), bellwetherContactId: eq('bellwetherContactId', 'Bellwether contact id') },
    find: (a) => prisma.sandboxContact.findMany(args(a, COLD_CONTACT)),
    one: (id) => prisma.sandboxContact.findUnique(byId(COLD_CONTACT)(id)),
  },
  {
    path: 'cold-outreach/notes', scope: 'cold-outreach', changed: 'createdAt',
    filters: { sandboxContactId: eq('sandboxContactId', 'Cold contact id') },
    find: (a) => prisma.sandboxNote.findMany(args(a, COLD_NOTE)),
    one: (id) => prisma.sandboxNote.findUnique(byId(COLD_NOTE)(id)),
  },
  {
    path: 'suppressions', scope: 'cold-outreach', changed: 'createdAt',
    filters: { kind: eq('kind', 'email, phone, domain …'), sandboxContactId: eq('sandboxContactId', 'Cold contact id'), personId: eq('personId', 'Person id') },
    find: (a) => prisma.suppression.findMany(args(a, SUPPRESSION)),
    one: (id) => prisma.suppression.findUnique(byId(SUPPRESSION)(id)),
  },
];

/** Times as ISO 8601, money and other decimals as numbers; everything else as Prisma read it. */
export function toJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toNumber();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  return value;
}
