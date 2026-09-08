import type { TwentySchema } from './twenty-schema';
import type {
  ParticipantRole,
  TwentyCompany,
  TwentyMessage,
  TwentyMessageParticipant,
  TwentyNote,
  TwentyOpportunity,
  TwentyPerson,
  TwentyTask,
  TwentyWorkspaceMember,
} from './types';

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : v === null || v === undefined ? null : typeof v === 'number' ? String(v) : null);
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Twenty returns one-to-many relations either as arrays or as GraphQL connections. */
export function connectionToArray(v: unknown): Raw[] {
  if (Array.isArray(v)) return v.filter((x): x is Raw => Boolean(x && typeof x === 'object'));
  const o = obj(v);
  if (Array.isArray(o.edges)) return o.edges.map((e) => obj(obj(e).node)).filter((n) => Object.keys(n).length > 0);
  return [];
}

function iso(v: unknown): string {
  const s = str(v);
  return s ?? new Date(0).toISOString();
}

function richText(v: unknown): string | null {
  if (typeof v === 'string') return v || null;
  const o = obj(v);
  return str(o.markdown) ?? str(o.blocknote) ?? null;
}

function composePhone(p: Raw): string | null {
  const number = str(p.primaryPhoneNumber);
  if (!number) return null;
  const calling = str(p.primaryPhoneCallingCode);
  if (calling && !number.startsWith('+')) return `${calling.startsWith('+') ? calling : `+${calling}`} ${number}`;
  return number;
}

export function normalizePerson(raw: Raw, s: TwentySchema): TwentyPerson {
  const name = obj(raw[s.person.name]);
  const emails = obj(raw[s.person.emails]);
  const linkedin = obj(raw[s.person.linkedinLink]);
  const company = obj(raw[s.person.company]);
  const owner = obj(raw[s.person.owner]);
  return {
    id: String(raw.id),
    firstName: str(name.firstName) ?? '',
    lastName: str(name.lastName) ?? '',
    email: str(emails.primaryEmail),
    phone: composePhone(obj(raw[s.person.phones])),
    linkedinUrl: str(linkedin.primaryLinkUrl),
    jobTitle: str(raw[s.person.jobTitle]),
    city: str(raw[s.person.city]),
    companyId: str(raw[s.person.companyId]) ?? str(company.id),
    companyName: str(company.name),
    dnd: raw[s.person.dnd] === true || raw[s.person.dnd] === 'true',
    podOwner: str(raw[s.person.podOwner]),
    ownerMemberId: str(raw[s.person.ownerId]) ?? str(owner.id),
    tags: arr(raw[s.person.tags]),
    eventSource: str(raw[s.person.eventSource]),
    statusOfMeeting: str(raw[s.person.statusOfMeeting]),
    createdAt: iso(raw[s.person.createdAt] ?? raw.createdAt),
    updatedAt: iso(raw[s.person.updatedAt] ?? raw.updatedAt),
    deletedAt: str(raw[s.person.deletedAt] ?? raw.deletedAt),
    raw,
  };
}

export function normalizeCompany(raw: Raw, s: TwentySchema): TwentyCompany {
  const domain = obj(raw[s.company.domainName]);
  const address = obj(raw[s.company.address]);
  const linkedin = obj(raw[s.company.linkedinLink]);
  const employees = raw[s.company.employees];
  return {
    id: String(raw.id),
    name: str(raw[s.company.name]) ?? '',
    domain: str(domain.primaryLinkUrl),
    ownerMemberId: str(raw[s.company.accountOwnerId]) ?? str(obj(raw[s.company.accountOwner]).id),
    industry: str(raw[s.company.industry]),
    employees: typeof employees === 'number' ? employees : Number.isFinite(Number(employees)) && employees !== null && employees !== '' ? Number(employees) : null,
    city: str(address.addressCity) ?? str(raw.city),
    linkedinUrl: str(linkedin.primaryLinkUrl),
    updatedAt: iso(raw[s.company.updatedAt] ?? raw.updatedAt),
    deletedAt: str(raw[s.company.deletedAt] ?? raw.deletedAt),
    raw,
  };
}

export function normalizeWorkspaceMember(raw: Raw, s: TwentySchema): TwentyWorkspaceMember {
  const name = obj(raw[s.workspaceMember.name]);
  return { id: String(raw.id), firstName: str(name.firstName) ?? '', lastName: str(name.lastName) ?? '', email: str(raw[s.workspaceMember.userEmail]), timeZone: str(raw[s.workspaceMember.timeZone]) };
}

