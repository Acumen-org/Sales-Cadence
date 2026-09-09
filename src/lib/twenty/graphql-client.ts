import type { ListOptions, ListPeopleOptions, TwentyClient } from './client';
import { normalizeCompany, normalizeMessage, normalizeNote, normalizeOpportunity, normalizePerson, normalizeTask, normalizeWorkspaceMember, connectionToArray } from './normalize';
import type { TwentySchema } from './twenty-schema';
import type {
  CreateNoteInput,
  CreateTaskInput,
  Page,
  TwentyCompany,
  TwentyFieldInfo,
  TwentyIntrospection,
  TwentyMessage,
  TwentyNote,
  TwentyObjectInfo,
  TwentyOpportunity,
  TwentyPerson,
  TwentyTask,
  TwentyView,
  TwentyWorkspaceMember,
  UpdateTaskInput,
  EnrichPersonInput,
  EnrichCompanyInput,
} from './types';

export type TwentyGraphqlClientOptions = {
  /** Twenty server base URL, no trailing slash. The API lives at /graphql and /metadata. */
  baseUrl: string;
  apiKey: string;
  schema: TwentySchema;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type Raw = Record<string, unknown>;
type Connection = { edges?: Array<{ node?: Raw; cursor?: string }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };

export class TwentyApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly graphqlErrors?: unknown[],
  ) {
    super(message);
    this.name = 'TwentyApiError';
  }
}

/** A field selection entry: plain field, or composite with a sub-selection. */
type Sel = string | { field: string; sub: string };

const PAGE_SIZE = 60;

/**
 * Twenty CRM over GraphQL. Every query and mutation Cadence uses lives in this file.
 *
 * The selection sets are built from the field mapping (twenty-schema.ts) and, when the
 * workspace allows introspection, trimmed to fields that actually exist, so a missing optional
 * custom field (say `salesCallRecordingLink`) degrades to null instead of failing every query.
 */
export class TwentyGraphqlClient implements TwentyClient {
  readonly kind = 'graphql' as const;
  private readonly s: TwentySchema;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly fieldCache = new Map<string, Promise<Set<string> | null>>();
  private aumTypePromise?: Promise<'number' | 'currency' | null>;

