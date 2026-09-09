/**
 * Normalised Twenty records. Both the GraphQL client and the mock produce these,
 * and webhook payloads are normalised into them, so the engine never sees raw
 * Twenty field names (those live in twenty-schema.ts).
 */

/**
 * A person as Cadence understands one. Field names here are Cadence's, not Twenty's: the
 * mapping between the two is twenty-schema.ts and nothing outside normalize.ts should know it.
 * Every group below corresponds to a section of the person panel.
 */
export type TwentyPerson = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  additionalEmails: string[];
  phone: string | null;
  /** A second number the team tracks apart from the primary one. */
  additionalPhone: string | null;
  linkedinUrl: string | null;
  xUrl: string | null;
  jobTitle: string | null;
  city: string | null;
  companyId: string | null;
  companyName: string | null;

  // --- ownership -------------------------------------------------------------
  /** Twenty's `assignedTo` relation: who owns this relationship. */
  ownerMemberId: string | null;
  podOwner: string | null;
  /** Set when the person was rotated out to another pod, e.g. ROTATED_OUT_LEIGH. */
  rotatedTo: string | null;
  rotationChangedAt: string | null;

  // --- consent and data quality ---------------------------------------------
  /** True when the do-not-disturb select is set, or a do-not-contact tag is on the record. */
  dnd: boolean;
  /** What made `dnd` true, for display: the select value or the tag. */
  dndReason: string | null;
  /** Twenty says the email is missing or wrong (MISSING_EMAIL tag). */
  emailMissing: boolean;
  /** Twenty says the phone is missing or wrong (MISSING_PHONE tag). */
  phoneMissing: boolean;

  // --- how the team classifies them -----------------------------------------
  tags: string[];
  /** Where the lead came from: events, campaigns and lists, newest not implied by order. */
  leadSource: string[];
  leadSourceNotes: string | null;
  /** LEVEL_1 (best) .. LEVEL_4. */
  tier: string | null;
  contactType: string[];
  /** Touch frequency the CRM expects: COLD_BD, BI_WEEKLY, MONTHLY, QUARTERLY, UNASSIGNED. */
  listCategory: string | null;
  previousCadence: string | null;
  /** The CRM's own funnel stage: PROSPECT, QUALIFY, RETAIN. */
  pipelineStage: string | null;
  productInterest: string[];
  primaryProduct: string | null;
  /** Campaigns the person is in according to Twenty (not Cadence campaigns). */
  campaigns: string[];
  /** On the pod owner's hand-kept calling list. */
  onCallingList: boolean;
  dealSignalStrength: string | null;

  // --- what the CRM says happens next ---------------------------------------
  nextAction: string | null;
  /** LocalDate (YYYY-MM-DD). */
  nextActionDueDate: string | null;
  /** EMAIL or LINKEDIN_MESSAGE. */
  nextStep: string | null;
  nextActionDueDatePoc: string | null;
  lastNote: string | null;

  // --- last touch, as Twenty's automations record it -------------------------
  lastCallAt: string | null;
  lastEmailAt: string | null;

  // --- recordings ------------------------------------------------------------
  /** Recording of a sales call; the Meetings section can play this. */
  recordingUrl: string | null;
  meetingUrl: string | null;
  bookingId: string | null;

  // --- provenance ------------------------------------------------------------
  createdBySource: string | null;
  createdByName: string | null;
  createdByMemberId: string | null;
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
  /** Assets under management in USD, as a decimal string to preserve precision. */
  aum?: string | null;
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

export type EnrichPersonInput = Partial<Pick<TwentyPerson, 'firstName' | 'lastName' | 'email' | 'phone' | 'linkedinUrl' | 'jobTitle' | 'city'>>;
export type EnrichCompanyInput = Partial<Pick<TwentyCompany, 'domain' | 'industry' | 'employees' | 'city' | 'linkedinUrl' | 'aum'>>;

export function personFullName(p: Pick<TwentyPerson, 'firstName' | 'lastName'>): string {
  return [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || '(no name)';
}