export function normalizeNote(raw: Raw, s: TwentySchema): TwentyNote {
  const createdBy = obj(raw[s.note.createdBy]);
  const targets = connectionToArray(raw[s.note.noteTargets]);
  return {
    id: String(raw.id),
    title: str(raw[s.note.title]) ?? '',
    bodyMarkdown: richText(raw[s.note.body]),
    createdByMemberId: str(createdBy.workspaceMemberId),
    createdByName: str(createdBy.name),
    createdBySource: str(createdBy.source),
    personIds: targets.map((t) => str(t[s.noteTarget.personId])).filter((x): x is string => Boolean(x)),
    companyIds: targets.map((t) => str(t[s.noteTarget.companyId])).filter((x): x is string => Boolean(x)),
    createdAt: iso(raw[s.note.createdAt] ?? raw.createdAt),
    updatedAt: iso(raw[s.note.updatedAt] ?? raw.updatedAt),
  };
}

const ROLES: ParticipantRole[] = ['from', 'to', 'cc', 'bcc'];

export function normalizeParticipant(raw: Raw, s: TwentySchema, messageId?: string): TwentyMessageParticipant {
  const roleRaw = (str(raw[s.messageParticipant.role]) ?? 'to').toLowerCase();
  const role = ROLES.includes(roleRaw as ParticipantRole) ? (roleRaw as ParticipantRole) : 'to';
  return {
    id: String(raw.id ?? ''),
    messageId: str(raw[s.messageParticipant.messageId]) ?? messageId ?? '',
    role,
    handle: str(raw[s.messageParticipant.handle]) ?? '',
    displayName: str(raw[s.messageParticipant.displayName]),
    personId: str(raw[s.messageParticipant.personId]),
    workspaceMemberId: str(raw[s.messageParticipant.workspaceMemberId]),
  };
}

export function normalizeMessage(raw: Raw, s: TwentySchema): TwentyMessage {
  const id = String(raw.id);
  return {
    id,
    subject: str(raw[s.message.subject]),
    text: str(raw[s.message.text]),
    receivedAt: iso(raw[s.message.receivedAt] ?? raw.createdAt),
    threadId: str(raw[s.message.messageThreadId]),
    participants: connectionToArray(raw[s.message.messageParticipants]).map((p) => normalizeParticipant(p, s, id)),
    updatedAt: iso(raw[s.message.updatedAt] ?? raw.updatedAt ?? raw[s.message.receivedAt]),
  };
}

export function normalizeTask(raw: Raw, s: TwentySchema): TwentyTask {
  const targets = connectionToArray(raw[s.task.taskTargets]);
  const createdBy = obj(raw[s.task.createdBy]);
  return {
    id: String(raw.id),
    title: str(raw[s.task.title]) ?? '',
    bodyMarkdown: richText(raw[s.task.body]),
    status: str(raw[s.task.status]) ?? 'TODO',
    dueAt: str(raw[s.task.dueAt]),
    assigneeMemberId: str(raw[s.task.assigneeId]) ?? str(obj(raw[s.task.assignee]).id),
    personIds: targets.map((t) => str(t[s.taskTarget.personId])).filter((x): x is string => Boolean(x)),
    cadenceTaskId: str(raw[s.task.cadenceTaskId]),
    createdByMemberId: str(createdBy.workspaceMemberId),
    createdAt: iso(raw.createdAt),
    updatedAt: iso(raw[s.task.updatedAt] ?? raw.updatedAt),
  };
}

export function normalizeOpportunity(raw: Raw, s: TwentySchema): TwentyOpportunity {
  return {
    id: String(raw.id),
    name: str(raw[s.opportunity.name]) ?? '',
    stage: str(raw[s.opportunity.stage]),
    pointOfContactId: str(raw[s.opportunity.pointOfContactId]) ?? str(obj(raw.pointOfContact).id),
    companyId: str(raw[s.opportunity.companyId]) ?? str(obj(raw.company).id),
    createdAt: iso(raw[s.opportunity.createdAt] ?? raw.createdAt),
    updatedAt: iso(raw[s.opportunity.updatedAt] ?? raw.updatedAt),
  };
}

/** Canonical object type for a Twenty object name (singular or plural), or null if we do not track it. */
export type CanonicalObject = 'person' | 'company' | 'note' | 'task' | 'message' | 'messageParticipant' | 'opportunity' | 'workspaceMember' | 'noteTarget' | 'taskTarget';

export function canonicalObjectType(name: string, s: TwentySchema): CanonicalObject | null {
  const n = name.trim();
  for (const [key, def] of Object.entries(s.objects) as Array<[CanonicalObject, { singular: string; plural: string }]>) {
    if (def.singular === n || def.plural === n || def.singular.toLowerCase() === n.toLowerCase()) return key;
  }
  return null;
}
