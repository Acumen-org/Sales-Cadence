import type { PersonCache, Prisma, SandboxContact } from '@prisma/client';
import { prisma } from './db';

/*
 * An enrollment, next action, task or touch is about a Twenty person, a sandbox contact, or both
 * (a sandbox contact that has since moved to the CRM). CRM views read only rows with a person;
 * the Sandbox section reads the rest. What is in the sandbox stays in the sandbox (decision 2 of
 * docs/outreach-sandbox-plan.md).
 */

/** Rows of a CRM view: enrollments, next actions and touches whose subject is a Twenty person. */
export const CRM_SUBJECT = { personId: { not: null } } satisfies Prisma.EnrollmentWhereInput & Prisma.NextActionWhereInput & Prisma.TouchWhereInput;
/** Tasks of a CRM view. */
export const CRM_TASK = { enrollment: CRM_SUBJECT } satisfies Prisma.TaskWhereInput;
/** Rows of the Sandbox section: a sandbox contact that has not moved. */
export const SANDBOX_SUBJECT = { sandboxContactId: { not: null }, personId: null } satisfies Prisma.EnrollmentWhereInput & Prisma.NextActionWhereInput & Prisma.TouchWhereInput;
export const SANDBOX_TASK = { enrollment: SANDBOX_SUBJECT } satisfies Prisma.TaskWhereInput;

/** Who a row is about, the same shape for either kind: what personalisation and labels read. */
export type Subject = {
  kind: 'person' | 'sandbox';
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  companyId: string | null;
  companyName: string | null;
  jobTitle: string | null;
  city: string | null;
  /** Do not contact: Twenty's dnd, Cadence's opt-out, or a sandbox contact that is not ACTIVE. */
  blocked: boolean;
  deleted: boolean;
};

type PersonLike = Pick<PersonCache, 'id' | 'firstName' | 'lastName' | 'email' | 'phone' | 'companyId' | 'companyName' | 'jobTitle' | 'city' | 'dnd' | 'optedOut' | 'deletedAt'>;
type SandboxLike = Pick<SandboxContact, 'id' | 'firstName' | 'lastName' | 'email' | 'phone' | 'companyName' | 'jobTitle' | 'city' | 'status'>;

export function personSubject(p: PersonLike): Subject {
  return { kind: 'person', id: p.id, firstName: p.firstName, lastName: p.lastName, email: p.email, phone: p.phone, companyId: p.companyId, companyName: p.companyName, jobTitle: p.jobTitle, city: p.city, blocked: p.dnd || p.optedOut, deleted: Boolean(p.deletedAt) };
}

export function sandboxSubject(c: SandboxLike): Subject {
  return { kind: 'sandbox', id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, companyId: null, companyName: c.companyName, jobTitle: c.jobTitle, city: c.city, blocked: c.status !== 'ACTIVE', deleted: c.status === 'REMOVED' };
}

/** The subject of a row that carries either relation. The person wins once a contact has moved. */
export function subjectOf(row: { person?: PersonLike | null; sandboxContact?: SandboxLike | null }): Subject {
  if (row.person) return personSubject(row.person);
  if (row.sandboxContact) return sandboxSubject(row.sandboxContact);
  throw new Error('This record has neither a person nor a sandbox contact.');
}

/** A CRM row's person. CRM queries filter with CRM_SUBJECT, so a missing person is a bug, said plainly. */
export function crmPerson<T>(person: T | null | undefined): T {
  if (!person) throw new Error('A sandbox contact reached a CRM view; CRM queries must filter with CRM_SUBJECT.');
  return person;
}

// ---------------------------------------------------------------------------
// The subject layer (cold outreach PLAN 8.13): one way for every list to name, link and filter the
// person or cold contact a row is about, so a cold row never links to a /people page that does not
// exist. New lists use these; CRM_SUBJECT and crmPerson() stop classifying rows (W14).
// ---------------------------------------------------------------------------

/** Who a row is about: a CRM person, or a cold contact (a SandboxContact). */
export type SubjectRef = { kind: 'person' | 'cold'; id: string };
export const personRef = (id: string): SubjectRef => ({ kind: 'person', id });
export const coldRef = (id: string): SubjectRef => ({ kind: 'cold', id });
export const refKey = (ref: SubjectRef) => `${ref.kind}:${ref.id}`;

