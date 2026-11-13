import type { ListOptions, ListPeopleOptions, TwentyClient } from './client';
import { MOCK_COMPANIES, MOCK_MEMBERS, MOCK_MESSAGES, MOCK_NOTES, MOCK_OPPORTUNITIES, MOCK_PEOPLE, MOCK_TASKS, MOCK_VIEWS } from './fixtures';
import { DEMO_COMPANIES, DEMO_MEMBERS, DEMO_MESSAGES, DEMO_NOTES, DEMO_OPPORTUNITIES, DEMO_PEOPLE, DEMO_POD_OPTIONS, DEMO_TASKS, DEMO_VIEWS, demoCalendarEvents } from './demo-fixtures';
import { defaultTwentySchema } from './twenty-schema';

export type MockDataset = 'demo' | 'test';

/**
 * Which fixture set the mock serves. The app uses the "demo" dummy workspace (two pods, twelve
 * dummy people); the test suite pins MOCK_DATASET=test for its larger, older fixture set.
 */
export function mockDataset(): MockDataset {
  return process.env.MOCK_DATASET === 'test' ? 'test' : 'demo';
}

function datasetFor(kind: MockDataset) {
  if (kind === 'test') {
    return {
      people: MOCK_PEOPLE,
      companies: MOCK_COMPANIES,
      members: MOCK_MEMBERS,
      notes: MOCK_NOTES,
      messages: MOCK_MESSAGES,
      tasks: MOCK_TASKS,
      opportunities: MOCK_OPPORTUNITIES,
      views: MOCK_VIEWS,
      podOptions: defaultTwentySchema.podOwnerOptions.map((v) => ({ value: v, label: v })),
    };
  }
  return {
    people: DEMO_PEOPLE,
    companies: DEMO_COMPANIES,
    members: DEMO_MEMBERS,
    notes: DEMO_NOTES,
    messages: DEMO_MESSAGES,
    tasks: DEMO_TASKS,
    opportunities: DEMO_OPPORTUNITIES,
    views: DEMO_VIEWS,
    podOptions: DEMO_POD_OPTIONS,
  };
}
import type { PersonDndInput, PersonNextActionInput, TwentyCalendarEvent, TwentyCalendarParticipant } from './types';
import type {
  CreateNoteInput,
  CreateTaskInput,
  Page,
  TwentyCompany,
  TwentyFieldInfo,
  TwentyIntrospection,
  TwentyMessage,
  TwentyNote,
  TwentyOpportunity,
  TwentyPerson,
  TwentyTask,
  TwentyView,
  TwentyWorkspaceMember,
  UpdateTaskInput,
  UpdateNoteInput,
  TwentyMeetingSchema,
  TwentyMeetingRecordInput,
  TwentyMeetingRecord,
  TwentyTagField,
  EnrichPersonInput,
  EnrichCompanyInput,TwentyWebhook, CreateWebhookInput, CreatePersonInput, CreateCompanyInput, FindPeopleQuery } from './types';
import { normalizeDomain, normalizeEmail, normalizeLinkedin, toE164 } from '../sandbox/normalize';

export type MockWrite =
  | { op: 'createNote'; id: string; input: CreateNoteInput }
  | { op: 'updateNote'; id: string; patch: UpdateNoteInput }
  | { op: 'deleteNote'; id: string }
  | { op: 'saveMeetingRecord'; id: string; input: TwentyMeetingRecordInput }
  | { op: 'deleteMeetingRecord'; id: string }
  | { op: 'addSelectOption'; field: string; label: string }
  | { op: 'createTask'; id: string; input: CreateTaskInput }
  | { op: 'updateTask'; id: string; patch: UpdateTaskInput }
  | { op: 'enrichPerson'; id: string; patch: EnrichPersonInput }
  | { op: 'enrichCompany'; id: string; patch: EnrichCompanyInput }
  | { op: 'setPersonNextAction'; id: string; patch: PersonNextActionInput }
  | { op: 'setPersonDnd'; id: string; patch: PersonDndInput }
  | { op: 'deleteTask'; id: string }
  | { op: 'createPerson'; id: string; input: CreatePersonInput }
  | { op: 'createCompany'; id: string; input: CreateCompanyInput }
  | { op: 'deletePerson'; id: string }
  | { op: 'deleteCompany'; id: string };

