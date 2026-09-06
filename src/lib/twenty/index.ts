import { randomUUID } from 'node:crypto';
import { prisma } from '../db';
import { getTwentyConnection, getTwentySchema } from '../settings';
import type { TwentyClient } from './client';
import { TwentyGraphqlClient } from './graphql-client';
import { getMockTwentyClient } from './mock-client';
import type { CreateNoteInput, CreateTaskInput, UpdateTaskInput } from './types';

/**
 * CADENCE_DRY_RUN=true: reads pass through, writes are logged (console + TwentyWrite
 * table with dryRun=true) and return fake ids. Nothing reaches Twenty.
 */
export class DryRunTwentyClient implements TwentyClient {
  readonly kind = 'dry-run' as const;
  constructor(private readonly inner: TwentyClient) {}

  private async record(operation: string, objectType: string, payload: unknown, twentyId?: string) {
    console.info(`[twenty:dry-run] ${operation} ${objectType}`, JSON.stringify(payload));
    try {
      await prisma.twentyWrite.create({
        data: { operation, objectType, twentyId: twentyId ?? null, payload: payload as object, dryRun: true },
      });
    } catch (err) {
      console.warn('[twenty:dry-run] could not persist write log', err);
    }
  }

  listPeople: TwentyClient['listPeople'] = (o) => this.inner.listPeople(o);
  getPerson: TwentyClient['getPerson'] = (id) => this.inner.getPerson(id);
  getPeopleByIds: TwentyClient['getPeopleByIds'] = (ids) => this.inner.getPeopleByIds(ids);
  listCompanies: TwentyClient['listCompanies'] = (o) => this.inner.listCompanies(o);
  listWorkspaceMembers: TwentyClient['listWorkspaceMembers'] = () => this.inner.listWorkspaceMembers();
  getViewPeople: TwentyClient['getViewPeople'] = (id) => this.inner.getViewPeople(id);
  listNotes: TwentyClient['listNotes'] = (o) => this.inner.listNotes(o);
  getNote: TwentyClient['getNote'] = (id) => this.inner.getNote(id);
  listMessages: TwentyClient['listMessages'] = (o) => this.inner.listMessages(o);
  getMessage: TwentyClient['getMessage'] = (id) => this.inner.getMessage(id);
  listTasks: TwentyClient['listTasks'] = (o) => this.inner.listTasks(o);
  getTask: TwentyClient['getTask'] = (id) => this.inner.getTask(id);
  listOpportunities: TwentyClient['listOpportunities'] = (o) => this.inner.listOpportunities(o);
  introspect: TwentyClient['introspect'] = () => this.inner.introspect();
  ping: TwentyClient['ping'] = async () => {
    const r = await this.inner.ping();
    return { ok: true as const, detail: `${r.detail} (dry run: writes disabled)` };
  };

  async createNote(input: CreateNoteInput) {
    const id = `dry-note-${randomUUID()}`;
    await this.record('createNote', 'note', input, id);
    return { id };
  }
  async createTask(input: CreateTaskInput) {
    const id = `dry-task-${randomUUID()}`;
    await this.record('createTask', 'task', input, id);
    return { id };
  }
  async updateTask(id: string, patch: UpdateTaskInput) {
    await this.record('updateTask', 'task', { id, ...patch }, id);
  }
  async deleteTask(id: string) {
    await this.record('deleteTask', 'task', { id }, id);
  }
}

let cachedReal: { key: string; client: TwentyClient } | undefined;

/**
 * The client the app should use right now: mock or GraphQL (per settings/env),
 * wrapped in dry-run when CADENCE_DRY_RUN=true.
 */
export async function getTwentyClient(): Promise<TwentyClient> {
  const conn = await getTwentyConnection();
  let base: TwentyClient;
  if (conn.mode === 'mock') {
    base = getMockTwentyClient();
  } else {
    if (!conn.baseUrl || !conn.apiKey) {
      throw new Error('TWENTY_MODE=graphql but TWENTY_API_URL / TWENTY_API_KEY are not configured (env or Settings > Twenty).');
    }
    const schema = await getTwentySchema();
    const key = `${conn.baseUrl}|${conn.apiKey}|${JSON.stringify(schema)}`;
    if (!cachedReal || cachedReal.key !== key) {
      cachedReal = { key, client: new TwentyGraphqlClient({ baseUrl: conn.baseUrl, apiKey: conn.apiKey, schema }) };
    }
    base = cachedReal.client;
  }
  return conn.dryRun ? new DryRunTwentyClient(base) : base;
}

export type { TwentyClient } from './client';
