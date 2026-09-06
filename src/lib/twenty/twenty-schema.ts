/**
 * Every Twenty object and field name Cadence relies on, in one place.
 *
 * Defaults below match a stock Twenty workspace plus the custom person fields
 * this team added (dnd, podOwner, owner, tags, eventSource, statusOfMeeting).
 * Admins can override any value in Settings > Twenty; `pnpm verify:schema`
 * checks the effective mapping against a live workspace.
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
    /** Composite: { firstName, lastName } */
    name: 'name',
    /** Composite: { primaryEmail, additionalEmails } */
    emails: 'emails',
    /** Composite: { primaryPhoneNumber, primaryPhoneCallingCode, primaryPhoneCountryCode } */
    phones: 'phones',
    /** Composite link: { primaryLinkUrl, primaryLinkLabel } */
    linkedinLink: 'linkedinLink',
    jobTitle: 'jobTitle',
    city: 'city',
    company: 'company',
    companyId: 'companyId',
    /** Custom boolean: do not contact. */
    dnd: 'dnd',
    /** Custom select: Alisa, Leigh, Andrew, Karson, Daniel, Ria ... */
    podOwner: 'podOwner',
    /** Custom relation to workspaceMember (the person's owner). */
    owner: 'owner',
    ownerId: 'ownerId',
    /** Custom multi-select. */
    tags: 'tags',
    /** Custom text or select: where we met. */
    eventSource: 'eventSource',
    /** Optional custom select used for meeting detection. */
    statusOfMeeting: 'statusOfMeeting',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
    deletedAt: 'deletedAt',
  },

  company: {
    name: 'name',
    /** Composite link: { primaryLinkUrl } */
    domainName: 'domainName',
    updatedAt: 'updatedAt',
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

  /** Known podOwner select values. Pods are created from these in Settings. */
  podOwnerOptions: ['Alisa', 'Leigh', 'Andrew', 'Karson', 'Daniel', 'Ria'],
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
  podOwnerOptions: string[];
};

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
    const section = base[key] as Record<string, string>;
    for (const [fieldKey, fieldVal] of Object.entries(sectionVal as Record<string, unknown>)) {
      if (typeof fieldVal === 'string' && fieldVal.trim()) section[fieldKey] = fieldVal.trim();
    }
  }
  return base;
}
