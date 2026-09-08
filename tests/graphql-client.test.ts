import { describe, expect, it } from 'vitest';
import { TwentyApiError, TwentyGraphqlClient, translateViewFilter } from '@/lib/twenty/graphql-client';
import { defaultTwentySchema, mergeTwentySchema } from '@/lib/twenty/twenty-schema';

type Call = { url: string; query: string; variables: Record<string, unknown> };

const ALL_FIELDS = [
  'id', 'name', 'emails', 'phones', 'linkedinLink', 'jobTitle', 'city', 'companyId', 'company', 'dnd', 'podOwner', 'assignedToId', 'tags', 'leadSource',
  'tier', 'contactType', 'listCategory', 'pipelineStageField', 'nextAction', 'nextActionDueDate', 'nextStep', 'lastNote', 'meetingTime',
  'createdAt', 'updatedAt', 'deletedAt', 'title', 'bodyV2', 'createdBy', 'noteTargets', 'subject', 'receivedAt', 'messageThreadId', 'messageParticipants',
  'status', 'dueAt', 'assigneeId', 'taskTargets', 'stage', 'pointOfContactId', 'userEmail', 'timeZone', 'domainName', 'cadenceTaskId',
];

/** Build a client whose fetch answers from a handler; records every call. */
function fakeClient(handler: (call: Call) => unknown, opts: { schema?: ReturnType<typeof mergeTwentySchema>; fieldsWithout?: string[] } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const call = { url: String(url), query: body.query, variables: body.variables ?? {} };
    calls.push(call);
    if (call.query.includes('__type')) {
      const fields = ALL_FIELDS.filter((f) => !(opts.fieldsWithout ?? []).includes(f)).map((name) => ({ name }));
      return new Response(JSON.stringify({ data: { __type: { fields } } }), { status: 200 });
    }
    const result = handler(call);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  const client = new TwentyGraphqlClient({ baseUrl: 'https://twenty.example.com/', apiKey: 'k', schema: opts.schema ?? mergeTwentySchema(), fetchImpl });
  return { client, calls };
}

const rawPerson = {
  id: 'p-1',
  name: { firstName: 'Nina', lastName: 'Halvorsen' },
  emails: { primaryEmail: 'nina@acme.example' },
  phones: { primaryPhoneNumber: '7946 1001', primaryPhoneCallingCode: '+44' },
  linkedinLink: { primaryLinkUrl: 'https://linkedin.com/in/nina' },
  jobTitle: 'VP Operations',
  companyId: 'c-1',
  company: { id: 'c-1', name: 'Acme Logistics' },
  dnd: null,
  podOwner: 'ALISA',
  assignedToId: 'wm-1',
  tags: ['KANBAN_OPPORTUNITY'],
  leadSource: ['FPA_WISCONSIN_JULY_2026'],
  tier: 'LEVEL_2',
  contactType: ['PROSPECT'],
  listCategory: 'MONTHLY',
  nextAction: 'FU-2',
  nextActionDueDate: '2026-09-12',
  nextStep: 'EMAIL',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  deletedAt: null,
};

