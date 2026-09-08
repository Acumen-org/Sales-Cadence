/**
 * Every Twenty object and field name Cadence relies on, in one place.
 *
 * The person block matches the real Acumen workspace (verified against a full export of
 * Alisa's pod: 934 people, 59 columns). The names below are Twenty's GraphQL field names,
 * which Twenty derives from the label an admin typed - "Next Action Due Date" becomes
 * `nextActionDueDate`. Admins can override any value in Settings > Twenty, and
 * `pnpm verify:schema` checks the effective mapping against a live workspace.
 *
 * Fields marked "custom" do not exist in a stock Twenty workspace. The GraphQL client trims
 * any field the workspace does not have out of its selection sets, so a workspace missing one
 * of them returns null for it rather than failing every query.
 */

export const defaultTwentySchema = {
  /** GraphQL singular/plural names of the objects we read and write. */
  objects: {
    person: { singular: 'person', plural: 'people', typeName: 'Person' },
    company: { singular: 'company', plural: 'companies', typeName: 'Company' },
    note: { singular: 'note', plural: 'notes', typeName: 'Note' },
    noteTarget: { singular: 'noteTarget', plural: 'noteTargets', typeName: 'NoteTarget' },
    task: { singular: 'task', plural: 'tasks', typeName: 'Task' },
    taskTarget: { singular: 'taskTarget', plural: 'taskTargets', typeName: 'TaskTarget' },
    message: { singular: 'message', plural: 'messages', typeName: 'Message' },
    messageParticipant: { singular: 'messageParticipant', plural: 'messageParticipants', typeName: 'MessageParticipant' },
    opportunity: { singular: 'opportunity', plural: 'opportunities', typeName: 'Opportunity' },
    workspaceMember: { singular: 'workspaceMember', plural: 'workspaceMembers', typeName: 'WorkspaceMember' },
  },

  person: {
    // --- identity, stock Twenty ------------------------------------------------
    /** Composite: { firstName, lastName } */
    name: 'name',
    /** Composite: { primaryEmail, additionalEmails } */
    emails: 'emails',
    /** Composite: { primaryPhoneNumber, primaryPhoneCallingCode, primaryPhoneCountryCode } */
    phones: 'phones',
    /** Custom phones composite: a second number the team keeps separately. */
    additionalNumber: 'additionalNumber',
    /** Composite link: { primaryLinkUrl, primaryLinkLabel } */
    linkedinLink: 'linkedinLink',
    /** Composite link: X / Twitter. */
    xLink: 'xLink',
    jobTitle: 'jobTitle',
    /** Free text in this workspace, e.g. "Chicago, Illinois". */
    city: 'city',
    company: 'company',
    companyId: 'companyId',
    /** Composite actor: { source, workspaceMemberId, name } - who put this person in Twenty. */
    createdBy: 'createdBy',

    // --- ownership -------------------------------------------------------------
    /**
     * Custom relation to workspaceMember: the person who owns this relationship.
     * This is the field "my relationships" and OWNER assignment read; Twenty has no
     * standard person owner, and this workspace calls it "Assigned To".
     */
    assignedTo: 'assignedTo',
    assignedToId: 'assignedToId',
    /** Custom select: which pod the person belongs to (ALISA, ANDREW, ...). */
    podOwner: 'podOwner',
    /** Custom select: who the person was rotated out to, when they were. */
    rotationTracking: 'rotationTracking',
    rotationChangedAt: 'rotationChangedAt',

    // --- how the team labels people -------------------------------------------
    /** Custom multi-select, free-growing: how the team labels people. */
    tags: 'tags',
    /** Custom select: do not disturb. Set means "do not contact" - see personValues.dnd. */
    dnd: 'dnd',
    /** Custom multi-select: where the lead came from (event, campaign, list). */
    leadSource: 'leadSource',
    /** Custom text: free-form detail behind leadSource. */
    leadSourceNotes: 'leadSourceNotes',
    /** Custom select: LEVEL_1 (best) .. LEVEL_4. */
    tier: 'tier',
    /** Custom multi-select: PROSPECT, CLIENTS, PARTNER, ORGANIZATION, CLIENT_S_CLIENT. */
    contactType: 'contactType',
    /** Custom select: how often this person should be touched (COLD_BD, BI_WEEKLY, ...). */
    listCategory: 'listCategory',
    /** Custom select: the cadence they were on before listCategory changed. */
    previousCadence: 'previousCadence',
    /** Custom select: PROSPECT, QUALIFY, RETAIN. The CRM's own funnel stage. */
    pipelineStageField: 'pipelineStageField',
    /** Custom multi-select: which products they are interested in. */
    productInterest: 'productInterest',
    /** Custom text: the single product this person is really about. */
    primaryProduct: 'primaryProduct',
    /** Custom multi-select: campaigns this person is currently in, in Twenty. */
    onGoingCampaigns: 'onGoingCampaigns',
    /** Custom boolean: on the pod owner's own calling list. */
    callingList: 'alisaCallingList',
    /** Custom select or text: how strong the deal signal is. */
    dealSignalStrength: 'dealSignalStrength',

    // --- what happens next, as the CRM records it ------------------------------
    /** Custom text: the next action a human wrote down, e.g. "FU-2". */
    nextAction: 'nextAction',
    /** Custom date: when that action is due. */
    nextActionDueDate: 'nextActionDueDate',
    /** Custom select: EMAIL or LINKEDIN_MESSAGE. */
    nextStep: 'nextStep',
    /** Custom date: the point-of-contact's own due date, tracked separately. */
    nextActionDueDatePoc: 'nextActionDueDatePoc',
    /** Custom text: the last thing anybody wrote about this person. */
    lastNote: 'lastNote',

    // --- last touch, maintained by Twenty's own automations --------------------
    /** Custom datetime: when we last called them. */
    latestCallActivity: 'latestCallActivity',
    /** Custom datetime: when we last emailed them. */
    lastEmailActivity: 'lastEmailActivity',

    // --- meetings --------------------------------------------------------------
    /** Custom datetime: the booked meeting. Set means a meeting exists. */
    meetingTime: 'meetingTime',
    /** Custom link: the join link for that meeting. */
    meetingLink: 'meetingLink',
    /** Custom link: the recording of a sales call, playable in the Meetings section. */
    salesCallRecordingLink: 'salesCallRecordingLink',
    /** Custom text: the booking reference from the scheduler. */
    bookingId: 'bookingId',

    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    deletedAt: 'deletedAt',
  },

  company: {
    name: 'name',
    /** Composite link: { primaryLinkUrl } */
    domainName: 'domainName',
    /** Optional relation to workspaceMember: who owns the account. */
    accountOwner: 'accountOwner',
    accountOwnerId: 'accountOwnerId',
    /** Optional extras, shown on the account page when present. */
    address: 'address',
    employees: 'employees',
    linkedinLink: 'linkedinLink',
    industry: 'industry',
    updatedAt: 'updatedAt',
    deletedAt: 'deletedAt',
  },

  note: {
    title: 'title',
    /** RichTextV2: { blocknote, markdown } */
    body: 'bodyV2',
    /** Composite actor: { source, workspaceMemberId, name } */
    createdBy: 'createdBy',
    noteTargets: 'noteTargets',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },

  noteTarget: { noteId: 'noteId', personId: 'personId', companyId: 'companyId', opportunityId: 'opportunityId' },

  task: {
    title: 'title',
    body: 'bodyV2',
    dueAt: 'dueAt',
    status: 'status',
    assignee: 'assignee',
    assigneeId: 'assigneeId',
    taskTargets: 'taskTargets',
    createdBy: 'createdBy',
    /** Optional custom text field on Task that stores the Cadence task id. */
    cadenceTaskId: 'cadenceTaskId',
    updatedAt: 'updatedAt',
  },

  taskTarget: { taskId: 'taskId', personId: 'personId', companyId: 'companyId', opportunityId: 'opportunityId' },

  /** Values of the Task.status select. */
  taskStatus: { todo: 'TODO', inProgress: 'IN_PROGRESS', done: 'DONE' },

  message: {
    subject: 'subject',
    text: 'text',
    receivedAt: 'receivedAt',
    messageThreadId: 'messageThreadId',
    messageParticipants: 'messageParticipants',
    updatedAt: 'updatedAt',
  },

  messageParticipant: {
    messageId: 'messageId',
    role: 'role',
    handle: 'handle',
    displayName: 'displayName',
    personId: 'personId',
    workspaceMemberId: 'workspaceMemberId',
  },

  /** Values of MessageParticipant.role. */
  participantRoles: { from: 'from', to: 'to', cc: 'cc', bcc: 'bcc' },

  opportunity: {
    name: 'name',
    stage: 'stage',
    pointOfContactId: 'pointOfContactId',
    companyId: 'companyId',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },

  workspaceMember: {
    name: 'name',
    userEmail: 'userEmail',
    timeZone: 'timeZone',
  },

  /**
   * Select and multi-select option values, exactly as Twenty stores them. Cadence never
   * invents a value: anything arriving that is not listed here is still kept and shown, these
   * lists only drive filters, ordering and the few rules that must know a value's meaning.
   */
  personValues: {
    /** dnd is a select in this workspace, not a boolean: a set value means do not contact. */
    dnd: ['DO_NOT_DISTURB'],
    /** Best first. Ordering matters: the UI sorts and colours by position. */
    tier: ['LEVEL_1', 'LEVEL_2', 'LEVEL_3', 'LEVEL_4'],
    /** How often the person should be touched. COLD_BD is the untouched cold list. */
    listCategory: ['COLD_BD', 'BI_WEEKLY', 'MONTHLY', 'QUARTERLY', 'UNASSIGNED'],
    contactType: ['PROSPECT', 'CLIENTS', 'CLIENT_S_CLIENT', 'PARTNER', 'ORGANIZATION'],
    pipelineStage: ['PROSPECT', 'QUALIFY', 'RETAIN'],
    productInterest: ['PHH', 'TOLLBOOTH', 'ACUBOOTH', 'GLYNAC'],
    nextStep: ['EMAIL', 'LINKEDIN_MESSAGE'],
    onGoingCampaigns: ['AY_PHH_POST_WEBINAR', 'SPONSORSHIP', 'AUBURN_HILL_ACQUISITION', 'CE_PRESENTATION'],
    /**
     * Tags that carry a consequence. The team encodes data quality and consent in tags, so
     * Cadence reads them rather than asking anyone to keep a second set of flags in step.
     */
    doNotContactTags: ['DNC', 'DO_NOT_CONTACT', 'DO_NOT_CALL'],
    missingEmailTags: ['MISSING_EMAIL'],
    missingPhoneTags: ['MISSING_PHONE'],
    /** Tags that mean the record itself is not ready to work. */
    needsEnrichmentTags: ['ENRICHMENT_REQUIRED', 'FOR_REVIEW', 'MISSING_ADDRESS'],
  },

  /**
   * Known podOwner select values. Pods are created from these in Settings, and from any new
   * value that arrives on a person. Twenty stores them upper-case; the pod's display name comes
   * from the option's label in Twenty, not from this list.
   */
  podOwnerOptions: ['ALISA', 'ANDREW', 'LEIGH', 'KARSON', 'DANIEL', 'RIA'],
} as const;