/** The Meetings object as the team set it up in Twenty (October 2026), for the demo workspace and the tests. */
export const MOCK_MEETING_SCHEMA = (): TwentyMeetingSchema => ({
  meeting: { typeName: 'Meeting', plural: 'meetings' },
  fields: {
    date: { name: 'meetingDate', dateOnly: true },
    bookedBy: { id: 'field-booked-by', name: 'bookedBy', multi: false, options: [] },
    products: { id: 'field-products', name: 'products', multi: true, options: [{ value: 'PHH', label: 'PHH' }, { value: 'ACUBOOTH', label: 'Acubooth' }, { value: 'GLYNAC', label: 'Glynac' }] },
    team: { id: 'field-team', name: 'teamOnTheCall', multi: true, options: [] },
    recording: 'recording',
    cadenceLink: 'inCadence',
    cadenceId: 'cadenceId',
    guests: 'guestsOptional',
    companyId: 'companiesId',
    personId: 'peopleId',
    assigneeId: 'assignedToId',
    meetingNumber: 'meetingNumber',
    firstMeeting: 'firstMeeting',
  },
  contact: { typeName: 'MeetingContact', plural: 'meetingContacts', meetingId: 'meetingsId', personId: 'peopleId' },
});

type MockMeetingRecord = { data: Record<string, unknown>; contacts: TwentyMeetingRecordInput['contacts']; cadenceId: string | null; createdAt: string; updatedAt: string; addedByMemberId: string | null };

/** The fake workspace's records (not its write log), as MockTwentyClient.snapshot returns them. */
export type MockState = {
  dataset: MockDataset;
  seq: number;
  people: TwentyPerson[];
  companies: TwentyCompany[];
  members: TwentyWorkspaceMember[];
  notes: TwentyNote[];
  meetingObject: TwentyMeetingSchema | null;
  meetingRecords: Array<[string, MockMeetingRecord]>;
  messages: TwentyMessage[];
  calendarEvents: TwentyCalendarEvent[];
  tasks: TwentyTask[];
  opportunities: TwentyOpportunity[];
  views: TwentyView[];
  podOptions: Array<{ value: string; label: string }>;
  webhooks: TwentyWebhook[];
};

/** Which fixtures a stored state grew from: a state kept from older fixtures is not reused. */
const fingerprints = new Map<MockDataset, string>();
export function mockFingerprint(kind: MockDataset = mockDataset()): string {
  const known = fingerprints.get(kind);
  if (known) return known;
  const d = datasetFor(kind);
  let h = 0;
  const text = JSON.stringify([d.people, d.companies, d.members, d.notes, d.messages, d.tasks, d.opportunities, d.views, d.podOptions]);
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  const print = `${kind}:${text.length}:${(h >>> 0).toString(16)}`;
  fingerprints.set(kind, print);
  return print;
}

/** A person with every field empty, for records Cadence creates. */
export function blankPerson(id: string, now: string): TwentyPerson {
  return {
    id, firstName: '', lastName: '', email: null, additionalEmails: [], phone: null, additionalPhone: null, linkedinUrl: null, xUrl: null,
    jobTitle: null, city: null, companyId: null, companyName: null, ownerMemberId: null, podOwner: null, rotatedTo: null, rotationChangedAt: null,
    dnd: false, dndReason: null, emailMissing: false, phoneMissing: false, tags: [], leadSource: [], leadSourceNotes: null, tier: null,
    contactType: [], listCategory: null, previousCadence: null, pipelineStage: null, productInterest: [], primaryProduct: null, campaigns: [],
    onCallingList: false, dealSignalStrength: null, nextAction: null, nextActionDueDate: null, nextStep: null, nextActionDueDatePoc: null,
    lastNote: null, lastCallAt: null, lastEmailAt: null, recordingUrl: null, meetingUrl: null, bookingId: null, createdBySource: null,
    createdByName: null, createdByMemberId: null, createdAt: now, updatedAt: now, deletedAt: null,
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function page<T>(items: T[], opts?: ListOptions): Page<T> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 60, 200));
  const offset = opts?.after ? Number.parseInt(opts.after, 10) || 0 : 0;
  const slice = items.slice(offset, offset + limit);
  const end = offset + slice.length;
  return { items: slice, endCursor: end < items.length ? String(end) : null, hasNextPage: end < items.length };
}

function since<T extends { updatedAt: string }>(items: T[], opts?: ListOptions): T[] {
  if (!opts?.updatedSince) return items;
  return items.filter((i) => i.updatedAt >= opts.updatedSince!);
}

/**
 * In-memory Twenty. State lives on the instance; the module-level singleton
 * (getMockTwentyClient) is shared across the web process so seeds, webhook
 * simulations and pages see the same data.
 */
export class MockTwentyClient implements TwentyClient {
  readonly kind = 'mock' as const;

