import type {
  CreateNoteInput,
  CreateTaskInput,
  Page,
  TwentyCompany,
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

export type ListOptions = {
  /** ISO timestamp; only records updated at or after this instant. */
  updatedSince?: string;
  after?: string | null;
  limit?: number;
};

export type ListPeopleOptions = ListOptions & {
  ids?: string[];
  podOwner?: string;
  companyId?: string;
  includeDeleted?: boolean;
  /** Only records soft-deleted at or after this instant. Twenty does not bump updatedAt on delete. */
  deletedSince?: string;
};

/**
 * Everything Cadence needs from Twenty. Two implementations:
 * MockTwentyClient (fixtures, used in development and tests) and
 * TwentyGraphqlClient (real workspace). Writes go through DryRunTwentyClient
 * when CADENCE_DRY_RUN=true.
 */
/** What a connection check found: reachable, and how much is on the other side. */
export type TwentyPing = { ok: true; detail: string; people?: number; members?: number };

export interface TwentyClient {
  readonly kind: 'mock' | 'graphql' | 'dry-run';

  // ---- people & companies ----
  listPeople(opts?: ListPeopleOptions): Promise<Page<TwentyPerson>>;
  getPerson(id: string): Promise<TwentyPerson | null>;
  getPeopleByIds(ids: string[]): Promise<TwentyPerson[]>;
  listCompanies(opts?: ListOptions & { ids?: string[]; deletedSince?: string }): Promise<Page<TwentyCompany>>;
  listWorkspaceMembers(): Promise<TwentyWorkspaceMember[]>;
  /** Live records in Twenty, to compare the cache against; null when the source cannot say. */
  countRecords(object: 'person' | 'company'): Promise<number | null>;
  /** Resolve a saved Twenty view of people to the people it contains. */
  getViewPeople(viewId: string): Promise<{ view: TwentyView; people: TwentyPerson[] }>;

  // ---- activity ----
  listNotes(opts?: ListOptions & { personId?: string }): Promise<Page<TwentyNote>>;
  getNote(id: string): Promise<TwentyNote | null>;
  listMessages(opts?: ListOptions & { personId?: string }): Promise<Page<TwentyMessage>>;
  getMessage(id: string): Promise<TwentyMessage | null>;
  listTasks(opts?: ListOptions & { personId?: string }): Promise<Page<TwentyTask>>;
  getTask(id: string): Promise<TwentyTask | null>;
  listOpportunities(opts?: ListOptions & { personId?: string }): Promise<Page<TwentyOpportunity>>;

  // ---- writes (Cadence only edits records it created) ----
  createNote(input: CreateNoteInput): Promise<{ id: string }>;
  createTask(input: CreateTaskInput): Promise<{ id: string }>;
  updateTask(id: string, patch: UpdateTaskInput): Promise<void>;
  deleteTask(id: string): Promise<void>;
  /** Explicitly reviewed enrichment; unlike task writes, this updates existing CRM records. */
  enrichPerson(id: string, patch: EnrichPersonInput, current?: TwentyPerson): Promise<TwentyPerson>;
  enrichCompany(id: string, patch: EnrichCompanyInput, current?: TwentyCompany): Promise<TwentyCompany>;

  // ---- schema ----
  introspect(): Promise<TwentyIntrospection>;
  /** Cheap connectivity check; throws with a readable message on failure. */
  ping(): Promise<TwentyPing>;
}

/** Iterate every page of a paginated list. */
export async function* paginate<T>(
  fetchPage: (after: string | null) => Promise<Page<T>>,
  maxPages = 1000,
): AsyncGenerator<T, void, undefined> {
  let after: string | null = null;
  const cursors = new Set<string>();
  for (let i = 0; i < maxPages; i++) {
    const page: Page<T> = await fetchPage(after);
    for (const item of page.items) yield item;
    if (!page.hasNextPage) return;
    if (!page.endCursor || cursors.has(page.endCursor)) throw new Error('Twenty pagination did not advance; sync is incomplete.');
    cursors.add(page.endCursor);
    after = page.endCursor;
  }
  throw new Error(`Twenty pagination exceeded ${maxPages} pages; sync is incomplete.`);
}

export async function collectAll<T>(fetchPage: (after: string | null) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of paginate(fetchPage)) out.push(item);
  return out;
}