export type TwentySchema = {
  objects: { [K in keyof typeof defaultTwentySchema.objects]: { singular: string; plural: string; typeName: string } };
  person: { [K in keyof typeof defaultTwentySchema.person]: string };
  company: { [K in keyof typeof defaultTwentySchema.company]: string };
  note: { [K in keyof typeof defaultTwentySchema.note]: string };
  noteTarget: { [K in keyof typeof defaultTwentySchema.noteTarget]: string };
  task: { [K in keyof typeof defaultTwentySchema.task]: string };
  taskTarget: { [K in keyof typeof defaultTwentySchema.taskTarget]: string };
  taskStatus: { [K in keyof typeof defaultTwentySchema.taskStatus]: string };
  message: { [K in keyof typeof defaultTwentySchema.message]: string };
  messageParticipant: { [K in keyof typeof defaultTwentySchema.messageParticipant]: string };
  participantRoles: { [K in keyof typeof defaultTwentySchema.participantRoles]: string };
  opportunity: { [K in keyof typeof defaultTwentySchema.opportunity]: string };
  workspaceMember: { [K in keyof typeof defaultTwentySchema.workspaceMember]: string };
  personValues: { [K in keyof typeof defaultTwentySchema.personValues]: string[] };
  podOwnerOptions: string[];
};