  people: TwentyPerson[] = [];
  companies: TwentyCompany[] = [];
  members: TwentyWorkspaceMember[] = [];
  notes: TwentyNote[] = [];
  /** The demo workspace's Meetings object; null makes it a workspace without one. */
  meetingObject: TwentyMeetingSchema | null = MOCK_MEETING_SCHEMA();
  meetingRecords = new Map<string, MockMeetingRecord>();
  messages: TwentyMessage[] = [];
  calendarEvents: TwentyCalendarEvent[] = [];
  tasks: TwentyTask[] = [];
  opportunities: TwentyOpportunity[] = [];
  views: TwentyView[] = [];
  writes: MockWrite[] = [];
  /** Simulate an unreachable Twenty. */
  failNext: Error | null = null;

  private seq = 0;

  constructor() {
    this.reset();
  }

  dataset: MockDataset = 'demo';
  podOptions: Array<{ value: string; label: string }> = [];

  reset(kind: MockDataset = mockDataset()) {
    const d = datasetFor(kind);
    this.dataset = kind;
    this.people = clone(d.people);
    this.companies = clone(d.companies);
    this.members = clone(d.members);
    this.notes = clone(d.notes);
    this.messages = clone(d.messages);
    this.meetingObject = MOCK_MEETING_SCHEMA();
    this.meetingRecords = new Map();
    this.calendarEvents = kind === 'demo' ? demoCalendarEvents() : [];
    this.tasks = clone(d.tasks);
    this.opportunities = clone(d.opportunities);
    this.views = clone(d.views);
    this.podOptions = clone(d.podOptions);
    this.writes = [];
    this.failNext = null;
    this.seq = 0;
  }