  constructor(private readonly opts: TwentyGraphqlClientOptions) {
    this.s = opts.schema;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  // ---------------------------------------------------------------------------
  // transport
  // ---------------------------------------------------------------------------

  async request<T = Raw>(query: string, variables: Record<string, unknown> = {}, endpoint: 'graphql' | 'metadata' = 'graphql'): Promise<T> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/${endpoint}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new TwentyApiError(`Twenty ${endpoint} responded ${res.status}: ${text.slice(0, 300)}`, res.status);
          if (res.status >= 500 && attempt === 0) {
            lastErr = err;
            continue;
          }
          throw err;
        }
        let json: { data?: T; errors?: Array<{ message?: string }> };
        try {
          json = JSON.parse(text);
        } catch {
          throw new TwentyApiError(`Twenty ${endpoint} returned non-JSON: ${text.slice(0, 200)}`, res.status);
        }
        if (json.errors?.length) {
          throw new TwentyApiError(`Twenty GraphQL error: ${json.errors.map((e) => e.message ?? 'unknown').join('; ')}`, res.status, json.errors);
        }
        if (!json.data) throw new TwentyApiError('Twenty returned no data', res.status);
        return json.data;
      } catch (err) {
        if (err instanceof TwentyApiError) throw err;
        lastErr = err;
        if (attempt === 1) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new TwentyApiError(`Twenty unreachable at ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  /** Fields that exist on a GraphQL type, or null when introspection is unavailable. */
  private availableFields(typeName: string): Promise<Set<string> | null> {
    let cached = this.fieldCache.get(typeName);
    if (!cached) {
      cached = this.request<{ __type: { fields: Array<{ name: string }> } | null }>(`query Fields($name: String!) { __type(name: $name) { fields { name } } }`, { name: typeName })
        .then((d) => (d.__type ? new Set(d.__type.fields.map((f) => f.name)) : null))
        .catch(() => null);
      this.fieldCache.set(typeName, cached);
    }
    return cached;
  }

  private async selection(typeName: string, fields: Sel[], required: string[] = ['id']): Promise<string> {
    const available = await this.availableFields(typeName);
    const parts: string[] = [];
    for (const f of fields) {
      const name = typeof f === 'string' ? f : f.field;
      if (available && !available.has(name) && !required.includes(name)) continue;
      parts.push(typeof f === 'string' ? f : `${f.field} ${f.sub}`);
    }
    return parts.join(' ');
  }

  private page<T>(conn: Connection | undefined, map: (n: Raw) => T): Page<T> {
    const edges = conn?.edges ?? [];
    return {
      items: edges.map((e) => e.node).filter((n): n is Raw => Boolean(n)).map(map),
      endCursor: conn?.pageInfo?.endCursor ?? null,
      hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
    };
  }

  private connectionQuery(plural: string, typeName: string, selection: string): string {
    return `query List($filter: ${typeName}FilterInput, $orderBy: [${typeName}OrderByInput], $first: Int, $after: String) {
      ${plural}(filter: $filter, orderBy: $orderBy, first: $first, after: $after) {
        edges { node { ${selection} } cursor }
        pageInfo { hasNextPage endCursor }
      }
    }`;
  }

  // ---------------------------------------------------------------------------
  // selections
  // ---------------------------------------------------------------------------

  private personSelection() {
    const p = this.s.person;
    return this.selection(this.s.objects.person.typeName, [
      'id',
      { field: p.name, sub: '{ firstName lastName }' },
      { field: p.emails, sub: '{ primaryEmail additionalEmails }' },
      { field: p.phones, sub: '{ primaryPhoneNumber primaryPhoneCallingCode primaryPhoneCountryCode }' },
      { field: p.additionalNumber, sub: '{ primaryPhoneNumber primaryPhoneCallingCode primaryPhoneCountryCode }' },
      { field: p.linkedinLink, sub: '{ primaryLinkUrl }' },
      { field: p.xLink, sub: '{ primaryLinkUrl }' },
      p.jobTitle,
      p.city,
      p.companyId,
      { field: p.company, sub: `{ id ${this.s.company.name} }` },
      { field: p.createdBy, sub: '{ source workspaceMemberId name }' },
      // ownership
      p.assignedToId,
      p.podOwner,
      p.rotationTracking,
      p.rotationChangedAt,
      // classification
      p.dnd,
      p.tags,
      p.leadSource,
      p.leadSourceNotes,
      p.tier,
      p.contactType,
      p.listCategory,
      p.previousCadence,
      p.pipelineStageField,
      p.productInterest,
      p.primaryProduct,
      p.onGoingCampaigns,
      p.callingList,
      p.dealSignalStrength,
      // what happens next
      p.nextAction,
      p.nextActionDueDate,
      p.nextStep,
      p.nextActionDueDatePoc,
      p.lastNote,
      // last touch and meetings
      p.latestCallActivity,
      p.lastEmailActivity,
      { field: p.salesCallRecordingLink, sub: '{ primaryLinkUrl }' },
      { field: p.meetingLink, sub: '{ primaryLinkUrl }' },
      p.bookingId,
      p.createdAt,
      p.updatedAt,
      p.deletedAt,
    ]);
  }

  private noteSelection() {
    const n = this.s.note;
    const t = this.s.noteTarget;
    return this.selection(this.s.objects.note.typeName, [
      'id',
      n.title,
      { field: n.body, sub: '{ markdown }' },
      { field: n.createdBy, sub: '{ source workspaceMemberId name }' },
      { field: n.noteTargets, sub: `{ edges { node { ${t.personId} ${t.companyId} } } }` },
      n.createdAt,
      n.updatedAt,
    ]);
  }

  private messageSelection() {
    const m = this.s.message;
    const p = this.s.messageParticipant;
    return this.selection(this.s.objects.message.typeName, [
      'id',
      m.subject,
      m.receivedAt,
      m.messageThreadId,
      { field: m.messageParticipants, sub: `{ edges { node { id ${p.role} ${p.handle} ${p.displayName} ${p.personId} ${p.workspaceMemberId} } } }` },
      m.updatedAt,
      'createdAt',
    ]);
  }

  private taskSelection() {
    const t = this.s.task;
    const tt = this.s.taskTarget;
    return this.selection(this.s.objects.task.typeName, [
      'id',
      t.title,
      { field: t.body, sub: '{ markdown }' },
      t.status,
      t.dueAt,
      t.assigneeId,
      t.cadenceTaskId,
      { field: t.createdBy, sub: '{ workspaceMemberId }' },
      { field: t.taskTargets, sub: `{ edges { node { ${tt.personId} } } }` },
      'createdAt',
      t.updatedAt,
    ]);
  }

  private opportunitySelection() {
    const o = this.s.opportunity;
    return this.selection(this.s.objects.opportunity.typeName, ['id', o.name, o.stage, o.pointOfContactId, o.companyId, o.createdAt, o.updatedAt]);
  }

  // ---------------------------------------------------------------------------
  // filters
  // ---------------------------------------------------------------------------

  private sinceFilter(field: string, since?: string): Raw | null {
    return since ? { [field]: { gte: since } } : null;
  }

  private and(...parts: Array<Raw | null | undefined>): Raw | undefined {
    const list = parts.filter((p): p is Raw => Boolean(p && Object.keys(p).length));
    if (!list.length) return undefined;
    if (list.length === 1) return list[0];
    return { and: list };
  }

  // ---------------------------------------------------------------------------
  // people & companies
  // ---------------------------------------------------------------------------

  async listPeople(opts: ListPeopleOptions = {}): Promise<Page<TwentyPerson>> {
    const sel = await this.personSelection();
    const p = this.s.person;
    const filter = this.and(
      this.sinceFilter(p.updatedAt, opts.updatedSince),
      opts.ids ? { id: { in: opts.ids } } : null,
      opts.podOwner ? { [p.podOwner]: { eq: opts.podOwner } } : null,
      opts.companyId ? { [p.companyId]: { eq: opts.companyId } } : null,
      opts.includeDeleted ? { or: [{ [p.deletedAt]: { is: 'NULL' } }, { [p.deletedAt]: { is: 'NOT_NULL' } }] } : null,
    );
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.person.plural, this.s.objects.person.typeName, sel), {
      filter,
      orderBy: [{ [p.updatedAt]: 'AscNullsLast' }],
      first: Math.min(opts.limit ?? PAGE_SIZE, 200),
      after: opts.after ?? null,
    });
    return this.page(data[this.s.objects.person.plural], (n) => normalizePerson(n, this.s));
  }

  async getPerson(id: string): Promise<TwentyPerson | null> {
    const page = await this.listPeople({ ids: [id], limit: 1, includeDeleted: true });
    return page.items[0] ?? null;
  }

  async getPeopleByIds(ids: string[]): Promise<TwentyPerson[]> {
    const out: TwentyPerson[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const page = await this.listPeople({ ids: ids.slice(i, i + 50), limit: 50 });
      out.push(...page.items);
    }
    return out;
  }

  private companyAumType() {
    if (!this.aumTypePromise) {
      this.aumTypePromise = this.request<{ __type: { fields: Array<{ name: string; type: { kind: string; name: string | null; ofType?: { kind: string; name: string | null } } }> } | null }>(
        'query CompanyFieldTypes($name: String!) { __type(name: $name) { fields { name type { kind name ofType { kind name } } } } }',
        { name: this.s.objects.company.typeName },
      ).then((result) => {
        const type = result.__type?.fields.find((field) => field.name === this.s.company.aum)?.type;
        const named = type?.ofType ?? type;
        if (!named) return null;
        if (named.kind === 'OBJECT' && /Currency/i.test(named.name ?? '')) return 'currency';
        if (named.kind === 'SCALAR' && /Float|Int|Numeric|Decimal|BigInt|Number/i.test(named.name ?? '')) return 'number';
        return null;
      }).catch(() => null);
    }
    return this.aumTypePromise;
  }

  private async companySelection() {
    const c = this.s.company;
    const aumType = await this.companyAumType();
    return this.selection(this.s.objects.company.typeName, [
      'id',
      c.name,
      { field: c.domainName, sub: '{ primaryLinkUrl }' },
      c.accountOwnerId,
      c.industry,
      c.employees,
      ...(aumType === 'currency' ? [{ field: c.aum, sub: '{ amountMicros currencyCode }' }] : aumType === 'number' ? [c.aum] : []),
      { field: c.address, sub: '{ addressCity }' },
      { field: c.linkedinLink, sub: '{ primaryLinkUrl }' },
      c.updatedAt,
      c.deletedAt,
    ]);
  }

  async listCompanies(opts: ListOptions & { ids?: string[] } = {}): Promise<Page<TwentyCompany>> {
    const c = this.s.company;
    const sel = await this.companySelection();
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.company.plural, this.s.objects.company.typeName, sel), {
      filter: this.and(this.sinceFilter(c.updatedAt, opts.updatedSince), opts.ids ? { id: { in: opts.ids } } : null),
      first: Math.min(opts.limit ?? PAGE_SIZE, 200),
      after: opts.after ?? null,
    });
    return this.page(data[this.s.objects.company.plural], (n) => normalizeCompany(n, this.s));
  }

  async listWorkspaceMembers(): Promise<TwentyWorkspaceMember[]> {
    const w = this.s.workspaceMember;
    const sel = await this.selection(this.s.objects.workspaceMember.typeName, ['id', { field: w.name, sub: '{ firstName lastName }' }, w.userEmail, w.timeZone]);
    const data = await this.request<Record<string, Connection>>(
      `query Members($first: Int) { ${this.s.objects.workspaceMember.plural}(first: $first) { edges { node { ${sel} } } pageInfo { hasNextPage endCursor } } }`,
      { first: 200 },
    );
    return this.page(data[this.s.objects.workspaceMember.plural], (n) => normalizeWorkspaceMember(n, this.s)).items;
  }

  // ---------------------------------------------------------------------------
  // saved views (best effort: simple filters only)
  // ---------------------------------------------------------------------------

  async getViewPeople(viewId: string): Promise<{ view: TwentyView; people: TwentyPerson[] }> {
    const data = await this.request<{ views: Connection }>(
      `query View($id: UUID) {
        views(filter: { id: { eq: $id } }, first: 1) {
          edges { node { id name objectMetadataId viewFilters { edges { node { fieldMetadataId operand value displayValue } } } } }
        }
      }`,
      { id: viewId },
    );
    const node = data.views?.edges?.[0]?.node;
    if (!node) throw new TwentyApiError(`Twenty view ${viewId} not found. Paste person ids instead.`);
    const meta = await this.metadataObjects();
    const personMeta = meta.find((o) => o.nameSingular === this.s.objects.person.singular);
    if (!personMeta) throw new TwentyApiError('Could not read person metadata to translate the view filters.');
    if (String(node.objectMetadataId ?? personMeta.id) !== personMeta.id) throw new TwentyApiError('That view is not a People view.');
    const fieldById = new Map(personMeta.fields.map((f) => [f.id, f]));
    const filters: Raw[] = [];
    for (const vf of connectionToArray(node.viewFilters)) {
      const field = fieldById.get(String(vf.fieldMetadataId));
      if (!field) throw new TwentyApiError(`View filter on unknown field ${vf.fieldMetadataId}. Paste person ids instead.`);
      filters.push(translateViewFilter(field, String(vf.operand ?? ''), typeof vf.value === 'string' ? vf.value : JSON.stringify(vf.value ?? '')));
    }
    const sel = await this.personSelection();
    const people: TwentyPerson[] = [];
    let after: string | null = null;
    for (let i = 0; i < 200; i++) {
      const page: Record<string, Connection> = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.person.plural, this.s.objects.person.typeName, sel), {
        filter: filters.length ? { and: filters } : undefined,
        first: 100,
        after,
      });
      const p = this.page(page[this.s.objects.person.plural], (n) => normalizePerson(n, this.s));
      people.push(...p.items);
      if (!p.hasNextPage || !p.endCursor) break;
      after = p.endCursor;
    }
    return { view: { id: String(node.id), name: String(node.name ?? viewId), objectSingular: this.s.objects.person.singular, personIds: people.map((p) => p.id) }, people };
  }

  // ---------------------------------------------------------------------------
  // activity
  // ---------------------------------------------------------------------------

  async listNotes(opts: ListOptions & { personId?: string } = {}): Promise<Page<TwentyNote>> {
    const sel = await this.noteSelection();
    if (opts.personId) {
      // Notes are attached through noteTargets; query the targets and lift the notes.
      const data = await this.request<Record<string, Connection>>(
        `query NotesFor($filter: ${this.s.objects.noteTarget.typeName}FilterInput, $first: Int, $after: String) {
          ${this.s.objects.noteTarget.plural}(filter: $filter, first: $first, after: $after, orderBy: [{ createdAt: DescNullsLast }]) {
            edges { node { ${this.s.objects.note.singular} { ${sel} } } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter: { [this.s.noteTarget.personId]: { eq: opts.personId } }, first: Math.min(opts.limit ?? PAGE_SIZE, 100), after: opts.after ?? null },
      );
      const conn = data[this.s.objects.noteTarget.plural];
      const notes = (conn?.edges ?? []).map((e) => (e.node?.[this.s.objects.note.singular] as Raw | undefined) ?? null).filter((n): n is Raw => Boolean(n));
      return { items: notes.map((n) => normalizeNote(n, this.s)), endCursor: conn?.pageInfo?.endCursor ?? null, hasNextPage: Boolean(conn?.pageInfo?.hasNextPage) };
    }
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.note.plural, this.s.objects.note.typeName, sel), {
      filter: this.sinceFilter(this.s.note.updatedAt, opts.updatedSince) ?? undefined,
      orderBy: [{ [this.s.note.createdAt]: 'DescNullsLast' }],
      first: Math.min(opts.limit ?? PAGE_SIZE, 200),
      after: opts.after ?? null,
    });
    return this.page(data[this.s.objects.note.plural], (n) => normalizeNote(n, this.s));
  }

  async getNote(id: string): Promise<TwentyNote | null> {
    const sel = await this.noteSelection();
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.note.plural, this.s.objects.note.typeName, sel), { filter: { id: { eq: id } }, first: 1 });
    return this.page(data[this.s.objects.note.plural], (n) => normalizeNote(n, this.s)).items[0] ?? null;
  }

  async listMessages(opts: ListOptions & { personId?: string } = {}): Promise<Page<TwentyMessage>> {
    const sel = await this.messageSelection();
    if (opts.personId) {
      const data = await this.request<Record<string, Connection>>(
        `query MessagesFor($filter: ${this.s.objects.messageParticipant.typeName}FilterInput, $first: Int, $after: String) {
          ${this.s.objects.messageParticipant.plural}(filter: $filter, first: $first, after: $after) {
            edges { node { ${this.s.objects.message.singular} { ${sel} } } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter: { [this.s.messageParticipant.personId]: { eq: opts.personId } }, first: Math.min(opts.limit ?? PAGE_SIZE, 100), after: opts.after ?? null },
      );
      const conn = data[this.s.objects.messageParticipant.plural];
      const seen = new Set<string>();
      const messages: Raw[] = [];
      for (const e of conn?.edges ?? []) {
        const m = e.node?.[this.s.objects.message.singular] as Raw | undefined;
        if (m && !seen.has(String(m.id))) {
          seen.add(String(m.id));
          messages.push(m);
        }
      }
      return { items: messages.map((m) => normalizeMessage(m, this.s)), endCursor: conn?.pageInfo?.endCursor ?? null, hasNextPage: Boolean(conn?.pageInfo?.hasNextPage) };
    }
    const m = this.s.message;
    const since = opts.updatedSince ? { or: [{ [m.receivedAt]: { gte: opts.updatedSince } }, { createdAt: { gte: opts.updatedSince } }] } : undefined;
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.message.plural, this.s.objects.message.typeName, sel), {
      filter: since,
      orderBy: [{ [m.receivedAt]: 'DescNullsLast' }],
      first: Math.min(opts.limit ?? PAGE_SIZE, 200),
      after: opts.after ?? null,
    });
    return this.page(data[this.s.objects.message.plural], (n) => normalizeMessage(n, this.s));
  }

  async getMessage(id: string): Promise<TwentyMessage | null> {
    const sel = await this.messageSelection();
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.message.plural, this.s.objects.message.typeName, sel), { filter: { id: { eq: id } }, first: 1 });
    return this.page(data[this.s.objects.message.plural], (n) => normalizeMessage(n, this.s)).items[0] ?? null;
  }

  async listTasks(opts: ListOptions & { personId?: string } = {}): Promise<Page<TwentyTask>> {
    const sel = await this.taskSelection();
    const filter = this.and(
      this.sinceFilter(this.s.task.updatedAt, opts.updatedSince),
      opts.personId ? { [this.s.task.taskTargets]: { some: { [this.s.taskTarget.personId]: { eq: opts.personId } } } } : null,
    );
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.task.plural, this.s.objects.task.typeName, sel), {
      filter,
      orderBy: [{ [this.s.task.updatedAt]: 'DescNullsLast' }],
      first: Math.min(opts.limit ?? PAGE_SIZE, 200),
      after: opts.after ?? null,
    });
    return this.page(data[this.s.objects.task.plural], (n) => normalizeTask(n, this.s));
  }

  async getTask(id: string): Promise<TwentyTask | null> {
    const sel = await this.taskSelection();
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.task.plural, this.s.objects.task.typeName, sel), { filter: { id: { eq: id } }, first: 1 });
    return this.page(data[this.s.objects.task.plural], (n) => normalizeTask(n, this.s)).items[0] ?? null;
  }

  async listOpportunities(opts: ListOptions & { personId?: string } = {}): Promise<Page<TwentyOpportunity>> {
    const sel = await this.opportunitySelection();
    const o = this.s.opportunity;
    const filter = this.and(this.sinceFilter(o.updatedAt, opts.updatedSince), opts.personId ? { [o.pointOfContactId]: { eq: opts.personId } } : null);
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.opportunity.plural, this.s.objects.opportunity.typeName, sel), {
      filter,
      orderBy: [{ [o.createdAt]: 'DescNullsLast' }],
      first: Math.min(opts.limit ?? PAGE_SIZE, 200),
      after: opts.after ?? null,
    });
    return this.page(data[this.s.objects.opportunity.plural], (n) => normalizeOpportunity(n, this.s));
  }

  // ---------------------------------------------------------------------------
  // writes
  // ---------------------------------------------------------------------------

  private richText(field: string, markdown: string | undefined): Raw {
    if (markdown === undefined) return {};
    // bodyV2 is RichTextV2 { markdown }, legacy `body` is a plain string.
    return field.toLowerCase().endsWith('v2') ? { [field]: { markdown } } : { [field]: markdown };
  }

  async createNote(input: CreateNoteInput): Promise<{ id: string }> {
    const n = this.s.objects.note;
    const created = await this.request<Record<string, { id: string }>>(
      `mutation CreateNote($data: ${n.typeName}CreateInput!) { create${n.typeName}(data: $data) { id } }`,
      { data: { [this.s.note.title]: input.title, ...this.richText(this.s.note.body, input.bodyMarkdown) } },
    );
    const id = created[`create${n.typeName}`].id;
    const nt = this.s.objects.noteTarget;
    await this.request(`mutation CreateNoteTarget($data: ${nt.typeName}CreateInput!) { create${nt.typeName}(data: $data) { id } }`, {
      data: { [this.s.noteTarget.noteId]: id, [this.s.noteTarget.personId]: input.personId },
    });
    return { id };
  }

  async createTask(input: CreateTaskInput): Promise<{ id: string }> {
    const t = this.s.objects.task;
    const data: Raw = {
      [this.s.task.title]: input.title,
      [this.s.task.status]: this.s.taskStatus.todo,
      ...this.richText(this.s.task.body, input.bodyMarkdown),
      ...(input.dueAt ? { [this.s.task.dueAt]: input.dueAt } : {}),
      ...(input.assigneeMemberId ? { [this.s.task.assigneeId]: input.assigneeMemberId } : {}),
      ...(input.cadenceTaskId ? { [this.s.task.cadenceTaskId]: input.cadenceTaskId } : {}),
    };
    const created = await this.request<Record<string, { id: string }>>(`mutation CreateTask($data: ${t.typeName}CreateInput!) { create${t.typeName}(data: $data) { id } }`, { data });
    const id = created[`create${t.typeName}`].id;
    const tt = this.s.objects.taskTarget;
    await this.request(`mutation CreateTaskTarget($data: ${tt.typeName}CreateInput!) { create${tt.typeName}(data: $data) { id } }`, {
      data: { [this.s.taskTarget.taskId]: id, [this.s.taskTarget.personId]: input.personId },
    });
    return { id };
  }

  async updateTask(id: string, patch: UpdateTaskInput): Promise<void> {
    const t = this.s.objects.task;
    const data: Raw = {
      ...(patch.status !== undefined ? { [this.s.task.status]: patch.status } : {}),
      ...(patch.title !== undefined ? { [this.s.task.title]: patch.title } : {}),
      ...(patch.dueAt !== undefined ? { [this.s.task.dueAt]: patch.dueAt } : {}),
      ...this.richText(this.s.task.body, patch.bodyMarkdown),
    };
    await this.request(`mutation UpdateTask($id: UUID!, $data: ${t.typeName}UpdateInput!) { update${t.typeName}(id: $id, data: $data) { id } }`, { id, data });
  }

  async deleteTask(id: string): Promise<void> {
    const t = this.s.objects.task;
    await this.request(`mutation DeleteTask($id: UUID!) { delete${t.typeName}(id: $id) { id } }`, { id });
  }

  private async assertWritableFields(type: string, data: Raw) {
    const available = await this.availableFields(type);
    if (!available) throw new TwentyApiError('Twenty schema could not be verified. Check API permissions before applying enrichment.');
    const missing = Object.keys(data).filter((key) => !available.has(key));
    if (missing.length) throw new TwentyApiError(`Twenty is missing mapped fields: ${missing.join(', ')}. Update the field mapping before retrying.`);
  }

  async enrichPerson(id: string, patch: EnrichPersonInput, current?: TwentyPerson): Promise<TwentyPerson> {
    const person = current ?? await this.getPerson(id);
    if (!person || person.deletedAt) throw new TwentyApiError('This contact no longer exists in Twenty.');
    const fields = this.s.person;
    const data: Raw = {
      ...(patch.firstName !== undefined || patch.lastName !== undefined ? { [fields.name]: { firstName: patch.firstName ?? person.firstName, lastName: patch.lastName ?? person.lastName } } : {}),
      ...(patch.email !== undefined ? { [fields.emails]: { primaryEmail: patch.email, additionalEmails: person.additionalEmails } } : {}),
      ...(patch.phone !== undefined ? { [fields.phones]: { primaryPhoneNumber: patch.phone } } : {}),
      ...(patch.linkedinUrl !== undefined ? { [fields.linkedinLink]: { primaryLinkUrl: patch.linkedinUrl } } : {}),
      ...(patch.jobTitle !== undefined ? { [fields.jobTitle]: patch.jobTitle } : {}),
      ...(patch.city !== undefined ? { [fields.city]: patch.city } : {}),
    };
    const type = this.s.objects.person.typeName;
    await this.assertWritableFields(type, data);
    const selection = await this.personSelection();
    const result = await this.request<Record<string, Raw>>(`mutation EnrichPerson($id: UUID!, $data: ${type}UpdateInput!) { update${type}(id: $id, data: $data) { ${selection} } }`, { id, data });
    if (!result[`update${type}`]) throw new TwentyApiError('Twenty did not return the updated contact.');
    return normalizePerson(result[`update${type}`], this.s);
  }

  async enrichCompany(id: string, patch: EnrichCompanyInput, current?: TwentyCompany): Promise<TwentyCompany> {
    const company = current ?? (await this.listCompanies({ ids: [id], limit: 1 })).items[0];
    if (!company || company.deletedAt) throw new TwentyApiError('This account no longer exists in Twenty.');
    const fields = this.s.company;
    const data: Raw = {
      ...(patch.name !== undefined ? { [fields.name]: patch.name } : {}),
      ...(patch.domain !== undefined ? { [fields.domainName]: { primaryLinkUrl: patch.domain } } : {}),
      ...(patch.industry !== undefined ? { [fields.industry]: patch.industry } : {}),
      ...(patch.employees !== undefined ? { [fields.employees]: patch.employees } : {}),
      ...(patch.city !== undefined ? { [fields.address]: { addressCity: patch.city } } : {}),
      ...(patch.linkedinUrl !== undefined ? { [fields.linkedinLink]: { primaryLinkUrl: patch.linkedinUrl } } : {}),
    };
    if (patch.aum !== undefined) {
      const type = await this.companyAumType();
      if (!type) throw new TwentyApiError('Map company.aum to a Number or USD Currency field in Settings before applying AUM enrichment.');
      const previous = company.raw?.[fields.aum] as { currencyCode?: string } | null | undefined;
      if (type === 'currency' && previous?.currencyCode && previous.currencyCode !== 'USD') throw new TwentyApiError('This AUM field uses another currency. Convert the enrichment value in Twenty before importing USD amounts.');
      if (type === 'number' && patch.aum != null && Number(patch.aum).toFixed(2) !== patch.aum) throw new TwentyApiError('This amount exceeds the Number field’s precision. Use a Currency field for exact AUM amounts.');
      const [whole, fraction = ''] = (patch.aum ?? '0').split('.');
      const micros = BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, '0'));
      data[fields.aum] = type === 'currency' ? { amountMicros: patch.aum === null ? null : micros.toString(), currencyCode: 'USD' } : patch.aum === null ? null : Number(patch.aum);
    }
    const type = this.s.objects.company.typeName;
    await this.assertWritableFields(type, data);
    const selection = await this.companySelection();
    const result = await this.request<Record<string, Raw>>(`mutation EnrichCompany($id: UUID!, $data: ${type}UpdateInput!) { update${type}(id: $id, data: $data) { ${selection} } }`, { id, data });
    if (!result[`update${type}`]) throw new TwentyApiError('Twenty did not return the updated account.');
    return normalizeCompany(result[`update${type}`], this.s);
  }

  // ---------------------------------------------------------------------------
  // schema
  // ---------------------------------------------------------------------------

  /** Objects and fields from the metadata API (includes select options). */
  private async metadataObjects(): Promise<Array<{ id: string; nameSingular: string; namePlural: string; fields: Array<{ id: string; name: string; type: string; label?: string; isCustom?: boolean; options?: string[]; optionLabels?: Record<string, string> }> }>> {
    const data = await this.request<{ objects: Connection }>(
      `query Objects {
        objects(paging: { first: 500 }) {
          edges { node { id nameSingular namePlural isCustom fields(paging: { first: 500 }) { edges { node { id name type label isCustom options } } } } }
        }
      }`,
      {},
      'metadata',
    );
    return connectionToArray(data.objects).map((o) => ({
      id: String(o.id),
      nameSingular: String(o.nameSingular),
      namePlural: String(o.namePlural),
      fields: connectionToArray(o.fields).map((f) => ({
        id: String(f.id),
        name: String(f.name),
        type: String(f.type ?? ''),
        label: typeof f.label === 'string' ? f.label : undefined,
        isCustom: Boolean(f.isCustom),
        options: Array.isArray(f.options) ? (f.options as Array<Raw | string>).map((opt) => (typeof opt === 'string' ? opt : String(opt.value ?? opt.label ?? ''))).filter(Boolean) : undefined,
        optionLabels: Array.isArray(f.options)
          ? Object.fromEntries(
              (f.options as Array<Raw | string>)
                .filter((opt): opt is Raw => typeof opt === 'object' && opt !== null && Boolean(opt.value))
                .map((opt) => [String(opt.value), String(opt.label ?? opt.value)]),
            )
          : undefined,
      })),
    }));
  }

  async introspect(): Promise<TwentyIntrospection> {
    try {
      const objects = await this.metadataObjects();
      return {
        source: 'metadata',
        objects: objects.map<TwentyObjectInfo>((o) => ({ nameSingular: o.nameSingular, namePlural: o.namePlural, fields: o.fields.map<TwentyFieldInfo>((f) => ({ name: f.name, type: f.type, label: f.label, isCustom: f.isCustom, options: f.options, optionLabels: f.optionLabels })) })),
      };
    } catch (metaErr) {
      // Fall back to GraphQL introspection of the types we care about.
      const objects: TwentyObjectInfo[] = [];
      for (const def of Object.values(this.s.objects)) {
        const data = await this.request<{ __type: { fields: Array<{ name: string; type: { name: string | null; kind: string; ofType: { name: string | null } | null } }> } | null }>(
          `query Fields($name: String!) { __type(name: $name) { fields { name type { name kind ofType { name } } } } }`,
          { name: def.typeName },
        );
        if (!data.__type) continue;
        objects.push({ nameSingular: def.singular, namePlural: def.plural, fields: data.__type.fields.map((f) => ({ name: f.name, type: f.type.name ?? f.type.ofType?.name ?? f.type.kind })) });
      }
      if (!objects.length) throw metaErr;
      return { source: 'graphql-introspection', objects };
    }
  }

  async ping(): Promise<{ ok: true; detail: string; members: number }> {
    const members = await this.listWorkspaceMembers();
    return { ok: true, detail: `Connected to ${this.opts.baseUrl}`, members: members.length };
  }
}

/** Translate a Twenty view filter into a GraphQL filter for the people query. */
export function translateViewFilter(field: { name: string; type: string }, operand: string, rawValue: string): Raw {
  const name = field.name;
  let value: unknown = rawValue;
  try {
    value = JSON.parse(rawValue);
  } catch {
    /* plain string */
  }
  const first = Array.isArray(value) ? value[0] : value;
  const type = field.type.toUpperCase();
  switch (operand) {
    case 'is':
      if (type === 'SELECT' || type === 'MULTI_SELECT' || type === 'RELATION' || type === 'UUID') {
        const list = Array.isArray(value) ? value : [value];
        return type === 'RELATION' ? { [`${name}Id`]: { in: list } } : { [name]: { in: list } };
      }
      if (type === 'BOOLEAN') return { [name]: { eq: first === true || first === 'true' } };
      return { [name]: { eq: first } };
    case 'isNot': {
      const list = Array.isArray(value) ? value : [value];
      return { not: { [name]: { in: list } } };
    }
    case 'contains':
      if (type === 'MULTI_SELECT') return { [name]: { containsAny: Array.isArray(value) ? value : [value] } };
      return { [name]: { ilike: `%${first}%` } };
    case 'doesNotContain':
      return { not: { [name]: { ilike: `%${first}%` } } };
    case 'isEmpty':
      return { or: [{ [name]: { is: 'NULL' } }, { [name]: { eq: '' } }] };
    case 'isNotEmpty':
      return { [name]: { is: 'NOT_NULL' } };
    case 'greaterThan':
      return { [name]: { gt: first } };
    case 'lessThan':
      return { [name]: { lt: first } };
    case 'isAfter':
      return { [name]: { gt: first } };
    case 'isBefore':
      return { [name]: { lt: first } };
    default:
      throw new TwentyApiError(`View filter operand "${operand}" on ${name} is not supported. Paste person ids instead.`);
  }
}
