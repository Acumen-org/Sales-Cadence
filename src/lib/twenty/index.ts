import { randomUUID } from 'node:crypto';
import { env } from '../env';
import { prisma } from '../db';
import { getTwentyConnection, getTwentySchema } from '../settings';
import type { TwentyClient } from './client';
import { TwentyGraphqlClient } from './graphql-client';
import { getMockTwentyClient } from './mock-client';
import type { CreateNoteInput, CreateTaskInput, UpdateTaskInput, EnrichPersonInput, EnrichCompanyInput, TwentyPerson, TwentyCompany } from './types';

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
  async enrichPerson(id: string, patch: EnrichPersonInput, current?: TwentyPerson) {
    const record = current ?? await this.inner.getPerson(id);
    if (!record) throw new Error('This contact no longer exists in Twenty.');
    await this.record('enrichPerson', 'person', { id, ...patch }, id);
    return record;
  }
  async enrichCompany(id: string, patch: EnrichCompanyInput, current?: TwentyCompany) {
    const record = current ?? (await this.inner.listCompanies({ ids: [id], limit: 1 })).items[0];
    if (!record) throw new Error('This account no longer exists in Twenty.');
    await this.record('enrichCompany', 'company', { id, ...patch }, id);
    return record;
  }
}

// globalThis so every Next.js bundle in the process shares one client instance (and its field cache).
const g = globalThis as unknown as { __cadenceTwentyClient?: { key: string; client: TwentyClient } };

/**
 * The client the app should use right now: mock or GraphQL (per settings/env),
 * wrapped in dry-run when CADENCE_DRY_RUN=true.
 */
export async function getTwentyClient(): Promise<TwentyClient> {
  const conn = await getTwentyConnection();
  let base: TwentyClient;
  if (conn.mode === 'mock') {
    // The built-in fake CRM only serves development and the test suites. Without the explicit
    // opt-out a deployment that is misconfigured fails loudly here rather than quietly running
    // an entire sales team against invented contacts.
    if (env().CADENCE_ALLOW_MOCK !== '1') {
      throw new Error('TWENTY_MODE=mock needs CADENCE_ALLOW_MOCK=1. Set TWENTY_MODE=graphql and configure TWENTY_API_URL and TWENTY_API_KEY.');
    }
    base = getMockTwentyClient();
  } else {
    if (!conn.baseUrl || !conn.apiKey) {
      throw new Error('TWENTY_MODE=graphql but TWENTY_API_URL / TWENTY_API_KEY are not configured (env or Settings > Twenty).');
    }
    const schema = await getTwentySchema();
    const key = `${conn.baseUrl}|${conn.apiKey}|${JSON.stringify(schema)}`;
    if (!g.__cadenceTwentyClient || g.__cadenceTwentyClient.key !== key) {
      g.__cadenceTwentyClient = { key, client: new TwentyGraphqlClient({ baseUrl: conn.baseUrl, apiKey: conn.apiKey, schema }) };
    }
    base = g.__cadenceTwentyClient.client;
  }
  return conn.dryRun ? new DryRunTwentyClient(base) : base;
}

export type { TwentyClient } from './client';
