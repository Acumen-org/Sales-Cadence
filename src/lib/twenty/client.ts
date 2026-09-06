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
  includeDeleted?: boolean;
};

/**
 * Everything Cadence needs from Twenty. Two implementations:
 * MockTwentyClient (fixtures, used in development and tests) and
 * TwentyGraphqlClient (real workspace). Writes go through DryRunTwentyClient
 * when CADENCE_DRY_RUN=true.
 */
export interface TwentyClient {
  readonly kind: 'mock' | 'graphql' | 'dry-run';

  // ---- people & companies ----
  listPeople(opts?: ListPeopleOptions): Promise<Page<TwentyPerson>>;
  getPerson(id: string): Promise<TwentyPerson | null>;
  getPeopleByIds(ids: string[]): Promise<TwentyPerson[]>;
  listCompanies(opts?: ListOptions & { ids?: string[] }): Promise<Page<TwentyCompany>>;
  listWorkspaceMembers(): Promise<TwentyWorkspaceMember[]>;
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

  // ---- schema ----
  introspect(): Promise<TwentyIntrospection>;
  /** Cheap connectivity check; throws with a readable message on failure. */
  ping(): Promise<{ ok: true; detail: string }>;
}

/** Iterate every page of a paginated list. */
export async function* paginate<T>(
  fetchPage: (after: string | null) => Promise<Page<T>>,
  maxPages = 1000,
): AsyncGenerator<T, void, undefined> {
  let after: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page: Page<T> = await fetchPage(after);
    for (const item of page.items) yield item;
    if (!page.hasNextPage || !page.endCursor) return;
    after = page.endCursor;
  }
}

export async function collectAll<T>(fetchPage: (after: string | null) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of paginate(fetchPage)) out.push(item);
  return out;
}