/** The ref of a row that carries either column. The person wins once a contact has moved. */
export function refOf(row: { personId?: string | null; sandboxContactId?: string | null }): SubjectRef | null {
  if (row.personId) return personRef(row.personId);
  if (row.sandboxContactId) return coldRef(row.sandboxContactId);
  return null;
}

/**
 * Every row about this subject, for Touch, NextAction, Enrollment and CallLog. A cold contact's rows
 * include those from after it moved (they keep its id); a person's are theirs.
 */
export function subjectWhere(ref: SubjectRef): { personId: string } | { sandboxContactId: string } {
  return ref.kind === 'person' ? { personId: ref.id } : { sandboxContactId: ref.id };
}
/** The same for Tasks, which reach their subject through the enrollment. */
export const subjectTaskWhere = (ref: SubjectRef): Prisma.TaskWhereInput => ({ enrollment: subjectWhere(ref) });

/**
 * Where a cold contact's page lives. The section's pages are still under /sandbox; the stage that
 * builds /cold-outreach (S10) changes this one constant, and S11 redirects the old paths, so a link
 * made today keeps working.
 */
export const COLD_CONTACT_BASE = '/sandbox';

/** The page a subject opens on: the person's People page, or the cold contact's own page. */
export function subjectHref(ref: SubjectRef): string {
  return ref.kind === 'person' ? `/people/${ref.id}` : `${COLD_CONTACT_BASE}/${ref.id}`;
}

/**
 * One status per cold contact (PLAN 4.0): the list, the contact header, Tasks, search and the Move
 * dialog all show the badge this decides. Null for a CRM person who may be contacted.
 */
export type ContactState = 'unclaimed' | 'no_next_step' | 'in_campaign' | 'next_step_set' | 'closed' | 'ready_to_move' | 'already_in_crm' | 'moving' | 'moved' | 'do_not_contact' | 'removed';

/** What contactState reads. `positiveOutcome`: Connected with warm or hot interest, Meeting booked, or a reply (D3). */
export type ContactStateInput = {
  status: SandboxContact['status'];
  optedOutAt?: Date | null;
  ownerId: string | null;
  /** An owner who has left counts as no owner (N017). */
  ownerActive?: boolean;
  moving?: boolean;
  crmMatchPersonId?: string | null;
  crmAutoPersonId?: string | null;
  inCampaign?: boolean;
  hasNextStep?: boolean;
  lastOutcome?: string | null;
  detailsComplete?: boolean;
  positiveOutcome?: boolean;
};

/** Outcomes after which a contact is Closed until someone sets a new next step (D3). */
export const CLOSING_OUTCOMES = new Set(['not_interested', 'wrong_number']);

export function contactState(c: ContactStateInput): ContactState {
  if (c.status === 'OPTED_OUT' || (c.status !== 'MOVED' && c.optedOutAt)) return 'do_not_contact';
  if (c.status === 'REMOVED') return 'removed';
  if (c.status === 'MOVED') return 'moved';
  if (c.moving) return 'moving';
  if (c.crmMatchPersonId || c.crmAutoPersonId) return 'already_in_crm';
  if (!c.ownerId || c.ownerActive === false) return 'unclaimed';
  if (c.detailsComplete && c.positiveOutcome) return 'ready_to_move';
  if (c.inCampaign) return 'in_campaign';
  if (c.hasNextStep) return 'next_step_set';
  if (c.lastOutcome && CLOSING_OUTCOMES.has(c.lastOutcome)) return 'closed';
  return 'no_next_step';
}

/** A subject as a list row shows it: name, title, firm, owner, pod and state, from one batched load. */
export type LoadedSubject = Subject & {
  ref: SubjectRef;
  href: string;
  ownerId: string | null;
  ownerName: string | null;
  podId: string | null;
  podName: string | null;
  state: ContactState | null;
};