describe('TwentyGraphqlClient', () => {
  it('lists people with a since filter, paginates, and normalises records', async () => {
    const { client, calls } = fakeClient((call) => {
      if (call.query.includes('people(')) {
        return { data: { people: { edges: [{ node: rawPerson, cursor: 'c1' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } } };
      }
      throw new Error(`unexpected query ${call.query}`);
    });
    const page = await client.listPeople({ updatedSince: '2026-08-31T00:00:00.000Z', limit: 10 });
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe('c1');
    const p = page.items[0];
    expect(p).toMatchObject({
      id: 'p-1',
      firstName: 'Nina',
      email: 'nina@acme.example',
      phone: '+44 7946 1001',
      companyName: 'Acme Logistics',
      podOwner: 'ALISA',
      ownerMemberId: 'wm-1',
      dnd: false,
      tags: ['KANBAN_OPPORTUNITY'],
      leadSource: ['FPA_WISCONSIN_JULY_2026'],
      tier: 'LEVEL_2',
      contactType: ['PROSPECT'],
      listCategory: 'MONTHLY',
      nextAction: 'FU-2',
      nextActionDueDate: '2026-09-12',
      nextStep: 'EMAIL',
    });
    // Fields the workspace does not have are trimmed from the selection and read as null.
    expect(p.recordingUrl).toBeNull();
    expect(p.bookingId).toBeNull();
    const listCall = calls.find((c) => c.query.includes('people('))!;
    expect(listCall.url).toBe('https://twenty.example.com/graphql');
    expect(listCall.variables.filter).toEqual({ updatedAt: { gte: '2026-08-31T00:00:00.000Z' } });
    expect(listCall.variables.first).toBe(10);
    expect(listCall.query).not.toContain('salesCallRecordingLink');
    expect(listCall.query).toContain('podOwner');
    expect(listCall.query).toContain('assignedToId');
    expect(listCall.query).toContain('nextActionDueDate');
  });

  it('honours renamed fields from the mapping', async () => {
    const schema = mergeTwentySchema({ person: { dnd: 'doNotContact', assignedToId: 'accountOwnerId' } });
    const { client, calls } = fakeClient(
      () => ({ data: { people: { edges: [{ node: { ...rawPerson, doNotContact: true, accountOwnerId: 'wm-9' } }], pageInfo: { hasNextPage: false, endCursor: null } } } }),
      { schema, fieldsWithout: ['dnd', 'assignedToId'] },
    );
    // pretend the workspace has the renamed fields
    const origFetch = client as unknown as { fetchImpl: typeof fetch };
    void origFetch;
    const page = await client.listPeople({ ids: ['p-1'] });
    const call = calls.find((c) => c.query.includes('people('))!;
    expect(call.variables.filter).toEqual({ id: { in: ['p-1'] } });
    expect(page.items[0].ownerMemberId).toBe('wm-9');
  });

  it('creates a note then its target, and updates/deletes tasks with the mapped names', async () => {
    const { client, calls } = fakeClient((call) => {
      if (call.query.includes('createNote(')) return { data: { createNote: { id: 'n-1' } } };
      if (call.query.includes('createNoteTarget(')) return { data: { createNoteTarget: { id: 'nt-1' } } };
      if (call.query.includes('createTask(')) return { data: { createTask: { id: 't-1' } } };
      if (call.query.includes('createTaskTarget(')) return { data: { createTaskTarget: { id: 'tt-1' } } };
      if (call.query.includes('updateTask(')) return { data: { updateTask: { id: 't-1' } } };
      if (call.query.includes('deleteTask(')) return { data: { deleteTask: { id: 't-1' } } };
      throw new Error(`unexpected ${call.query}`);
    });
    expect(await client.createNote({ title: '[Cadence] Email 1 sent by Alisa', bodyMarkdown: 'body', personId: 'p-1' })).toEqual({ id: 'n-1' });
    const noteCall = calls.find((c) => c.query.includes('createNote('))!;
    expect(noteCall.variables.data).toEqual({ title: '[Cadence] Email 1 sent by Alisa', bodyV2: { markdown: 'body' } });
    const targetCall = calls.find((c) => c.query.includes('createNoteTarget('))!;
    expect(targetCall.variables.data).toEqual({ noteId: 'n-1', personId: 'p-1' });

    expect(await client.createTask({ title: 'Cadence: Email 1 - Nina', personId: 'p-1', dueAt: '2026-09-07T08:00:00.000Z', assigneeMemberId: 'wm-1', cadenceTaskId: 'ct-1' })).toEqual({ id: 't-1' });
    const taskCall = calls.find((c) => c.query.includes('createTask('))!;
    expect(taskCall.variables.data).toMatchObject({ title: 'Cadence: Email 1 - Nina', status: 'TODO', dueAt: '2026-09-07T08:00:00.000Z', assigneeId: 'wm-1', cadenceTaskId: 'ct-1' });
    await client.updateTask('t-1', { status: 'DONE' });
    expect(calls.find((c) => c.query.includes('updateTask('))!.variables).toEqual({ id: 't-1', data: { status: 'DONE' } });
    await client.deleteTask('t-1');
    expect(calls.find((c) => c.query.includes('deleteTask('))!.variables).toEqual({ id: 't-1' });
  });

  it('lifts notes and messages for a person through their target/participant tables', async () => {
    const { client, calls } = fakeClient((call) => {
      if (call.query.includes('noteTargets(')) {
        return { data: { noteTargets: { edges: [{ node: { note: { id: 'n-1', title: '[CALL] Outbound Call by tw_alisa', createdBy: { workspaceMemberId: 'wm-1', name: 'Alisa' }, noteTargets: { edges: [{ node: { personId: 'p-1' } }] }, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' } } }], pageInfo: { hasNextPage: false } } } };
      }
      if (call.query.includes('messageParticipants(')) {
        const message = { id: 'm-1', subject: 'Hi', receivedAt: '2026-09-01T00:00:00Z', messageParticipants: { edges: [{ node: { id: 'x', role: 'from', handle: 'alisa@acumen.example', workspaceMemberId: 'wm-1' } }, { node: { id: 'y', role: 'to', handle: 'nina@acme.example', personId: 'p-1' } }] } };
        return { data: { messageParticipants: { edges: [{ node: { message } }, { node: { message } }], pageInfo: { hasNextPage: false } } } };
      }
      throw new Error(`unexpected ${call.query}`);
    });
    const notes = await client.listNotes({ personId: 'p-1', limit: 5 });
    expect(notes.items[0]).toMatchObject({ id: 'n-1', createdByMemberId: 'wm-1', personIds: ['p-1'] });
    expect(calls.find((c) => c.query.includes('noteTargets('))!.variables.filter).toEqual({ personId: { eq: 'p-1' } });
    const messages = await client.listMessages({ personId: 'p-1' });
    expect(messages.items).toHaveLength(1); // deduplicated across participants
    expect(messages.items[0].participants.map((p) => p.role)).toEqual(['from', 'to']);
  });

  it('surfaces GraphQL and HTTP errors with readable messages', async () => {
    const { client } = fakeClient(() => ({ errors: [{ message: 'Cannot query field "dnd"' }] }));
    await expect(client.listPeople()).rejects.toThrow(/Cannot query field "dnd"/);
    const { client: unauthorised } = fakeClient(() => new Response('Unauthorized', { status: 401 }));
    await expect(unauthorised.listPeople()).rejects.toBeInstanceOf(TwentyApiError);
    await expect(unauthorised.listPeople()).rejects.toThrow(/401/);
  });

  it('introspects via the metadata API and extracts select options', async () => {
    const { client } = fakeClient((call) => {
      if (call.url.endsWith('/metadata')) {
        return {
          data: {
            objects: {
              edges: [
                {
                  node: {
                    id: 'obj-person',
                    nameSingular: 'person',
                    namePlural: 'people',
                    fields: { edges: [{ node: { id: 'f1', name: 'podOwner', type: 'SELECT', options: [{ value: 'ALISA', label: 'Alisa' }, { value: 'LEIGH', label: 'Leigh' }] } }, { node: { id: 'f2', name: 'dnd', type: 'BOOLEAN' } }] },
                  },
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected ${call.query}`);
    });
    const intro = await client.introspect();
    expect(intro.source).toBe('metadata');
    expect(intro.objects[0].fields.find((f) => f.name === 'podOwner')?.options).toEqual(['ALISA', 'LEIGH']);
  });

  it('translates simple view filters', () => {
    expect(translateViewFilter({ name: 'podOwner', type: 'SELECT' }, 'is', '["ALISA"]')).toEqual({ podOwner: { in: ['ALISA'] } });
    expect(translateViewFilter({ name: 'jobTitle', type: 'TEXT' }, 'contains', 'VP')).toEqual({ jobTitle: { ilike: '%VP%' } });
    expect(translateViewFilter({ name: 'dnd', type: 'BOOLEAN' }, 'is', 'false')).toEqual({ dnd: { eq: false } });
    expect(translateViewFilter({ name: 'company', type: 'RELATION' }, 'is', '["c-1"]')).toEqual({ companyId: { in: ['c-1'] } });
    expect(translateViewFilter({ name: 'leadSource', type: 'MULTI_SELECT' }, 'isNotEmpty', '')).toEqual({ leadSource: { is: 'NOT_NULL' } });
    expect(() => translateViewFilter({ name: 'x', type: 'TEXT' }, 'weird', '')).toThrow(/not supported/);
  });

  it('uses the default schema object names', () => {
    expect(defaultTwentySchema.objects.person.plural).toBe('people');
    expect(defaultTwentySchema.objects.noteTarget.typeName).toBe('NoteTarget');
  });
});
