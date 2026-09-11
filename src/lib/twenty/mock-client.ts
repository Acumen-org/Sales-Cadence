import type { ListOptions, ListPeopleOptions, TwentyClient } from './client';
import { MOCK_COMPANIES, MOCK_MEMBERS, MOCK_MESSAGES, MOCK_NOTES, MOCK_OPPORTUNITIES, MOCK_PEOPLE, MOCK_TASKS, MOCK_VIEWS } from './fixtures';
import { DEMO_COMPANIES, DEMO_MEMBERS, DEMO_MESSAGES, DEMO_NOTES, DEMO_OPPORTUNITIES, DEMO_PEOPLE, DEMO_POD_OPTIONS, DEMO_TASKS, DEMO_VIEWS } from './demo-fixtures';
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
  EnrichPersonInput,
  EnrichCompanyInput,
} from './types';

export type MockWrite =
  | { op: 'createNote'; id: string; input: CreateNoteInput }
  | { op: 'createTask'; id: string; input: CreateTaskInput }
  | { op: 'updateTask'; id: string; patch: UpdateTaskInput }
  | { op: 'enrichPerson'; id: string; patch: EnrichPersonInput }
  | { op: 'enrichCompany'; id: string; patch: EnrichCompanyInput }
  | { op: 'deleteTask'; id: string };

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
  messages: TwentyMessage[] = [];
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
    const msg: TwentyMessage = { id, subject: input.subject ?? null, text: null, receivedAt, threadId: null, participants, updatedAt: receivedAt };
    this.messages.push(msg);
    return msg;
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

  async listWorkspaceMembers() {
    this.maybeFail();
    return clone(this.members);
  }

  async getViewPeople(viewId: string) {
    this.maybeFail();
    const view = this.views.find((v) => v.id === viewId);
    if (!view) throw new Error(`Twenty view ${viewId} not found`);
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
    const now = new Date().toISOString();
    const id = this.nextId('cadence-note');
    this.notes.push({
      id,
      title: input.title,
      bodyMarkdown: input.bodyMarkdown,
      createdByMemberId: null,
      createdByName: 'Cadence',
      createdBySource: 'API',
      personIds: [input.personId],
      companyIds: input.companyId ? [input.companyId] : [],
      createdAt: now,
      updatedAt: now,
    });
    this.writes.push({ op: 'createNote', id, input });
    return { id };
  }

  async createTask(input: CreateTaskInput) {
    this.maybeFail();
    const now = new Date().toISOString();
    const id = this.nextId('cadence-task');
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
    if (!person) throw new Error('This contact no longer exists in Twenty.');
    Object.assign(person, patch, { updatedAt: new Date().toISOString() });
    this.writes.push({ op: 'enrichPerson', id, patch: clone(patch) });
    return clone(person);
  }

  async enrichCompany(id: string, patch: EnrichCompanyInput) {
    this.maybeFail();
    const company = this.companies.find((item) => item.id === id && !item.deletedAt);
    if (!company) throw new Error('This account no longer exists in Twenty.');
    Object.assign(company, patch, { updatedAt: new Date().toISOString() });
    this.writes.push({ op: 'enrichCompany', id, patch: clone(patch) });
    return clone(company);
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
