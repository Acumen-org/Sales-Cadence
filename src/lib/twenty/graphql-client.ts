import { randomUUID } from 'node:crypto';
import type { ListOptions, ListPeopleOptions, TwentyClient } from './client';
import { normalizeCalendarEvent, normalizeCompany, normalizeMessage, normalizeNote, normalizeOpportunity, normalizePerson, normalizeTask, normalizeWorkspaceMember, connectionToArray } from './normalize';
import type { TwentySchema } from './twenty-schema';
import { likeSafe, searchTerms } from '../search-terms';
import { normalizeDomain, normalizeEmail, normalizeLinkedin, splitE164, toE164 } from '../sandbox/normalize';
import type {
  PersonNextActionInput,
  PersonDndInput,
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
  UpdateNoteInput,
  TwentyMeetingSchema,
  TwentyMeetingRecordInput,
  TwentyMeetingRecord,
  TwentyTagField,
  EnrichPersonInput,
  EnrichCompanyInput,TwentyWebhook, CreateWebhookInput, TwentyCalendarEvent, CreatePersonInput, CreateCompanyInput, FindPeopleQuery } from './types';

export type TwentyGraphqlClientOptions = {
  /** Twenty server base URL, no trailing slash. The API lives at /graphql and /metadata. */
  baseUrl: string;
  apiKey: string;
  schema: TwentySchema;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** N12: waits for a slot in the requests-per-minute budget the web app and worker share. */
  pace?: () => Promise<void>;
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

/**
 * Twenty serves at most 60 records per page and rejects a larger `first`, so every listing asks
 * for 60 whatever the caller wanted; the pagination helper walks the rest.
 */
const PAGE_SIZE = 60;
/** Pages findPeople reads at most: a push asks for at most 20 contacts' keys at a time. */
const FIND_PAGES = 5;
/** Twenty allows 100 API requests a minute. A 429 is waited out, not treated as a failure. */
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
/**
 * N11: what the workspace's data model says is read again after this long, so a field added,
 * renamed or removed in the CRM is noticed without a restart; a read that failed is tried again
 * after a minute instead of being kept as "unknown" for good.
 */
const MODEL_CACHE_MS = 10 * 60_000;
const MODEL_RETRY_MS = 60_000;

type Cached<T> = { at: number; ttl: number; value: Promise<T> };
/** A read of the data model, kept for MODEL_CACHE_MS, or MODEL_RETRY_MS when it failed (`fallback`). */
function cachedRead<T>(cache: Map<string, Cached<T>>, key: string, read: () => Promise<T>, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const entry: Cached<T> = { at: Date.now(), ttl: MODEL_CACHE_MS, value: Promise.resolve(fallback) };
  entry.value = read().catch(() => {
    entry.ttl = MODEL_RETRY_MS;
    return fallback;
  });
  cache.set(key, entry);
  return entry.value;
}

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
  private readonly fieldCache = new Map<string, Cached<Set<string> | null>>();
  private readonly aumTypeCache = new Map<string, Cached<'number' | 'currency' | null>>();

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
    let rateLimited = 0;
    // N05: a create that timed out or got a 5xx may have been carried out; sending it again blindly
    // makes a second record. Creates go once (a 429 is still waited out: Twenty did nothing then).
    const once = /^\s*mutation\s+Create/.test(query);
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      await this.opts.pace?.();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.status === 429 && rateLimited < 3) {
          // The minute's budget is spent. Wait what Twenty asks for (or a few seconds) and go again;
          // this attempt does not count against the retry budget.
          rateLimited += 1;
          const retryAfter = Number(res.headers.get('retry-after'));
          await this.sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2_000 * rateLimited, MAX_RATE_LIMIT_WAIT_MS));
          attempt -= 1;
          continue;
        }
        if (!res.ok) {
          const err = new TwentyApiError(`The CRM's ${endpoint} responded ${res.status}: ${text.slice(0, 300)}`, res.status);
          if (res.status >= 500 && attempt === 0 && !once) {
            lastErr = err;
            continue;
          }
          throw err;
        }
        let json: { data?: T; errors?: Array<{ message?: string }> };
        try {
          json = JSON.parse(text);
        } catch {
          throw new TwentyApiError(`The CRM's ${endpoint} returned non-JSON: ${text.slice(0, 200)}`, res.status);
        }
        if (json.errors?.length) {
          throw new TwentyApiError(`CRM GraphQL error: ${json.errors.map((e) => e.message ?? 'unknown').join('; ')}`, res.status, json.errors);
        }
        if (!json.data) throw new TwentyApiError('The CRM returned no data', res.status);
        return json.data;
      } catch (err) {
        if (err instanceof TwentyApiError) throw err;
        lastErr = err;
        if (attempt === 1 || once) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new TwentyApiError(`The CRM is unreachable at ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  private createInputCache = new Map<string, Cached<boolean>>();
  /**
   * N05: whether `<Type>CreateInput` takes a caller-chosen id. That id is the idempotency marker:
   * after a lost answer, the record is looked up by it instead of being created again.
   */
  private createTakesId(typeName: string): Promise<boolean> {
    return cachedRead(this.createInputCache, typeName, () =>
      this.request<{ __type: { inputFields?: Array<{ name: string }> | null } | null }>(`query CreateInputFields($name: String!) { __type(name: $name) { inputFields { name } } }`, { name: `${typeName}CreateInput` })
        .then((d) => Boolean(d.__type?.inputFields?.some((f) => f.name === 'id'))), false);
  }

  /** Injectable so a test can run a rate-limit retry without waiting. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Fields that exist on a GraphQL type, or null when introspection is unavailable. */
  private availableFields(typeName: string): Promise<Set<string> | null> {
    return cachedRead(this.fieldCache, typeName, () =>
      this.request<{ __type: { fields: Array<{ name: string }> } | null }>(`query Fields($name: String!) { __type(name: $name) { fields { name } } }`, { name: typeName })
        .then((d) => (d.__type ? new Set(d.__type.fields.map((f) => f.name)) : null)), null);
  }

  /**
   * Note and task targets changed shape in Twenty: the relation to a person used to be `person`
   * with a `personId` column and is now `targetPerson` with `targetPersonId` (companies and
   * opportunities likewise). Filtering on the old name fails with "Object noteTarget doesn't have
   * any personId field", and selecting it silently returns nothing, so no note ever reaches the
   * person it is about. The workspace says which it has, once, and everything below uses that.
   */
  private targetFields(kind: 'noteTarget' | 'taskTarget') {
    // Derived from availableFields each time, so it follows that cache's refresh (N11).
    const mapped = this.s[kind];
    return this.availableFields(this.s.objects[kind].typeName).then((available) => {
      const pick = (name: string, alias: string) => (available && !available.has(name) && available.has(alias) ? alias : name);
      return { personId: pick(mapped.personId, 'targetPersonId'), companyId: pick(mapped.companyId, 'targetCompanyId'), opportunityId: pick(mapped.opportunityId, 'targetOpportunityId') };
    });
  }

  // ---------------------------------------------------------------------------
  // webhooks (REST: /rest/webhooks)
  // ---------------------------------------------------------------------------

  private async rest<T = Raw>(method: 'GET' | 'POST', resource: string, body?: Raw): Promise<{ status: number; json: T | null; text: string }> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/rest/${resource}`;
    await this.opts.pace?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { method, headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.opts.apiKey}` }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      const text = await res.text();
      let json: T | null = null;
      try { json = text ? (JSON.parse(text) as T) : null; } catch { json = null; }
      return { status: res.status, json, text };
    } finally { clearTimeout(timer); }
  }

  private static webhookOf(raw: Raw): TwentyWebhook {
    const ops = Array.isArray(raw.operations) ? (raw.operations as string[]) : typeof raw.operation === 'string' ? [raw.operation as string] : [];
    return { id: String(raw.id ?? ''), targetUrl: String(raw.targetUrl ?? ''), operations: ops, description: (raw.description as string | null | undefined) ?? null, createdAt: (raw.createdAt as string | undefined) ?? null };
  }

  async listWebhooks(): Promise<TwentyWebhook[]> {
    const res = await this.rest<Raw>('GET', 'webhooks?limit=60');
    if (res.status >= 400) throw new TwentyApiError(`The CRM's webhooks responded ${res.status}: ${res.text.slice(0, 300)}`, res.status);
    const data = (res.json?.data ?? res.json ?? {}) as Raw;
    const list = (Array.isArray(data.webhooks) ? data.webhooks : Array.isArray(data) ? data : []) as Raw[];
    return list.map(TwentyGraphqlClient.webhookOf);
  }

  /**
   * Every operation on every object ("*.*"): people, companies, notes, messages, tasks. Newer
   * workspaces take `operations` (a list); older ones a single `operation` - the second shape is
   * tried when the first is refused, so one button works against either.
   */
  async createWebhook(input: CreateWebhookInput): Promise<TwentyWebhook> {
    const base: Raw = { targetUrl: input.targetUrl, description: input.description ?? 'Cadence', ...(input.secret ? { secret: input.secret } : {}) };
    let res = await this.rest<Raw>('POST', 'webhooks', { ...base, operations: ['*.*'] });
    if (res.status === 400 || res.status === 422) res = await this.rest<Raw>('POST', 'webhooks', { ...base, operation: '*.*' });
    if (res.status >= 400) throw new TwentyApiError(`The CRM's webhooks responded ${res.status}: ${res.text.slice(0, 300)}`, res.status);
    const data = (res.json?.data ?? res.json ?? {}) as Raw;
    const created = (data.createWebhook ?? data.webhook ?? data) as Raw;
    return TwentyGraphqlClient.webhookOf(created);
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

  private async noteSelection() {
    const n = this.s.note;
    const t = await this.targetFields('noteTarget');
    return this.selection(this.s.objects.note.typeName, [
      'id',
      n.title,
      { field: n.body, sub: '{ markdown blocknote }' },
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
      m.text,
      m.receivedAt,
      m.messageThreadId,
      { field: m.messageParticipants, sub: `{ edges { node { id ${p.role} ${p.handle} ${p.displayName} ${p.personId} ${p.workspaceMemberId} } } }` },
      m.updatedAt,
      'createdAt',
    ]);
  }

  private calendarEventSelection() {
    const e = this.s.calendarEvent;
    const p = this.s.calendarEventParticipant;
    return this.selection(this.s.objects.calendarEvent.typeName, [
      'id',
      e.title,
      e.startsAt,
      e.endsAt,
      e.isFullDay,
      e.isCanceled,
      e.location,
      e.description,
      { field: e.conferenceLink, sub: '{ primaryLinkUrl primaryLinkLabel }' },
      e.iCalUid,
      { field: e.calendarEventParticipants, sub: `{ edges { node { id ${p.handle} ${p.displayName} ${p.isOrganizer} ${p.personId} ${p.workspaceMemberId} } } }` },
      e.updatedAt,
    ]);
  }

  private async taskSelection() {
    const t = this.s.task;
    const tt = await this.targetFields('taskTarget');
    return this.selection(this.s.objects.task.typeName, [
      'id',
      t.title,
      { field: t.body, sub: '{ markdown blocknote }' },
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
      opts.search ? this.personSearchFilter(opts.search) : null,
      opts.deletedSince ? { [p.deletedAt]: { gte: opts.deletedSince } } : opts.includeDeleted ? { or: [{ [p.deletedAt]: { is: 'NULL' } }, { [p.deletedAt]: { is: 'NOT_NULL' } }] } : null,
    );
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.person.plural, this.s.objects.person.typeName, sel), {
      filter,
      // Twenty truncates the result set when ordering by updatedAt on a workspace whose
      // rows were bulk-imported: ~14 distinct timestamps per 60 rows means the keyset cursor
      // cannot order ties, so it returns ~530 of 8369 people and reports hasNextPage: false.
      // Default (id) order paginates the full set correctly; updatedSince still filters.
      orderBy: undefined,
      first: Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE),
      after: opts.after ?? null,
    });
    return this.page(data[this.s.objects.person.plural], (n) => normalizePerson(n, this.s));
  }

  /** Each word typed, somewhere in the name, the primary email or the job title. */
  private personSearchFilter(q: string): Raw | null {
    const p = this.s.person;
    const terms = searchTerms(q);
    if (!terms.length) return null;
    return { and: terms.map((term) => {
      const like = { ilike: `%${likeSafe(term)}%` };
      return { or: [{ [p.name]: { firstName: like } }, { [p.name]: { lastName: like } }, { [p.emails]: { primaryEmail: like } }, { [p.jobTitle]: like }] };
    }) };
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
    return cachedRead(this.aumTypeCache, 'aum', () => this.request<{ __type: { fields: Array<{ name: string; type: { kind: string; name: string | null; ofType?: { kind: string; name: string | null } } }> } | null }>(
        'query CompanyFieldTypes($name: String!) { __type(name: $name) { fields { name type { kind name ofType { kind name } } } } }',
        { name: this.s.objects.company.typeName },
      ).then((result) => {
        const type = result.__type?.fields.find((field) => field.name === this.s.company.aum)?.type;
        const named = type?.ofType ?? type;
        if (!named) return null;
        if (named.kind === 'OBJECT' && /Currency/i.test(named.name ?? '')) return 'currency';
        if (named.kind === 'SCALAR' && /Float|Int|Numeric|Decimal|BigInt|Number/i.test(named.name ?? '')) return 'number';
        return null;
      }), null);
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
      { field: c.address, sub: '{ addressStreet1 addressStreet2 addressCity addressState addressPostcode addressCountry }' },
      { field: c.linkedinLink, sub: '{ primaryLinkUrl }' },
      c.updatedAt,
      c.deletedAt,
    ]);
  }

  async listCompanies(opts: ListOptions & { ids?: string[]; deletedSince?: string } = {}): Promise<Page<TwentyCompany>> {
    const c = this.s.company;
    const sel = await this.companySelection();
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.company.plural, this.s.objects.company.typeName, sel), {
      filter: this.and(this.sinceFilter(c.updatedAt, opts.updatedSince), opts.ids ? { id: { in: opts.ids } } : null, opts.deletedSince ? { [c.deletedAt]: { gte: opts.deletedSince } } : null),
      first: Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE),
      after: opts.after ?? null,
    });
    return this.page(data[this.s.objects.company.plural], (n) => normalizeCompany(n, this.s));
  }

  /** The target field names this workspace actually has, for diagnostics. */
  async describeTargets(): Promise<{ noteTarget: { personId: string }; taskTarget: { personId: string } }> {
    const [noteTarget, taskTarget] = await Promise.all([this.targetFields('noteTarget'), this.targetFields('taskTarget')]);
    return { noteTarget, taskTarget };
  }

  /**
   * How many live records Twenty holds, so the cache can be compared with the source instead of
   * trusted. Null when the workspace does not expose totalCount.
   */
  async countRecords(object: 'person' | 'company'): Promise<number | null> {
    const def = this.s.objects[object];
    try {
      const data = await this.request<Record<string, { totalCount?: number }>>(`query Count { ${def.plural}(first: 1) { totalCount } }`);
      const total = data[def.plural]?.totalCount;
      return typeof total === 'number' ? total : null;
    } catch {
      return null;
    }
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
    if (!node) throw new TwentyApiError(`CRM view ${viewId} not found. Paste person ids instead.`);
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
        first: PAGE_SIZE,
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
        { filter: { [(await this.targetFields('noteTarget')).personId]: { eq: opts.personId } }, first: Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE), after: opts.after ?? null },
      );
      const conn = data[this.s.objects.noteTarget.plural];
      const notes = (conn?.edges ?? []).map((e) => (e.node?.[this.s.objects.note.singular] as Raw | undefined) ?? null).filter((n): n is Raw => Boolean(n));
      return { items: notes.map((n) => normalizeNote(n, this.s)), endCursor: conn?.pageInfo?.endCursor ?? null, hasNextPage: Boolean(conn?.pageInfo?.hasNextPage) };
    }
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.note.plural, this.s.objects.note.typeName, sel), {
      filter: this.sinceFilter(this.s.note.updatedAt, opts.updatedSince) ?? undefined,
      // N19: no timestamp order. Twenty cuts a listing ordered by a timestamp many rows share short
      // and says there are no more pages (see listPeople); id order pages through all of them.
      first: Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE),
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
        { filter: { [this.s.messageParticipant.personId]: { eq: opts.personId } }, first: Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE), after: opts.after ?? null },
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
      // N19: id order, as above; the reconcile sorts the mail by date itself.
      first: Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE),
      after: opts.after ?? null,
    });
    return this.page(data[this.s.objects.message.plural], (n) => normalizeMessage(n, this.s));
  }

  async listCalendarEvents(opts: ListOptions & { startsFrom?: string; startsBefore?: string; conferenceUrl?: string } = {}): Promise<Page<TwentyCalendarEvent>> {
    const sel = await this.calendarEventSelection();
    const e = this.s.calendarEvent;
    const and: Record<string, unknown>[] = [];
    if (opts.updatedSince) and.push({ [e.updatedAt]: { gte: opts.updatedSince } });
    if (opts.startsFrom) and.push({ [e.startsAt]: { gte: opts.startsFrom } });
    if (opts.startsBefore) and.push({ [e.startsAt]: { lt: opts.startsBefore } });
    // A classic Teams id is "meeting_NjQ1...": the underscore stays (as a LIKE wildcard it still matches itself).
    if (opts.conferenceUrl) and.push({ [e.conferenceLink]: { primaryLinkUrl: { ilike: `%${opts.conferenceUrl.replace(/%/g, '')}%` } } });
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.calendarEvent.plural, this.s.objects.calendarEvent.typeName, sel), {
      filter: and.length ? { and } : undefined,
      orderBy: [{ [e.startsAt]: 'AscNullsLast' }],
      first: Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE),
      after: opts.after ?? null,
    });
    return this.page(data[this.s.objects.calendarEvent.plural], (n) => normalizeCalendarEvent(n, this.s));
  }

  async getCalendarEvent(id: string): Promise<TwentyCalendarEvent | null> {
    const sel = await this.calendarEventSelection();
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.calendarEvent.plural, this.s.objects.calendarEvent.typeName, sel), { filter: { id: { eq: id } }, first: 1 });
    return this.page(data[this.s.objects.calendarEvent.plural], (n) => normalizeCalendarEvent(n, this.s)).items[0] ?? null;
  }

  async getMessage(id: string): Promise<TwentyMessage | null> {
    const sel = await this.messageSelection();
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.message.plural, this.s.objects.message.typeName, sel), { filter: { id: { eq: id } }, first: 1 });
    return this.page(data[this.s.objects.message.plural], (n) => normalizeMessage(n, this.s)).items[0] ?? null;
  }

  async listTasks(opts: ListOptions & { personId?: string } = {}): Promise<Page<TwentyTask>> {
    const sel = await this.taskSelection();
    if (opts.personId) {
      // Through the target table, the same way notes are: Twenty does not filter a task by a
      // condition on its targets.
      const data = await this.request<Record<string, Connection>>(
        `query TasksFor($filter: ${this.s.objects.taskTarget.typeName}FilterInput, $first: Int, $after: String) {
          ${this.s.objects.taskTarget.plural}(filter: $filter, first: $first, after: $after, orderBy: [{ createdAt: DescNullsLast }]) {
            edges { node { ${this.s.objects.task.singular} { ${sel} } } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter: { [(await this.targetFields('taskTarget')).personId]: { eq: opts.personId } }, first: Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE), after: opts.after ?? null },
      );
      const conn = data[this.s.objects.taskTarget.plural];
      const tasks = (conn?.edges ?? []).map((e) => (e.node?.[this.s.objects.task.singular] as Raw | undefined) ?? null).filter((n): n is Raw => Boolean(n));
      return { items: tasks.map((n) => normalizeTask(n, this.s)), endCursor: conn?.pageInfo?.endCursor ?? null, hasNextPage: Boolean(conn?.pageInfo?.hasNextPage) };
    }
    const filter = this.sinceFilter(this.s.task.updatedAt, opts.updatedSince) ?? undefined;
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.task.plural, this.s.objects.task.typeName, sel), {
      filter,
      // N19: id order, as above.
      first: Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE),
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
      // N19: newest first for one person's few; a listing of everything goes in id order, as above.
      orderBy: opts.personId ? [{ [o.createdAt]: 'DescNullsLast' }] : undefined,
      first: Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE),
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
    const marker = input.id && (await this.createTakesId(n.typeName)) ? input.id : null;
    let id: string;
    let existing: TwentyNote | null = null;
    try {
      const created = await this.request<Record<string, { id: string }>>(
        `mutation CreateNote($data: ${n.typeName}CreateInput!) { create${n.typeName}(data: $data) { id } }`,
        { data: { ...(marker ? { id: marker } : {}), [this.s.note.title]: input.title, ...this.richText(this.s.note.body, input.bodyMarkdown) } },
      );
      id = created[`create${n.typeName}`].id;
    } catch (err) {
      // N05: the CRM may have made it already (an answer lost, or an earlier attempt): look first.
      existing = marker ? await this.getNote(marker).catch(() => null) : null;
      if (!existing) throw err;
      id = existing.id;
    }
    const nt = this.s.objects.noteTarget;
    const fields = await this.targetFields('noteTarget');
    const targets = [
      ...[...new Set([input.personId, ...(input.personIds ?? [])].filter((p): p is string => Boolean(p)))].filter((personId) => !existing?.personIds.includes(personId)).map((personId) => ({ [fields.personId]: personId })),
      ...(input.companyId && !existing?.companyIds.includes(input.companyId) ? [{ [fields.companyId]: input.companyId }] : []),
    ];
    try {
      for (const target of targets) {
        await this.request(`mutation CreateNoteTarget($data: ${nt.typeName}CreateInput!) { create${nt.typeName}(data: $data) { id } }`, {
          data: { [this.s.noteTarget.noteId]: id, ...target },
        });
      }
    } catch (err) {
      await this.dropOrphan(Boolean(marker || existing), () => this.deleteNote(id));
      throw err;
    }
    return { id };
  }

  /**
   * N08: a record whose link to its person failed is attached to nobody. With an id marker the
   * replay finds it and adds only the missing link; without one the replay would make another, so
   * the half-made record is removed before the write is queued again.
   */
  private async dropOrphan(replayFindsIt: boolean, remove: () => Promise<void>) {
    if (replayFindsIt) return;
    await remove().catch((err) => console.warn(`[twenty] a record left without its person could not be removed: ${err instanceof Error ? err.message : String(err)}`));
  }

  async updateNote(id: string, patch: UpdateNoteInput): Promise<void> {
    const n = this.s.objects.note;
    const data: Raw = { ...(patch.title !== undefined ? { [this.s.note.title]: patch.title } : {}), ...this.richText(this.s.note.body, patch.bodyMarkdown) };
    await this.request(`mutation UpdateNote($id: UUID!, $data: ${n.typeName}UpdateInput!) { update${n.typeName}(id: $id, data: $data) { id } }`, { id, data });
  }

  async deleteNote(id: string): Promise<void> {
    const n = this.s.objects.note;
    await this.request(`mutation DeleteNote($id: UUID!) { delete${n.typeName}(id: $id) { id } }`, { id });
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
    const marker = input.id && (await this.createTakesId(t.typeName)) ? input.id : null;
    let id: string;
    let existing: TwentyTask | null = null;
    try {
      const created = await this.request<Record<string, { id: string }>>(`mutation CreateTask($data: ${t.typeName}CreateInput!) { create${t.typeName}(data: $data) { id } }`, { data: { ...(marker ? { id: marker } : {}), ...data } });
      id = created[`create${t.typeName}`].id;
    } catch (err) {
      // N05: the CRM may have made it already (an answer lost, or an earlier attempt): look first.
      existing = marker ? await this.getTask(marker).catch(() => null) : null;
      if (!existing) throw err;
      id = existing.id;
    }
    if (existing?.personIds.includes(input.personId)) return { id };
    const tt = this.s.objects.taskTarget;
    try {
      await this.request(`mutation CreateTaskTarget($data: ${tt.typeName}CreateInput!) { create${tt.typeName}(data: $data) { id } }`, {
        data: { [this.s.taskTarget.taskId]: id, [(await this.targetFields('taskTarget')).personId]: input.personId },
      });
    } catch (err) {
      await this.dropOrphan(Boolean(marker || existing), () => this.deleteTask(id));
      throw err;
    }
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
    if (!available) throw new TwentyApiError('The CRM fields could not be verified. Check API permissions before applying enrichment.');
    const missing = Object.keys(data).filter((key) => !available.has(key));
    if (missing.length) throw new TwentyApiError(`The CRM is missing mapped fields: ${missing.join(', ')}. Update the field mapping before retrying.`);
  }

  async enrichPerson(id: string, patch: EnrichPersonInput, current?: TwentyPerson): Promise<TwentyPerson> {
    const person = current ?? await this.getPerson(id);
    if (!person || person.deletedAt) throw new TwentyApiError('This contact no longer exists in the CRM.');
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
    if (!result[`update${type}`]) throw new TwentyApiError('The CRM did not return the updated contact.');
    return normalizePerson(result[`update${type}`], this.s);
  }

  async setPersonNextAction(id: string, patch: PersonNextActionInput): Promise<void> {
    const fields = this.s.person;
    const data: Raw = { [fields.nextAction]: patch.nextAction, [fields.nextActionDueDate]: patch.nextActionDueDate };
    const type = this.s.objects.person.typeName;
    await this.assertWritableFields(type, data);
    const result = await this.request<Record<string, Raw>>(`mutation SetNextAction($id: UUID!, $data: ${type}UpdateInput!) { update${type}(id: $id, data: $data) { id } }`, { id, data });
    if (!result[`update${type}`]) throw new TwentyApiError('The CRM did not update the contact.');
  }

  /**
   * The person's Do not contact field. In this workspace dnd is a select, so setting it writes the
   * first value the schema lists (DO_NOT_DISTURB) and clearing it writes null.
   */
  async setPersonDnd(id: string, patch: PersonDndInput): Promise<void> {
    const fields = this.s.person;
    const value = patch.dnd ? patch.reason ?? this.s.personValues.dnd[0] ?? 'DO_NOT_DISTURB' : null;
    const data: Raw = { [fields.dnd]: value };
    const type = this.s.objects.person.typeName;
    await this.assertWritableFields(type, data);
    const result = await this.request<Record<string, Raw>>(`mutation SetDnd($id: UUID!, $data: ${type}UpdateInput!) { update${type}(id: $id, data: $data) { id } }`, { id, data });
    if (!result[`update${type}`]) throw new TwentyApiError('The CRM did not update the contact.');
  }

  async enrichCompany(id: string, patch: EnrichCompanyInput, current?: TwentyCompany): Promise<TwentyCompany> {
    const company = current ?? (await this.listCompanies({ ids: [id], limit: 1 })).items[0];
    if (!company || company.deletedAt) throw new TwentyApiError('This account no longer exists in the CRM.');
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
      if (type === 'currency' && previous?.currencyCode && previous.currencyCode !== 'USD') throw new TwentyApiError('This AUM field uses another currency. Convert the enrichment value in the CRM before importing USD amounts.');
      if (type === 'number' && patch.aum != null && Number(patch.aum).toFixed(2) !== patch.aum) throw new TwentyApiError('This amount exceeds the Number field’s precision. Use a Currency field for exact AUM amounts.');
      const [whole, fraction = ''] = (patch.aum ?? '0').split('.');
      const micros = BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, '0'));
      data[fields.aum] = type === 'currency' ? { amountMicros: patch.aum === null ? null : micros.toString(), currencyCode: 'USD' } : patch.aum === null ? null : Number(patch.aum);
    }
    const type = this.s.objects.company.typeName;
    await this.assertWritableFields(type, data);
    const selection = await this.companySelection();
    const result = await this.request<Record<string, Raw>>(`mutation EnrichCompany($id: UUID!, $data: ${type}UpdateInput!) { update${type}(id: $id, data: $data) { ${selection} } }`, { id, data });
    if (!result[`update${type}`]) throw new TwentyApiError('The CRM did not return the updated account.');
    return normalizeCompany(result[`update${type}`], this.s);
  }

  // ---------------------------------------------------------------------------
  // Move to CRM: the only records Cadence creates, and the only ones undo deletes
  // ---------------------------------------------------------------------------

  async findPeople(q: FindPeopleQuery): Promise<TwentyPerson[]> {
    const p = this.s.person;
    const type = this.s.objects.person.typeName;
    const available = await this.availableFields(type);
    const emails = [...new Set((q.emails ?? []).map((e) => normalizeEmail(e)).filter((e): e is string => Boolean(e)))];
    const phones = [...new Set((q.phones ?? []).map((n) => toE164(n)).filter((n): n is string => Boolean(n)))];
    const links = [...new Set((q.linkedinUrls ?? []).map((l) => normalizeLinkedin(l)).filter((l): l is string => Boolean(l)))];
    const or: Raw[] = [
      ...emails.map((email) => ({ [p.emails]: { primaryEmail: { ilike: likeSafe(email) } } })),
      // Numbers are stored as typed; the last seven digits find them, and the comparison below decides.
      ...phones.map((n) => ({ [p.phones]: { primaryPhoneNumber: { ilike: `%${n.slice(-7)}%` } } })),
      ...links.map((l) => ({ [p.linkedinLink]: { primaryLinkUrl: { ilike: `%${likeSafe(l)}%` } } })),
      ...(q.cadenceSandboxId && (!available || available.has(p.cadenceSandboxId)) ? [{ [p.cadenceSandboxId]: { eq: q.cadenceSandboxId } }] : []),
    ];
    if (!or.length) return [];
    const sel = await this.personSelection();
    // B073: past the first page, and a second look at additional emails and the additional number.
    // That look is its own request, so a workspace that refuses the filter still answers the first.
    const all = async (filter: Raw[]) => {
      const out: TwentyPerson[] = [];
      let after: string | null = null;
      for (let i = 0; i < FIND_PAGES; i++) {
        const data: Record<string, Connection> = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.person.plural, type, sel), { filter: { or: filter }, first: PAGE_SIZE, after });
        const page = this.page(data[this.s.objects.person.plural], (n) => normalizePerson(n, this.s));
        out.push(...page.items);
        if (!page.hasNextPage || !page.endCursor) break;
        after = page.endCursor;
      }
      return out;
    };
    const found = await all(or);
    // N06: additional emails are matched without regard to case (ilike). A workspace whose filter
    // refuses ilike is asked with like, for the address as given and in lower case. Only a refused
    // filter is tolerated; a timeout or an outage fails the lookup, so no duplicate is created on it.
    const asGiven = [...new Set((q.emails ?? []).map((e) => e?.trim()).filter((e): e is string => Boolean(e)))];
    const extra = (op: 'ilike' | 'like'): Raw[] => [
      ...(op === 'ilike' ? emails : [...new Set([...emails, ...asGiven])]).map((email) => ({ [p.emails]: { additionalEmails: { [op]: `%${likeSafe(email)}%` } } })),
      ...(!available || available.has(p.additionalNumber) ? phones.map((n) => ({ [p.additionalNumber]: { primaryPhoneNumber: { ilike: `%${n.slice(-7)}%` } } })) : []),
    ];
    if (extra('ilike').length) {
      const seen = new Set(found.map((x) => x.id));
      let refused: unknown = null;
      for (const op of ['ilike', 'like'] as const) {
        try {
          for (const x of await all(extra(op))) if (!seen.has(x.id)) { seen.add(x.id); found.push(x); }
          refused = null;
          break;
        } catch (err) {
          if (!(err instanceof TwentyApiError && err.graphqlErrors?.length)) throw err;
          refused = err;
        }
      }
      if (refused) console.warn('[twenty] this workspace refuses the additional emails and numbers filter; primary ones were searched', refused instanceof Error ? refused.message : refused);
    }
    const emailSet = new Set(emails), phoneSet = new Set(phones), linkSet = new Set(links);
    return found.filter((person) => !person.deletedAt && (
      [person.email, ...person.additionalEmails].some((e) => emailSet.has(normalizeEmail(e) ?? ''))
      || [person.phone, person.additionalPhone].some((n) => phoneSet.has(toE164(n) ?? ''))
      || linkSet.has(normalizeLinkedin(person.linkedinUrl) ?? '')
      || (q.cadenceSandboxId != null && (person.raw as Raw | undefined)?.[p.cadenceSandboxId] === q.cadenceSandboxId)
    ));
  }

  async findCompanies(q: { domain?: string | null; name?: string | null }): Promise<TwentyCompany[]> {
    const c = this.s.company;
    const domain = normalizeDomain(q.domain);
    const or: Raw[] = [
      ...(domain ? [{ [c.domainName]: { primaryLinkUrl: { ilike: `%${likeSafe(domain)}%` } } }] : []),
      ...(q.name?.trim() ? [{ [c.name]: { ilike: likeSafe(q.name.trim()) } }] : []),
    ];
    if (!or.length) return [];
    const sel = await this.companySelection();
    const data = await this.request<Record<string, Connection>>(this.connectionQuery(this.s.objects.company.plural, this.s.objects.company.typeName, sel), { filter: { or }, first: PAGE_SIZE, after: null });
    return this.page(data[this.s.objects.company.plural], (n) => normalizeCompany(n, this.s)).items
      .filter((company) => !company.deletedAt && ((domain && normalizeDomain(company.domain) === domain) || (q.name && company.name.trim().toLowerCase() === q.name.trim().toLowerCase())));
  }

  /** Optional fields the workspace does not have are left out; the name and emails always go. */
  private async onlyAvailable(type: string, data: Raw, required: string[]): Promise<Raw> {
    const available = await this.availableFields(type);
    if (!available) return data;
    return Object.fromEntries(Object.entries(data).filter(([key]) => required.includes(key) || available.has(key)));
  }

  async createPerson(input: CreatePersonInput): Promise<TwentyPerson> {
    const p = this.s.person;
    const type = this.s.objects.person.typeName;
    const phone = splitE164(input.phone);
    const extra = splitE164(input.additionalPhone);
    const data = await this.onlyAvailable(type, {
      [p.name]: { firstName: input.firstName, lastName: input.lastName },
      [p.emails]: { primaryEmail: input.email ?? '', additionalEmails: input.additionalEmails.length ? input.additionalEmails : null },
      ...(phone ? { [p.phones]: { primaryPhoneNumber: phone.number, primaryPhoneCallingCode: phone.callingCode, primaryPhoneCountryCode: phone.country } } : {}),
      ...(extra ? { [p.additionalNumber]: { primaryPhoneNumber: extra.number, primaryPhoneCallingCode: extra.callingCode, primaryPhoneCountryCode: extra.country } } : {}),
      ...(input.linkedinUrl ? { [p.linkedinLink]: { primaryLinkUrl: input.linkedinUrl } } : {}),
      ...(input.jobTitle ? { [p.jobTitle]: input.jobTitle } : {}),
      ...(input.city ? { [p.city]: input.city } : {}),
      ...(input.companyId ? { [p.companyId]: input.companyId } : {}),
      ...(input.assignedToMemberId ? { [p.assignedToId]: input.assignedToMemberId } : {}),
      ...(input.podOwner ? { [p.podOwner]: input.podOwner } : {}),
      ...(input.leadSource.length ? { [p.leadSource]: input.leadSource } : {}),
      ...(input.leadSourceNotes ? { [p.leadSourceNotes]: input.leadSourceNotes } : {}),
      ...(input.productInterest.length ? { [p.productInterest]: input.productInterest } : {}),
      ...(input.tags.length ? { [p.tags]: input.tags } : {}),
      ...(input.contactType.length ? { [p.contactType]: input.contactType } : {}),
      ...(input.listCategory ? { [p.listCategory]: input.listCategory } : {}),
      ...(input.pipelineStage ? { [p.pipelineStageField]: input.pipelineStage } : {}),
      ...(input.cadenceSandboxId ? { [p.cadenceSandboxId]: input.cadenceSandboxId } : {}),
    }, [p.name, p.emails]);
    const selection = await this.personSelection();
    const result = await this.request<Record<string, Raw>>(`mutation CreatePerson($data: ${type}CreateInput!) { create${type}(data: $data) { ${selection} } }`, { data });
    if (!result[`create${type}`]) throw new TwentyApiError('The CRM did not return the new contact.');
    return normalizePerson(result[`create${type}`], this.s);
  }

  async createCompany(input: CreateCompanyInput): Promise<TwentyCompany> {
    const c = this.s.company;
    const type = this.s.objects.company.typeName;
    const aumType = input.aum ? await this.companyAumType() : null;
    const data = await this.onlyAvailable(type, {
      [c.name]: input.name,
      ...(input.domain ? { [c.domainName]: { primaryLinkUrl: input.domain } } : {}),
      ...(input.city || input.state ? { [c.address]: { addressCity: input.city ?? '', addressState: input.state ?? '' } } : {}),
      ...(input.employees != null ? { [c.employees]: input.employees } : {}),
      ...(input.linkedinUrl ? { [c.linkedinLink]: { primaryLinkUrl: input.linkedinUrl } } : {}),
      ...(input.crd ? { [c.crd]: input.crd } : {}),
      ...(input.aum && aumType === 'currency' ? { [c.aum]: { amountMicros: (BigInt(input.aum.split('.')[0]) * BigInt(1_000_000)).toString(), currencyCode: 'USD' } } : {}),
      ...(input.aum && aumType === 'number' ? { [c.aum]: Number(input.aum) } : {}),
    }, [c.name]);
    const selection = await this.companySelection();
    const result = await this.request<Record<string, Raw>>(`mutation CreateCompany($data: ${type}CreateInput!) { create${type}(data: $data) { ${selection} } }`, { data });
    if (!result[`create${type}`]) throw new TwentyApiError('The CRM did not return the new account.');
    return normalizeCompany(result[`create${type}`], this.s);
  }

  async deletePerson(id: string): Promise<void> {
    const type = this.s.objects.person.typeName;
    await this.request(`mutation DeletePerson($id: UUID!) { delete${type}(id: $id) { id } }`, { id });
  }

  async deleteCompany(id: string): Promise<void> {
    const type = this.s.objects.company.typeName;
    await this.request(`mutation DeleteCompany($id: UUID!) { delete${type}(id: $id) { id } }`, { id });
  }

  // ---------------------------------------------------------------------------
  // schema
  // ---------------------------------------------------------------------------

  /** Objects and fields from the metadata API (includes select options). */
  private async metadataObjects(): Promise<Array<{ id: string; nameSingular: string; namePlural: string; fields: Array<{ id: string; name: string; type: string; label?: string; isCustom?: boolean; options?: string[]; optionLabels?: Record<string, string>; rawOptions?: Raw[] }> }>> {
    const data = await this.request<{ objects: Connection }>(
      `query Objects {
        objects(paging: { first: 500 }) {
          edges { node { id nameSingular namePlural isCustom fieldsList { id name type label isCustom options } } }
        }
      }`,
      {},
      'metadata',
    );
    return connectionToArray(data.objects).map((o) => ({
      id: String(o.id),
      nameSingular: String(o.nameSingular),
      namePlural: String(o.namePlural),
      fields: (Array.isArray(o.fieldsList) ? (o.fieldsList as Raw[]) : connectionToArray(o.fields)).map((f) => ({
        id: String(f.id),
        name: String(f.name),
        type: String(f.type ?? ''),
        label: typeof f.label === 'string' ? f.label : undefined,
        isCustom: Boolean(f.isCustom),
        options: Array.isArray(f.options) ? (f.options as Array<Raw | string>).map((opt) => (typeof opt === 'string' ? opt : String(opt.value ?? opt.label ?? ''))).filter(Boolean) : undefined,
        rawOptions: Array.isArray(f.options) ? (f.options as Array<Raw | string>).filter((opt): opt is Raw => typeof opt === 'object' && opt !== null) : undefined,
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

  // ---------------------------------------------------------------------------
  // meetings: the workspace's own Meetings object
  // ---------------------------------------------------------------------------

  private meetingSchemaCache: { at: number; value: TwentyMeetingSchema | null } | null = null;

  /** The fields of a GraphQL type, with the object each link field points to. */
  private async typeFields(typeName: string): Promise<Array<{ name: string; objectType: string | null }>> {
    const data = await this.request<{ __type: { fields: Array<{ name: string; type: { kind: string; name: string | null; ofType: { kind: string; name: string | null } | null } }> } | null }>(
      `query TypeFields($name: String!) { __type(name: $name) { fields { name type { kind name ofType { kind name } } } } }`,
      { name: typeName },
    );
    return (data.__type?.fields ?? []).map((f) => ({ name: f.name, objectType: f.type.kind === 'OBJECT' ? f.type.name : f.type.ofType?.kind === 'OBJECT' ? f.type.ofType.name : null }));
  }

  /**
   * The Meetings object and its contacts object, read from the workspace's data model. Fields are
   * found by their label and type, links by the object they point to, so a field named a little
   * differently from the setup sheet still works. Read again every ten minutes.
   */
  async meetingSchema(): Promise<TwentyMeetingSchema | null> {
    if (this.meetingSchemaCache && Date.now() - this.meetingSchemaCache.at < 600_000) return this.meetingSchemaCache.value;
    const objects = await this.metadataObjects();
    const meeting = objects.find((o) => /^meetings?$/i.test(o.nameSingular)) ?? objects.find((o) => /meeting/i.test(o.nameSingular) && !/contact|attendee|calendar/i.test(o.nameSingular));
    if (!meeting) {
      this.meetingSchemaCache = { at: Date.now(), value: null };
      return null;
    }
    const contactObject = objects.find((o) => o !== meeting && /meeting.?(contact|attendee)/i.test(o.nameSingular));
    const typeOf = (nameSingular: string) => nameSingular.charAt(0).toUpperCase() + nameSingular.slice(1);
    const meetingType = typeOf(meeting.nameSingular);
    const label = (f: { name: string; label?: string }) => (f.label ?? f.name).toLowerCase();
    // Twenty's own fields (Creation date, Last update...) are never the team's: theirs come first.
    const SYSTEM = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt', 'createdBy', 'updatedBy', 'position', 'searchVector', 'name']);
    const finder = (object: (typeof objects)[number]) => {
      const candidates = object.fields.filter((f) => !SYSTEM.has(f.name)).sort((a, b) => Number(Boolean(b.isCustom)) - Number(Boolean(a.isCustom)));
      const find = (test: RegExp, types: string[]) => candidates.find((f) => types.includes(f.type) && test.test(label(f)));
      const tag = (test: RegExp, types: string[]) => {
        const f = find(test, types);
        return f ? { id: f.id, name: f.name, multi: f.type === 'MULTI_SELECT', text: f.type === 'TEXT', options: (f.rawOptions ?? []).map((o) => ({ value: String(o.value ?? ''), label: String(o.label ?? o.value ?? '') })).filter((o) => o.value) } : null;
      };
      const date = () => {
        const f = find(/date|when/, ['DATE_TIME', 'DATE']);
        return f ? { name: f.name, dateOnly: f.type === 'DATE' } : null;
      };
      return { find, tag, date };
    };
    const { find, tag } = finder(meeting);
    const fields = await this.typeFields(meetingType);
    const idFor = (list: typeof fields, target: string) => {
      const link = list.find((f) => f.objectType === target && list.some((x) => x.name === `${f.name}Id`));
      return link ? `${link.name}Id` : null;
    };
    let contact: TwentyMeetingSchema['contact'] = null;
    if (contactObject) {
      const contactFields = await this.typeFields(typeOf(contactObject.nameSingular));
      const meetingId = idFor(contactFields, meetingType);
      const personId = idFor(contactFields, this.s.objects.person.typeName);
      if (meetingId && personId) contact = { typeName: typeOf(contactObject.nameSingular), plural: contactObject.namePlural, meetingId, personId };
    }
    const value: TwentyMeetingSchema = {
      meeting: { typeName: meetingType, plural: meeting.namePlural, createdBy: fields.some((f) => f.name === 'createdBy') },
      fields: {
        date: finder(meeting).date(),
        bookedBy: tag(/booked/, ['SELECT', 'MULTI_SELECT', 'TEXT']),
        products: tag(/product/, ['MULTI_SELECT', 'SELECT']),
        team: tag(/team/, ['MULTI_SELECT']),
        recording: find(/recording/, ['LINKS'])?.name ?? null,
        cadenceLink: find(/cadence/, ['LINKS'])?.name ?? null,
        cadenceId: find(/cadence/, ['TEXT'])?.name ?? null,
        guests: find(/guest/, ['TEXT'])?.name ?? null,
        companyId: idFor(fields, this.s.objects.company.typeName),
        personId: idFor(fields, this.s.objects.person.typeName),
        assigneeId: idFor(fields, 'WorkspaceMember'),
        // "Meeting Number", "Meeting Count", "Meeting #", "Meeting No.".
        meetingNumber: find(/number|count|#|\bno\b/, ['NUMBER'])?.name ?? null,
        firstMeeting: find(/first/, ['BOOLEAN'])?.name ?? null,
      },
      contact,
    };
    this.meetingSchemaCache = { at: Date.now(), value };
    return value;
  }

  async saveMeetingRecord(schema: TwentyMeetingSchema, input: TwentyMeetingRecordInput): Promise<{ id: string }> {
    const t = schema.meeting.typeName;
    let id = input.id;
    // A record Cadence wrote but never heard back about (a timeout, a retry) is found by its Cadence ID.
    if (!id && schema.fields.cadenceId) {
      const found = await this.request<Record<string, Connection>>(
        `query FindMeeting($filter: ${t}FilterInput) { ${schema.meeting.plural}(filter: $filter, first: 1) { edges { node { id } } } }`,
        { filter: { [schema.fields.cadenceId]: { eq: input.cadenceId } } },
      );
      id = (connectionToArray(found[schema.meeting.plural])[0]?.id as string | undefined) ?? null;
    }
    if (id) {
      try {
        await this.request(`mutation UpdateMeeting($id: UUID!, $data: ${t}UpdateInput!) { update${t}(id: $id, data: $data) { id } }`, { id, data: input.data });
      } catch (err) {
        // Deleted in Twenty since: write it again.
        if (!/not found|does not exist|no record/i.test(err instanceof Error ? err.message : String(err))) throw err;
        id = null;
      }
    }
    if (!id) {
      const created = await this.request<Record<string, { id: string }>>(`mutation CreateMeeting($data: ${t}CreateInput!) { create${t}(data: $data) { id } }`, { data: input.data });
      id = created[`create${t}`].id;
    }
    try {
      if (schema.contact) await this.syncMeetingContacts(schema.contact, id, input.contacts);
    } catch (err) {
      // N16: the caller keeps the id of the record already made, so a retry does not make another.
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { meetingRecordId: id });
    }
    return { id };
  }

  /** The meeting's contact rows follow its attendees: missing ones added, removed ones deleted. */
  private async syncMeetingContacts(c: NonNullable<TwentyMeetingSchema['contact']>, meetingId: string, wanted: { personId: string; name: string }[]) {
    const rows = await this.request<Record<string, Connection>>(
      `query MeetingContacts($filter: ${c.typeName}FilterInput) { ${c.plural}(filter: $filter, first: 200) { edges { node { id name ${c.personId} } } } }`,
      { filter: { [c.meetingId]: { eq: meetingId } } },
    );
    const have = connectionToArray(rows[c.plural]).map((r) => ({ id: String(r.id), name: String(r.name ?? ''), personId: String(r[c.personId] ?? '') }));
    for (const row of have) {
      if (!wanted.some((w) => w.personId === row.personId)) await this.request(`mutation DeleteMeetingContact($id: UUID!) { delete${c.typeName}(id: $id) { id } }`, { id: row.id });
    }
    for (const w of wanted) {
      const row = have.find((h) => h.personId === w.personId);
      if (row && row.name !== w.name) await this.request(`mutation RenameMeetingContact($id: UUID!, $data: ${c.typeName}UpdateInput!) { update${c.typeName}(id: $id, data: $data) { id } }`, { id: row.id, data: { name: w.name } });
      if (row) continue;
      await this.request(`mutation CreateMeetingContact($data: ${c.typeName}CreateInput!) { create${c.typeName}(data: $data) { id } }`, { data: { name: w.name, [c.meetingId]: meetingId, [c.personId]: w.personId } });
    }
  }

  /** Every node of a listing, page by page. Too many to read whole is an error, never a partial list. */
  private async everyNode(plural: string, typeName: string, selection: string): Promise<Raw[]> {
    const nodes: Raw[] = [];
    let after: string | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const data: Record<string, Connection> = await this.request<Record<string, Connection>>(this.connectionQuery(plural, typeName, selection), { first: PAGE_SIZE, after });
      const conn = data[plural];
      nodes.push(...(conn?.edges ?? []).map((e) => e.node).filter((n): n is Raw => Boolean(n)));
      if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) return nodes;
      after = conn.pageInfo.endCursor;
    }
    throw new TwentyApiError(`${plural}: more than ${100 * PAGE_SIZE} records to read`);
  }

  async listMeetingRecords(schema: TwentyMeetingSchema): Promise<TwentyMeetingRecord[]> {
    const f = schema.fields;
    const scalars = [f.date?.name, f.bookedBy?.name, f.products?.name, f.team?.name, f.cadenceId, f.guests, f.companyId, f.personId, f.assigneeId, f.meetingNumber, f.firstMeeting];
    const links = [f.recording, f.cadenceLink].filter((n): n is string => Boolean(n)).map((n) => `${n} { primaryLinkUrl }`);
    const selection = [...new Set(['id', 'createdAt', 'updatedAt', 'name', ...scalars.filter((n): n is string => Boolean(n))]), ...links, ...(schema.meeting.createdBy ? ['createdBy { workspaceMemberId }'] : [])].join(' ');
    const c = schema.contact;
    const [records, contacts] = await Promise.all([
      this.everyNode(schema.meeting.plural, schema.meeting.typeName, selection),
      c ? this.everyNode(c.plural, c.typeName, `id ${c.meetingId} ${c.personId}`) : Promise.resolve([]),
    ]);
    const linked = new Map<string, string[]>();
    for (const row of contacts) {
      const meetingId = c && typeof row[c.meetingId] === 'string' ? (row[c.meetingId] as string) : null;
      const personId = c && typeof row[c.personId] === 'string' ? (row[c.personId] as string) : null;
      if (meetingId && personId) linked.set(meetingId, [...(linked.get(meetingId) ?? []), personId]);
    }
    return records.map((r) => {
      const { id, createdAt, updatedAt, createdBy, ...data } = r;
      return {
        id: String(id),
        createdAt: String(createdAt ?? ''),
        updatedAt: String(updatedAt ?? ''),
        addedByMemberId: typeof (createdBy as Raw | null)?.workspaceMemberId === 'string' ? ((createdBy as Raw).workspaceMemberId as string) : null,
        data,
        contactPersonIds: [...new Set(linked.get(String(id)) ?? [])],
      };
    });
  }

  async deleteMeetingRecord(schema: TwentyMeetingSchema, id: string): Promise<void> {
    if (schema.contact) await this.syncMeetingContacts(schema.contact, id, []);
    const t = schema.meeting.typeName;
    await this.request(`mutation DeleteMeeting($id: UUID!) { delete${t}(id: $id) { id } }`, { id });
  }

  /** N14: tags the CRM refused to add, and when: not asked again (a data model read and a write each) for six hours. */
  private refusedOptions = new Map<string, number>();

  /** A new tag on a Select or Multi-select field, when the API key may change the data model. */
  async addSelectOption(field: TwentyTagField, label: string): Promise<string | null> {
    const value = label.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'OPTION';
    const refusedKey = `${field.id}|${value}`;
    if (Date.now() - (this.refusedOptions.get(refusedKey) ?? -Infinity) < 6 * 3600_000) return null;
    try {
      const objects = await this.metadataObjects();
      const current = objects.flatMap((o) => o.fields).find((f) => f.id === field.id);
      const raw = current?.rawOptions ?? [];
      if (raw.some((o) => String(o.value) === value)) return value;
      const options = [...raw, { id: randomUUID(), label, value, color: 'gray', position: raw.length }];
      await this.request(`mutation AddOption($input: UpdateOneFieldMetadataInput!) { updateOneField(input: $input) { id } }`, { input: { id: field.id, update: { options } } }, 'metadata');
      this.meetingSchemaCache = null;
      return value;
    } catch (err) {
      console.warn(`[twenty] could not add the tag "${label}": ${err instanceof Error ? err.message : String(err)}`);
      this.refusedOptions.set(refusedKey, Date.now());
      return null;
    }
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

  async ping(): Promise<{ ok: true; detail: string; members: number; people?: number }> {
    const [members, people] = await Promise.all([this.listWorkspaceMembers(), this.countRecords('person')]);
    return { ok: true, detail: `Connected to ${this.opts.baseUrl}`, members: members.length, ...(people === null ? {} : { people }) };
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