/** Sections that hold lists of option values rather than field names. */
const VALUE_SECTIONS = new Set(['personValues']);

/**
 * Default note title patterns. Twenty writes activity as notes in two shapes we
 * must recognise, plus the free-form call notes people type by hand.
 * Named group `actor` (optional) identifies who did it, e.g. tw_alisa.
 */
export const defaultNoteTitlePatterns = {
  outboundEmail: '^\\[Email\\]\\s*Outbound email\\b(?:\\s+by\\s+(?<actor>\\S+))?',
  outboundCall: '^\\[CALL\\]\\s*Outbound Call\\b(?:\\s+by\\s+(?<actor>\\S+))?',
  callNotes: '^Call Notes\\s*\\[(?<date>[^\\]]+)\\]',
  /** Notes Cadence itself writes, so we never treat them as evidence. */
  cadencePrefix: '[Cadence]',
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type TwentySchemaOverride = DeepPartial<TwentySchema>;

/** Merge admin overrides over the defaults (one level of nesting per section). */
export function mergeTwentySchema(override?: TwentySchemaOverride | null): TwentySchema {
  const base = JSON.parse(JSON.stringify(defaultTwentySchema)) as TwentySchema;
  if (!override) return base;
  for (const [sectionKey, sectionVal] of Object.entries(override)) {
    if (sectionVal === undefined || sectionVal === null) continue;
    const key = sectionKey as keyof TwentySchema;
    if (key === 'podOwnerOptions') {
      if (Array.isArray(sectionVal) && sectionVal.length) base.podOwnerOptions = sectionVal.filter((s): s is string => typeof s === 'string');
      continue;
    }
    if (key === 'objects') {
      for (const [objKey, objVal] of Object.entries(sectionVal as Record<string, unknown>)) {
        const target = (base.objects as Record<string, { singular: string; plural: string; typeName: string }>)[objKey];
        if (target && objVal && typeof objVal === 'object') Object.assign(target, objVal);
      }
      continue;
    }
    if (VALUE_SECTIONS.has(key)) {
      // Option lists: an override replaces a list outright, so a workspace that renamed its
      // options is not left with both sets. An empty list is ignored, as with field names.
      const target = base[key] as unknown as Record<string, string[]>;
      for (const [listKey, listVal] of Object.entries(sectionVal as Record<string, unknown>)) {
        if (!Array.isArray(listVal)) continue;
        const values = listVal.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
        if (values.length) target[listKey] = values;
      }
      continue;
    }
    const section = base[key] as Record<string, string>;
    for (const [fieldKey, fieldVal] of Object.entries(sectionVal as Record<string, unknown>)) {
      if (typeof fieldVal === 'string' && fieldVal.trim()) section[fieldKey] = fieldVal.trim();
    }
  }
  return base;
}
