import type { PersonCache, Prisma, SandboxContact } from '@prisma/client';

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