  nextId(prefix: string) {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, '0')}`;
  }

  /** Everything this fake workspace holds, as plain JSON (mock-store.ts shares it between processes). */
  snapshot(): MockState {
    return JSON.parse(this.stateText()) as MockState;
  }

  /** The snapshot as JSON text, for comparing before and after a call. */
  stateText(): string {
    return JSON.stringify({
      dataset: this.dataset, seq: this.seq, people: this.people, companies: this.companies, members: this.members, notes: this.notes,
      meetingObject: this.meetingObject, meetingRecords: [...this.meetingRecords.entries()], messages: this.messages, calendarEvents: this.calendarEvents,
      tasks: this.tasks, opportunities: this.opportunities, views: this.views, podOptions: this.podOptions, webhooks: this.webhooks,
    } satisfies MockState);
  }

  restore(s: MockState) {
    const v = clone(s);
    this.dataset = v.dataset; this.seq = v.seq; this.people = v.people; this.companies = v.companies; this.members = v.members; this.notes = v.notes;
    this.meetingObject = v.meetingObject; this.meetingRecords = new Map(v.meetingRecords); this.messages = v.messages; this.calendarEvents = v.calendarEvents;
    this.tasks = v.tasks; this.opportunities = v.opportunities; this.views = v.views; this.podOptions = v.podOptions; this.webhooks = v.webhooks;
  }

  private maybeFail() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  // ---- test helpers -------------------------------------------------------

  addNote(input: Partial<TwentyNote> & Pick<TwentyNote, 'title' | 'personIds'>): TwentyNote {
    const now = input.createdAt ?? new Date().toISOString();
    const note: TwentyNote = {
      id: input.id ?? this.nextId('note'),
      title: input.title,
      bodyMarkdown: input.bodyMarkdown ?? null,
      createdByMemberId: input.createdByMemberId ?? null,
      createdByName: input.createdByName ?? null,
      createdBySource: input.createdBySource ?? 'MANUAL',
      personIds: input.personIds,
      companyIds: input.companyIds ?? [],
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    };
    this.notes.push(note);
    return note;
  }

  addMessage(input: {
    id?: string;
    subject?: string;
    text?: string;
    receivedAt?: string;
    from: { handle: string; personId?: string | null; workspaceMemberId?: string | null };
    to: Array<{ handle: string; personId?: string | null; workspaceMemberId?: string | null; role?: 'to' | 'cc' | 'bcc' }>;
  }): TwentyMessage {
    const id = input.id ?? this.nextId('msg');
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    const participants = [
      { id: `${id}-p1`, messageId: id, role: 'from' as const, handle: input.from.handle, displayName: null, personId: input.from.personId ?? null, workspaceMemberId: input.from.workspaceMemberId ?? null },
      ...input.to.map((t, i) => ({ id: `${id}-p${i + 2}`, messageId: id, role: t.role ?? ('to' as const), handle: t.handle, displayName: null, personId: t.personId ?? null, workspaceMemberId: t.workspaceMemberId ?? null })),
    ];
    const msg: TwentyMessage = { id, subject: input.subject ?? null, text: input.text ?? null, receivedAt, threadId: null, participants, updatedAt: receivedAt };
    this.messages.push(msg);
    return msg;
  }

  /** A calendar event, as Twenty syncs it from a connected calendar. */
  addCalendarEvent(input: Partial<Omit<TwentyCalendarEvent, 'participants'>> & { startsAt: string; participants: Array<Partial<TwentyCalendarParticipant> & { handle: string }> }): TwentyCalendarEvent {
    const id = input.id ?? this.nextId('cal');
    const now = new Date().toISOString();
    const event: TwentyCalendarEvent = {
      id,
      title: input.title ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
      isFullDay: input.isFullDay ?? false,
      isCanceled: input.isCanceled ?? false,
      location: input.location ?? null,
      description: input.description ?? null,
      conferenceUrl: input.conferenceUrl ?? null,
      iCalUid: input.iCalUid ?? null,
      participants: input.participants.map((p, i) => ({ id: p.id ?? `${id}-p${i + 1}`, handle: p.handle, displayName: p.displayName ?? null, isOrganizer: p.isOrganizer ?? false, personId: p.personId ?? null, workspaceMemberId: p.workspaceMemberId ?? null })),
      updatedAt: input.updatedAt ?? now,
    };
    this.calendarEvents = [...this.calendarEvents.filter((e) => e.id !== id), event];
    return event;
  }

  updatePerson(id: string, patch: Partial<TwentyPerson>): TwentyPerson {
    const p = this.people.find((x) => x.id === id);
    if (!p) throw new Error(`mock: no person ${id}`);
    Object.assign(p, patch, { updatedAt: patch.updatedAt ?? new Date().toISOString() });
    return p;
  }

  addOpportunity(input: Partial<TwentyOpportunity> & Pick<TwentyOpportunity, 'pointOfContactId'>): TwentyOpportunity {
    const now = input.createdAt ?? new Date().toISOString();
    const opp: TwentyOpportunity = {
      id: input.id ?? this.nextId('opp'),
      name: input.name ?? 'Opportunity',
      stage: input.stage ?? 'NEW',
      pointOfContactId: input.pointOfContactId,
      companyId: input.companyId ?? null,
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    };
    this.opportunities.push(opp);
    return opp;
  }

  // ---- reads --------------------------------------------------------------

  async listPeople(opts?: ListPeopleOptions): Promise<Page<TwentyPerson>> {
    this.maybeFail();
    let items = this.people.filter((p) => opts?.includeDeleted || opts?.deletedSince || !p.deletedAt);
    if (opts?.deletedSince) items = items.filter((p) => p.deletedAt && p.deletedAt >= opts.deletedSince!);
    if (opts?.ids) {
      const set = new Set(opts.ids);
      items = items.filter((p) => set.has(p.id));
    }
    if (opts?.podOwner) items = items.filter((p) => p.podOwner === opts.podOwner);
    if (opts?.companyId) items = items.filter((p) => p.companyId === opts.companyId);
    if (opts?.search) {
      const terms = opts.search.toLowerCase().split(/\s+/).filter(Boolean);
      items = items.filter((p) => terms.every((t) => [p.firstName, p.lastName, p.email, p.jobTitle].some((v) => v?.toLowerCase().includes(t))));
    }
    items = since(items, opts);
    return page(clone(items), opts);
  }

  async getPerson(id: string) {
    this.maybeFail();
    const p = this.people.find((x) => x.id === id);
    return p ? clone(p) : null;
  }

  async getPeopleByIds(ids: string[]) {
    this.maybeFail();
    const set = new Set(ids);
    return clone(this.people.filter((p) => set.has(p.id)));
  }

  async listCompanies(opts?: ListOptions & { ids?: string[]; deletedSince?: string }): Promise<Page<TwentyCompany>> {
    this.maybeFail();
    let items = opts?.deletedSince ? this.companies.filter((c) => c.deletedAt && c.deletedAt >= opts.deletedSince!) : this.companies;
    if (opts?.ids) {
      const set = new Set(opts.ids);
      items = items.filter((c) => set.has(c.id));
    }
    return page(clone(since(items, opts)), opts);
  }

  async countRecords(object: 'person' | 'company'): Promise<number | null> {
    this.maybeFail();
    return (object === 'person' ? this.people : this.companies).filter((r) => !r.deletedAt).length;
  }

  async listWorkspaceMembers() {
    this.maybeFail();
    return clone(this.members);
  }

  async getViewPeople(viewId: string) {
    this.maybeFail();
    const view = this.views.find((v) => v.id === viewId);
    if (!view) throw new Error(`CRM view ${viewId} not found`);
    const set = new Set(view.personIds ?? []);
    return { view: clone(view), people: clone(this.people.filter((p) => set.has(p.id) && !p.deletedAt)) };
  }

  async listNotes(opts?: ListOptions & { personId?: string }): Promise<Page<TwentyNote>> {
    this.maybeFail();
    let items = this.notes;
    if (opts?.personId) items = items.filter((n) => n.personIds.includes(opts.personId!));
    items = since(items, opts).slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return page(clone(items), opts);
  }

  async getNote(id: string) {
    this.maybeFail();
    const n = this.notes.find((x) => x.id === id);
    return n ? clone(n) : null;
  }

  private webhooks: TwentyWebhook[] = [];
  async listWebhooks(): Promise<TwentyWebhook[]> { return [...this.webhooks]; }
  async createWebhook(input: CreateWebhookInput): Promise<TwentyWebhook> {
    const hook: TwentyWebhook = { id: `wh-${this.webhooks.length + 1}`, targetUrl: input.targetUrl, operations: ['*.*'], description: input.description ?? null };
    this.webhooks.push(hook);
    return hook;
  }

  async listMessages(opts?: ListOptions & { personId?: string }): Promise<Page<TwentyMessage>> {
    this.maybeFail();
    let items = this.messages;
    if (opts?.personId) items = items.filter((m) => m.participants.some((p) => p.personId === opts.personId));
    items = since(items, opts).slice().sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
    return page(clone(items), opts);
  }

  async getMessage(id: string) {
    this.maybeFail();
    const m = this.messages.find((x) => x.id === id);
    return m ? clone(m) : null;
  }

  async listCalendarEvents(opts?: ListOptions & { startsFrom?: string; startsBefore?: string; conferenceUrl?: string }): Promise<Page<TwentyCalendarEvent>> {
    this.maybeFail();
    let items = since(this.calendarEvents, opts);
    if (opts?.startsFrom) items = items.filter((e) => (e.startsAt ?? '') >= opts.startsFrom!);
    if (opts?.startsBefore) items = items.filter((e) => (e.startsAt ?? '') < opts.startsBefore!);
    if (opts?.conferenceUrl) items = items.filter((e) => (e.conferenceUrl ?? '').toLowerCase().includes(opts.conferenceUrl!.toLowerCase()));
    return page(clone(items.slice().sort((a, b) => ((a.startsAt ?? '') < (b.startsAt ?? '') ? -1 : 1))), opts);
  }

  async getCalendarEvent(id: string) {
    this.maybeFail();
    const e = this.calendarEvents.find((x) => x.id === id);
    return e ? clone(e) : null;
  }

  async listTasks(opts?: ListOptions & { personId?: string }): Promise<Page<TwentyTask>> {
    this.maybeFail();
    let items = this.tasks;
    if (opts?.personId) items = items.filter((t) => t.personIds.includes(opts.personId!));
    return page(clone(since(items, opts)), opts);
  }

  async getTask(id: string) {
    this.maybeFail();
    const t = this.tasks.find((x) => x.id === id);
    return t ? clone(t) : null;
  }

  async listOpportunities(opts?: ListOptions & { personId?: string }): Promise<Page<TwentyOpportunity>> {
    this.maybeFail();
    let items = this.opportunities;
    if (opts?.personId) items = items.filter((o) => o.pointOfContactId === opts.personId);
    return page(clone(since(items, opts)), opts);
  }

  // ---- writes -------------------------------------------------------------

  async createNote(input: CreateNoteInput) {
    this.maybeFail();
    // As the GraphQL client: a note already made under this id is not made again (N05).
    if (input.id && this.notes.some((n) => n.id === input.id)) return { id: input.id };
    const now = new Date().toISOString();
    const id = input.id ?? this.nextId('cadence-note');
    this.notes.push({
      id,
      title: input.title,
      bodyMarkdown: input.bodyMarkdown,
      createdByMemberId: null,
      createdByName: 'Cadence',
      createdBySource: 'API',
      personIds: [...new Set([input.personId, ...(input.personIds ?? [])].filter((p): p is string => Boolean(p)))],
      companyIds: input.companyId ? [input.companyId] : [],
      createdAt: now,
      updatedAt: now,
    });
    this.writes.push({ op: 'createNote', id, input });
    return { id };
  }

  async updateNote(id: string, patch: UpdateNoteInput) {
    this.maybeFail();
    const n = this.notes.find((x) => x.id === id);
    if (n) {
      if (patch.title !== undefined) n.title = patch.title;
      if (patch.bodyMarkdown !== undefined) n.bodyMarkdown = patch.bodyMarkdown;
      n.updatedAt = new Date().toISOString();
    }
    this.writes.push({ op: 'updateNote', id, patch });
  }

  async meetingSchema() {
    return this.meetingObject ? clone(this.meetingObject) : null;
  }

  async saveMeetingRecord(_schema: TwentyMeetingSchema, input: TwentyMeetingRecordInput) {
    this.maybeFail();
    const existing = input.id && this.meetingRecords.has(input.id) ? input.id : [...this.meetingRecords.entries()].find(([, r]) => r.cadenceId === input.cadenceId)?.[0];
    const id = existing ?? this.nextId('meeting');
    const before = existing ? this.meetingRecords.get(existing) : undefined;
    const now = new Date().toISOString();
    // An update changes the fields it names, as Twenty's does.
    this.meetingRecords.set(id, { data: { ...before?.data, ...clone(input.data) }, contacts: clone(input.contacts), cadenceId: input.cadenceId, createdAt: before?.createdAt ?? now, updatedAt: now, addedByMemberId: before?.addedByMemberId ?? null });
    this.writes.push({ op: 'saveMeetingRecord', id, input: clone(input) });
    return { id };
  }

  async listMeetingRecords(): Promise<TwentyMeetingRecord[]> {
    this.maybeFail();
    return [...this.meetingRecords.entries()].map(([id, r]) => ({ id, createdAt: r.createdAt, updatedAt: r.updatedAt, addedByMemberId: r.addedByMemberId, data: clone(r.data), contactPersonIds: [...new Set(r.contacts.map((c) => c.personId))] }));
  }

  /** A meeting someone added in Twenty itself, for the tests and the demo. */
  addMeetingInTwenty(data: Record<string, unknown>, personIds: string[], addedByMemberId: string | null = null): string {
    const id = this.nextId('meeting');
    const now = new Date().toISOString();
    this.meetingRecords.set(id, { data: clone(data), contacts: personIds.map((personId) => ({ personId, name: String(data.name ?? '') })), cadenceId: null, createdAt: now, updatedAt: now, addedByMemberId });
    return id;
  }

  /** Someone changes a meeting in Twenty: its fields, and the people it links to when given. */
  editMeetingInTwenty(id: string, data: Record<string, unknown>, personIds?: string[]) {
    const r = this.meetingRecords.get(id);
    if (!r) throw new Error(`no meeting ${id}`);
    Object.assign(r.data, clone(data));
    if (personIds) r.contacts = personIds.map((personId) => r.contacts.find((c) => c.personId === personId) ?? { personId, name: String(r.data.name ?? '') });
    r.updatedAt = new Date().toISOString();
  }

  async deleteMeetingRecord(_schema: TwentyMeetingSchema, id: string) {
    this.maybeFail();
    this.meetingRecords.delete(id);
    this.writes.push({ op: 'deleteMeetingRecord', id });
  }

  async addSelectOption(field: TwentyTagField, label: string) {
    const value = label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const target = this.meetingObject ? Object.values(this.meetingObject.fields).find((f) => f && typeof f === 'object' && 'id' in f && f.id === field.id) as TwentyTagField | undefined : undefined;
    if (target && !target.options.some((o) => o.value === value)) target.options.push({ value, label });
    this.writes.push({ op: 'addSelectOption', field: field.name, label });
    return value;
  }

  async deleteNote(id: string) {
    this.maybeFail();
    this.notes = this.notes.filter((n) => n.id !== id);
    this.writes.push({ op: 'deleteNote', id });
  }

  async createTask(input: CreateTaskInput) {
    this.maybeFail();
    if (input.id && this.tasks.some((t) => t.id === input.id)) return { id: input.id };
    const now = new Date().toISOString();
    const id = input.id ?? this.nextId('cadence-task');
    this.tasks.push({
      id,
      title: input.title,
      bodyMarkdown: input.bodyMarkdown ?? null,
      status: defaultTwentySchema.taskStatus.todo,
      dueAt: input.dueAt ?? null,
      assigneeMemberId: input.assigneeMemberId ?? null,
      personIds: [input.personId],
      cadenceTaskId: input.cadenceTaskId ?? null,
      createdByMemberId: null,
      createdAt: now,
      updatedAt: now,
    });
    this.writes.push({ op: 'createTask', id, input });
    return { id };
  }

  async updateTask(id: string, patch: UpdateTaskInput) {
    this.maybeFail();
    const t = this.tasks.find((x) => x.id === id);
    if (t) {
      if (patch.status !== undefined) t.status = patch.status;
      if (patch.title !== undefined) t.title = patch.title;
      if (patch.dueAt !== undefined) t.dueAt = patch.dueAt;
      if (patch.bodyMarkdown !== undefined) t.bodyMarkdown = patch.bodyMarkdown;
      t.updatedAt = new Date().toISOString();
    }
    this.writes.push({ op: 'updateTask', id, patch });
  }

  async deleteTask(id: string) {
    this.maybeFail();
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.writes.push({ op: 'deleteTask', id });
  }

  async enrichPerson(id: string, patch: EnrichPersonInput) {
    this.maybeFail();
    const person = this.people.find((item) => item.id === id && !item.deletedAt);
    if (!person) throw new Error('This contact no longer exists in the CRM.');
    Object.assign(person, patch, { updatedAt: new Date().toISOString() });
    this.writes.push({ op: 'enrichPerson', id, patch: clone(patch) });
    return clone(person);
  }

  async setPersonNextAction(id: string, patch: PersonNextActionInput) {
    this.maybeFail();
    const person = this.people.find((item) => item.id === id && !item.deletedAt);
    if (!person) throw new Error('This contact no longer exists in the CRM.');
    Object.assign(person, patch, { updatedAt: new Date().toISOString() });
    this.writes.push({ op: 'setPersonNextAction', id, patch: clone(patch) });
  }

  async setPersonDnd(id: string, patch: PersonDndInput) {
    this.maybeFail();
    const person = this.people.find((item) => item.id === id && !item.deletedAt);
    if (!person) throw new Error('This contact no longer exists in the CRM.');
    Object.assign(person, { dnd: patch.dnd, dndReason: patch.dnd ? patch.reason ?? 'DO_NOT_DISTURB' : null, updatedAt: new Date().toISOString() });
    this.writes.push({ op: 'setPersonDnd', id, patch: clone(patch) });
  }

  async enrichCompany(id: string, patch: EnrichCompanyInput) {
    this.maybeFail();
    const company = this.companies.find((item) => item.id === id && !item.deletedAt);
    if (!company) throw new Error('This account no longer exists in the CRM.');
    Object.assign(company, patch, { updatedAt: new Date().toISOString() });
    this.writes.push({ op: 'enrichCompany', id, patch: clone(patch) });
    return clone(company);
  }

  // ---- Move to CRM ---------------------------------------------------------

  async findPeople(q: FindPeopleQuery): Promise<TwentyPerson[]> {
    this.maybeFail();
    const emails = new Set((q.emails ?? []).map((e) => normalizeEmail(e)).filter(Boolean));
    const phones = new Set((q.phones ?? []).map((p) => toE164(p)).filter(Boolean));
    const links = new Set((q.linkedinUrls ?? []).map((l) => normalizeLinkedin(l)).filter(Boolean));
    return clone(this.people.filter((p) => !p.deletedAt && (
      [p.email, ...p.additionalEmails].some((e) => emails.has(normalizeEmail(e)))
      || [p.phone, p.additionalPhone].some((n) => phones.has(toE164(n)))
      || links.has(normalizeLinkedin(p.linkedinUrl))
      || (q.cadenceSandboxId != null && (p.raw as { cadenceSandboxId?: string } | undefined)?.cadenceSandboxId === q.cadenceSandboxId)
    )));
  }

  async findCompanies(q: { domain?: string | null; name?: string | null }): Promise<TwentyCompany[]> {
    this.maybeFail();
    const domain = normalizeDomain(q.domain);
    const name = q.name?.trim().toLowerCase();
    return clone(this.companies.filter((c) => !c.deletedAt && ((domain && normalizeDomain(c.domain) === domain) || (name && c.name.trim().toLowerCase() === name))));
  }

  async createPerson(input: CreatePersonInput): Promise<TwentyPerson> {
    this.maybeFail();
    const now = new Date().toISOString();
    const id = this.nextId('person-new');
    const company = input.companyId ? this.companies.find((c) => c.id === input.companyId) : undefined;
    const person: TwentyPerson = {
      ...blankPerson(id, now), firstName: input.firstName, lastName: input.lastName, email: input.email, additionalEmails: input.additionalEmails,
      phone: input.phone, additionalPhone: input.additionalPhone, linkedinUrl: input.linkedinUrl, jobTitle: input.jobTitle,
      city: input.city, companyId: input.companyId, companyName: company?.name ?? null,
      ownerMemberId: input.assignedToMemberId, podOwner: input.podOwner,
      tags: input.tags, leadSource: input.leadSource, leadSourceNotes: input.leadSourceNotes, contactType: input.contactType,
      listCategory: input.listCategory, pipelineStage: input.pipelineStage, productInterest: input.productInterest,
      createdBySource: 'API', createdByName: 'Cadence',
      raw: { cadenceSandboxId: input.cadenceSandboxId },
    };
    this.people.push(person);
    this.writes.push({ op: 'createPerson', id, input: clone(input) });
    return clone(person);
  }

  async createCompany(input: CreateCompanyInput): Promise<TwentyCompany> {
    this.maybeFail();
    const now = new Date().toISOString();
    const id = this.nextId('company-new');
    const company: TwentyCompany = { id, name: input.name, domain: input.domain, ownerMemberId: null, industry: null, employees: input.employees, aum: input.aum, city: input.city, linkedinUrl: input.linkedinUrl, updatedAt: now, deletedAt: null, raw: { crd: input.crd } };
    this.companies.push(company);
    this.writes.push({ op: 'createCompany', id, input: clone(input) });
    return clone(company);
  }

  async deletePerson(id: string) {
    this.maybeFail();
    const person = this.people.find((p) => p.id === id);
    if (person) { person.deletedAt = new Date().toISOString(); person.updatedAt = person.deletedAt; }
    this.writes.push({ op: 'deletePerson', id });
  }

  async deleteCompany(id: string) {
    this.maybeFail();
    const company = this.companies.find((c) => c.id === id);
    if (company) { company.deletedAt = new Date().toISOString(); company.updatedAt = company.deletedAt; }
    this.writes.push({ op: 'deleteCompany', id });
  }

  // ---- schema -------------------------------------------------------------

  async introspect(): Promise<TwentyIntrospection> {
    this.maybeFail();
    const s = defaultTwentySchema;
    const fields = (names: Record<string, string>, extra: TwentyFieldInfo[] = []): TwentyFieldInfo[] => {
      const detailed = new Set(extra.map((e) => e.name));
      return [{ name: 'id', type: 'UUID' }, ...Object.values(names).filter((name) => !detailed.has(name)).map((name) => ({ name, type: 'TEXT' })), ...extra];
    };
    return {
      source: 'mock',
      objects: [
        {
          nameSingular: s.objects.person.singular,
          namePlural: s.objects.person.plural,
          fields: fields(s.person, [
            { name: s.person.podOwner, type: 'SELECT', options: this.podOptions.map((o) => o.value), optionLabels: Object.fromEntries(this.podOptions.map((o) => [o.value, o.label])) },
          ]),
        },
        { nameSingular: s.objects.company.singular, namePlural: s.objects.company.plural, fields: fields(s.company) },
        { nameSingular: s.objects.note.singular, namePlural: s.objects.note.plural, fields: fields(s.note) },
        { nameSingular: s.objects.noteTarget.singular, namePlural: s.objects.noteTarget.plural, fields: fields(s.noteTarget) },
        { nameSingular: s.objects.task.singular, namePlural: s.objects.task.plural, fields: fields(s.task) },
        { nameSingular: s.objects.taskTarget.singular, namePlural: s.objects.taskTarget.plural, fields: fields(s.taskTarget) },
        { nameSingular: s.objects.message.singular, namePlural: s.objects.message.plural, fields: fields(s.message) },
        { nameSingular: s.objects.messageParticipant.singular, namePlural: s.objects.messageParticipant.plural, fields: fields(s.messageParticipant) },
        { nameSingular: s.objects.opportunity.singular, namePlural: s.objects.opportunity.plural, fields: fields(s.opportunity) },
        { nameSingular: s.objects.workspaceMember.singular, namePlural: s.objects.workspaceMember.plural, fields: fields(s.workspaceMember) },
      ],
    };
  }

  async ping() {
    this.maybeFail();
    return { ok: true as const, detail: 'Built-in dummy workspace', people: this.people.length, members: this.members.length };
  }
}

const globalForMock = globalThis as unknown as { __cadenceMockTwenty?: MockTwentyClient };

/** Process-wide mock instance (survives Next.js hot reloads in dev). */
export function getMockTwentyClient(): MockTwentyClient {
  if (!globalForMock.__cadenceMockTwenty) globalForMock.__cadenceMockTwenty = new MockTwentyClient();
  return globalForMock.__cadenceMockTwenty;
}
