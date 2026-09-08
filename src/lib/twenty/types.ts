/**
 * Normalised Twenty records. Both the GraphQL client and the mock produce these,
 * and webhook payloads are normalised into them, so the engine never sees raw
 * Twenty field names (those live in twenty-schema.ts).
 */

export type TwentyPerson = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  jobTitle: string | null;
  city: string | null;
  companyId: string | null;
  companyName: string | null;
  dnd: boolean;
  podOwner: string | null;
  ownerMemberId: string | null;
  tags: string[];
  eventSource: string | null;
  statusOfMeeting: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Raw record as received, for debugging and the person cache. */
  raw?: Record<string, unknown>;
};

export type TwentyCompany = {
  id: string;
  name: string;
  domain: string | null;
  ownerMemberId: string | null;
  industry: string | null;
  employees: number | null;
  city: string | null;
  linkedinUrl: string | null;
  updatedAt: string;
  deletedAt?: string | null;
  raw?: Record<string, unknown>;
};

export type TwentyWorkspaceMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  timeZone: string | null;
};

export type TwentyNote = {
  id: string;
  title: string;
  bodyMarkdown: string | null;
  createdByMemberId: string | null;
  createdByName: string | null;
  createdBySource: string | null;
  personIds: string[];
  companyIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type ParticipantRole = 'from' | 'to' | 'cc' | 'bcc';

export type TwentyMessageParticipant = {
  id: string;
  messageId: string;
  role: ParticipantRole;
  handle: string;
  displayName: string | null;
  personId: string | null;
  workspaceMemberId: string | null;
};

export type TwentyMessage = {
  id: string;
  subject: string | null;
  text: string | null;
  receivedAt: string;
  threadId: string | null;
  participants: TwentyMessageParticipant[];
  updatedAt: string;
};

export type TwentyTaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE' | string;

export type TwentyTask = {
  id: string;
  title: string;
  bodyMarkdown: string | null;
  status: TwentyTaskStatus;
  dueAt: string | null;
  assigneeMemberId: string | null;
  personIds: string[];
  cadenceTaskId: string | null;
  createdByMemberId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TwentyOpportunity = {
  id: string;
  name: string;
  stage: string | null;
  pointOfContactId: string | null;
  companyId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TwentyView = {
  id: string;
  name: string;
  objectSingular: string;
  /** Person ids the view resolves to (mock) or filters translated by the client. */
  personIds?: string[];
};

export type Page<T> = {
  items: T[];
  endCursor: string | null;
  hasNextPage: boolean;
};

export type TwentyFieldInfo = {
  name: string;
  type: string;
  label?: string;
  isCustom?: boolean;
  /** Select option values as stored on records. */
  options?: string[];
  /** Human labels for those values, when the API exposes them. */
  optionLabels?: Record<string, string>;
};

export type TwentyObjectInfo = {
  nameSingular: string;
  namePlural: string;
  fields: TwentyFieldInfo[];
};

export type TwentyIntrospection = {
  source: 'metadata' | 'graphql-introspection' | 'mock';
  objects: TwentyObjectInfo[];
};

export type CreateNoteInput = {
  title: string;
  bodyMarkdown: string;
  personId: string;
  companyId?: string | null;
};

export type CreateTaskInput = {
  title: string;
  bodyMarkdown?: string;
  dueAt?: string | null;
  assigneeMemberId?: string | null;
  personId: string;
  cadenceTaskId?: string;
};

export type UpdateTaskInput = {
  status?: TwentyTaskStatus;
  title?: string;
  dueAt?: string | null;
  bodyMarkdown?: string;
};

export function personFullName(p: Pick<TwentyPerson, 'firstName' | 'lastName'>): string {
  return [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || '(no name)';
}
