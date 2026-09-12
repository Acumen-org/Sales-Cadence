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
  // The export carries a zero-width joiner inside the calling code ("‍+1"); strip it, or
  // every phone number in the app grows an invisible character that breaks tel: links.
  const code = calling?.replace(/[^\d+]/g, '') ?? '';
  if (code && !number.startsWith('+')) return `${code.startsWith('+') ? code : `+${code}`} ${number}`;
  return number;
}

/** A date-only field. Twenty returns either "2026-09-14" or a full timestamp at midnight. */
function localDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

/** A LINKS composite, or a plain URL for workspaces that use a text field. */
function linkUrl(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  return str(obj(v).primaryLinkUrl);
}

/** Twenty stores a bare `false` for unset booleans, so `=== true` is not enough. */
const bool = (v: unknown): boolean => v === true || v === 'true';

/** A select or multi-select value, normalised to the array form. Twenty sends both shapes. */
function options(v: unknown): string[] {
  if (Array.isArray(v)) return arr(v);
  const s = str(v);
  if (!s) return [];
  // A multi-select can arrive as a JSON array in a string, which is how the CSV export writes it.
  if (s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (Array.isArray(parsed)) return arr(parsed);
    } catch {
      /* fall through to the single value */
    }
  }
  return [s];
}

export function normalizePerson(raw: Raw, s: TwentySchema): TwentyPerson {
  const f = s.person;
  const v = s.personValues;
  const name = obj(raw[f.name]);
  const emails = obj(raw[f.emails]);
  const company = obj(raw[f.company]);
  const owner = obj(raw[f.assignedTo]);
  const createdBy = obj(raw[f.createdBy]);
  const tags = options(raw[f.tags]);
  const has = (list: readonly string[]) => tags.find((t) => list.includes(t)) ?? null;

  // dnd is a select here, not a boolean: any set value means do not contact. A workspace that
  // made it a boolean still works, and so does a DNC tag, which is how some of the pod records it.
  const dndValue = options(raw[f.dnd]).find((x) => x !== 'false') ?? null;
  const dndTag = has(v.doNotContactTags);
  const dndSelect = dndValue && (v.dnd.length === 0 || v.dnd.includes(dndValue)) ? dndValue : null;

  return {
    id: String(raw.id),
    firstName: str(name.firstName) ?? '',
    lastName: str(name.lastName) ?? '',
    email: str(emails.primaryEmail),
    additionalEmails: options(emails.additionalEmails),
    phone: composePhone(obj(raw[f.phones])),
    additionalPhone: composePhone(obj(raw[f.additionalNumber])),
    linkedinUrl: linkUrl(raw[f.linkedinLink]),
    xUrl: linkUrl(raw[f.xLink]),
    jobTitle: str(raw[f.jobTitle]),
    city: str(raw[f.city]),
    companyId: str(raw[f.companyId]) ?? str(company.id),
    companyName: str(company.name),

    ownerMemberId: str(raw[f.assignedToId]) ?? str(owner.id),
    podOwner: str(raw[f.podOwner]),
    rotatedTo: str(raw[f.rotationTracking]),
    rotationChangedAt: str(raw[f.rotationChangedAt]),

    dnd: Boolean(dndSelect ?? dndTag) || bool(raw[f.dnd]),
    dndReason: dndSelect ?? dndTag,
    emailMissing: Boolean(has(v.missingEmailTags)),
    phoneMissing: Boolean(has(v.missingPhoneTags)),

    tags,
    leadSource: options(raw[f.leadSource]),
    leadSourceNotes: str(raw[f.leadSourceNotes]),
    tier: str(raw[f.tier]),
    contactType: options(raw[f.contactType]),
    listCategory: str(raw[f.listCategory]),
    previousCadence: str(raw[f.previousCadence]),
    pipelineStage: str(raw[f.pipelineStageField]),
    productInterest: options(raw[f.productInterest]),
    primaryProduct: str(raw[f.primaryProduct]),
    campaigns: options(raw[f.onGoingCampaigns]),
    onCallingList: bool(raw[f.callingList]),
    dealSignalStrength: str(raw[f.dealSignalStrength]),

    nextAction: str(raw[f.nextAction]),
    nextActionDueDate: localDate(raw[f.nextActionDueDate]),
    nextStep: str(raw[f.nextStep]),
    nextActionDueDatePoc: localDate(raw[f.nextActionDueDatePoc]),
    lastNote: str(raw[f.lastNote]),

    lastCallAt: str(raw[f.latestCallActivity]),
    lastEmailAt: str(raw[f.lastEmailActivity]),

    recordingUrl: linkUrl(raw[f.salesCallRecordingLink]),
    meetingUrl: linkUrl(raw[f.meetingLink]),
    bookingId: str(raw[f.bookingId]),

    createdBySource: str(createdBy.source),
    createdByName: str(createdBy.name),
    createdByMemberId: str(createdBy.workspaceMemberId),
    createdAt: iso(raw[f.createdAt] ?? raw.createdAt),
    updatedAt: iso(raw[f.updatedAt] ?? raw.updatedAt),
    deletedAt: str(raw[f.deletedAt] ?? raw.deletedAt),
    raw,
  };
}

export function normalizeCompany(raw: Raw, s: TwentySchema): TwentyCompany {
  const domain = obj(raw[s.company.domainName]);
  const address = obj(raw[s.company.address]);
  const linkedin = obj(raw[s.company.linkedinLink]);
  const employees = raw[s.company.employees];
  const aumValue = raw[s.company.aum];
  const currency = obj(aumValue);
  let aum = typeof aumValue === 'number' || typeof aumValue === 'string' ? String(aumValue) : null;
  if (currency.currencyCode === 'USD' && /^\d+$/.test(String(currency.amountMicros ?? ''))) {
    const micros = BigInt(String(currency.amountMicros));
    const cents = (micros + BigInt(5_000)) / BigInt(10_000);
    aum = `${cents / BigInt(100)}.${(cents % BigInt(100)).toString().padStart(2, '0')}`;
  }
  return {
    id: String(raw.id),
    name: str(raw[s.company.name]) ?? '',
    domain: str(domain.primaryLinkUrl),
    ownerMemberId: str(raw[s.company.accountOwnerId]) ?? str(obj(raw[s.company.accountOwner]).id),
    industry: str(raw[s.company.industry]),
    employees: typeof employees === 'number' ? employees : Number.isFinite(Number(employees)) && employees !== null && employees !== '' ? Number(employees) : null,
    aum: aum !== null && aum !== '' && Number.isFinite(Number(aum)) && Number(aum) >= 0 ? String(aum) : null,
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

/** A target's person or company id, under the mapped name or Twenty's newer `target*Id`. */
function targetId(t: Raw, mapped: string, alias: string): string | null {
  return str(t[mapped]) ?? str(t[alias]) ?? str(obj(t[alias.replace(/Id$/, '')]).id) ?? str(obj(t[mapped.replace(/Id$/, '')]).id);
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
    personIds: targets.map((t) => targetId(t, s.noteTarget.personId, 'targetPersonId')).filter((x): x is string => Boolean(x)),
    companyIds: targets.map((t) => targetId(t, s.noteTarget.companyId, 'targetCompanyId')).filter((x): x is string => Boolean(x)),
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
    personIds: targets.map((t) => targetId(t, s.taskTarget.personId, 'targetPersonId')).filter((x): x is string => Boolean(x)),
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