/** Load many subjects at once: a handful of queries per kind, whatever the number of rows. */
export async function loadSubjects(refs: SubjectRef[]): Promise<Map<string, LoadedSubject>> {
  const out = new Map<string, LoadedSubject>();
  const personIds = [...new Set(refs.filter((r) => r.kind === 'person').map((r) => r.id))];
  const coldIds = [...new Set(refs.filter((r) => r.kind === 'cold').map((r) => r.id))];
  if (personIds.length) {
    const people = await prisma.personCache.findMany({ where: { id: { in: personIds } } });
    const members = [...new Set(people.flatMap((p) => (p.ownerMemberId ? [p.ownerMemberId] : [])))];
    const podValues = [...new Set(people.flatMap((p) => (p.podOwner ? [p.podOwner] : [])))];
    const [owners, pods] = await Promise.all([
      members.length ? prisma.user.findMany({ where: { twentyMemberId: { in: members } }, select: { id: true, name: true, twentyMemberId: true } }) : [],
      podValues.length ? prisma.pod.findMany({ where: { podOwnerValue: { in: podValues } }, select: { id: true, name: true, podOwnerValue: true } }) : [],
    ]);
    for (const p of people) {
      const ref = personRef(p.id);
      const owner = owners.find((u) => u.twentyMemberId === p.ownerMemberId) ?? null;
      const pod = pods.find((x) => x.podOwnerValue === p.podOwner) ?? null;
      out.set(refKey(ref), { ...personSubject(p), ref, href: subjectHref(ref), ownerId: owner?.id ?? null, ownerName: owner?.name ?? null, podId: pod?.id ?? null, podName: pod?.name ?? null, state: p.dnd || p.optedOut ? 'do_not_contact' : null });
    }
  }
  if (coldIds.length) {
    const [contacts, moving, campaigns, nexts] = await Promise.all([
      prisma.sandboxContact.findMany({ where: { id: { in: coldIds } }, include: { owner: { select: { name: true, active: true } }, pod: { select: { name: true } } } }),
      prisma.sandboxMoveItem.findMany({ where: { sandboxContactId: { in: coldIds }, state: { in: ['QUEUED', 'RUNNING'] } }, select: { sandboxContactId: true } }),
      prisma.enrollment.findMany({ where: { sandboxContactId: { in: coldIds }, personId: null, status: { in: ['ACTIVE', 'PAUSED'] } }, select: { sandboxContactId: true } }),
      prisma.nextAction.findMany({ where: { sandboxContactId: { in: coldIds }, personId: null, state: 'OPEN' }, select: { sandboxContactId: true } }),
    ]);
    const movingIds = new Set(moving.map((m) => m.sandboxContactId));
    const inCampaign = new Set(campaigns.map((e) => e.sandboxContactId));
    const withNext = new Set(nexts.map((n) => n.sandboxContactId));
    for (const c of contacts) {
      const ref = coldRef(c.id);
      const state = contactState({ status: c.status, optedOutAt: c.optedOutAt, ownerId: c.ownerId, ownerActive: c.owner?.active ?? true, moving: movingIds.has(c.id), crmMatchPersonId: c.crmMatchPersonId, crmAutoPersonId: c.crmAutoPersonId, inCampaign: inCampaign.has(c.id), hasNextStep: withNext.has(c.id), lastOutcome: c.lastOutcome });
      out.set(refKey(ref), { ...sandboxSubject(c), ref, href: subjectHref(ref), ownerId: c.ownerId, ownerName: c.owner?.name ?? null, podId: c.podId, podName: c.pod?.name ?? null, state });
    }
  }
  return out;
}

/**
 * The two report helpers (PLAN 8.4). `workWhere` follows the live subject and drives work lists: a
 * CRM row has a person; a cold row has a cold contact that has not moved and is ACTIVE. `countWhere`
 * follows the audience stamped when the row was written and drives every figure, so a move never
 * changes a past count. 'all' counts both, and for calls also those not matched to anyone yet.
 */
export type AudienceScope = 'all' | 'crm' | 'cold';

type SubjectColumns = Prisma.NextActionWhereInput & Prisma.EnrollmentWhereInput & Prisma.TouchWhereInput;

export function workWhere(scope: AudienceScope): SubjectColumns {
  const crm: SubjectColumns = { personId: { not: null } };
  const cold: SubjectColumns = { sandboxContactId: { not: null }, personId: null, sandboxContact: { status: 'ACTIVE' } };
  return scope === 'crm' ? crm : scope === 'cold' ? cold : { OR: [crm, cold] };
}
export const workTaskWhere = (scope: AudienceScope): Prisma.TaskWhereInput => ({ enrollment: workWhere(scope) });

/** For Touch, CallLog, NextAction, Enrollment and CallForm: they all carry `audience`. */
export function countWhere(scope: AudienceScope): { audience?: 'CRM' | 'SANDBOX' } {
  return scope === 'crm' ? { audience: 'CRM' } : scope === 'cold' ? { audience: 'SANDBOX' } : {};
}
export const countTaskWhere = (scope: AudienceScope): Prisma.TaskWhereInput => (scope === 'all' ? {} : { enrollment: countWhere(scope) });
