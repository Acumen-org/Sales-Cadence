import { describe, expect, it } from 'vitest';
import { TwentyGraphqlClient } from '@/lib/twenty/graphql-client';
import { mergeTwentySchema } from '@/lib/twenty/twenty-schema';

type Call = { query: string; variables: Record<string, unknown> };

function client(handler: (call: Call) => Response | unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body)) as Call;
    calls.push(call);
    if (call.query.includes('CreateInputFields')) return new Response(JSON.stringify({ data: { __type: { inputFields: [{ name: 'id' }, { name: 'title' }] } } }));
    if (call.query.includes('__type')) return new Response(JSON.stringify({ data: { __type: null } }));
    const out = handler(call);
    return out instanceof Response ? out : new Response(JSON.stringify(out));
  }) as typeof fetch;
  return { twenty: new TwentyGraphqlClient({ baseUrl: 'https://twenty.example', apiKey: 'k', schema: mergeTwentySchema(), fetchImpl }), calls };
}

const creates = (calls: Call[], name: string) => calls.filter((c) => c.query.includes(`mutation ${name}(`)).length;

describe('N05: a create is never sent twice blindly', () => {
  it('a create answered with a 5xx is not re-sent', async () => {
    const { twenty, calls } = client((c) => (c.query.includes('mutation CreateNote(') ? new Response('bad gateway', { status: 502 }) : { data: {} }));
    await expect(twenty.createNote({ title: 'Call', bodyMarkdown: 'b', personId: 'p-1' })).rejects.toThrow(/502/);
    expect(creates(calls, 'CreateNote')).toBe(1);
  });

  it('after a lost answer the note is found by its id marker, and only its missing link is added', async () => {
    const marker = '6f1c1d2e-0000-4000-8000-000000000001';
    const { twenty, calls } = client((c) => {
      if (c.query.includes('mutation CreateNote(')) return new Response('timeout', { status: 504 });
      if (c.query.includes('mutation CreateNoteTarget(')) return { data: { createNoteTarget: { id: 'nt-1' } } };
      if (c.query.includes('notes(')) return { data: { notes: { edges: [{ node: { id: marker, title: 'Call', noteTargets: { edges: [] } } }], pageInfo: { hasNextPage: false, endCursor: null } } } };
      return { data: {} };
    });
    expect(await twenty.createNote({ id: marker, title: 'Call', bodyMarkdown: 'b', personId: 'p-1' })).toEqual({ id: marker });
    expect(creates(calls, 'CreateNote')).toBe(1);
    expect(calls.find((c) => c.query.includes('mutation CreateNote('))!.variables.data).toMatchObject({ id: marker });
    expect(creates(calls, 'CreateNoteTarget')).toBe(1);
  });
});

describe('N06: additional emails when looking for an existing CRM person', () => {
  const person = { id: 'p-9', name: { firstName: 'John', lastName: 'Smith' }, emails: { primaryEmail: 'js@other.example', additionalEmails: ['John.Smith@Firm.com'] }, deletedAt: null };
  const empty = { data: { people: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } };

  it('are compared without regard to case', async () => {
    const { twenty, calls } = client((c) => {
      const filter = JSON.stringify(c.variables.filter ?? {});
      return filter.includes('additionalEmails') && filter.includes('ilike') ? { data: { people: { edges: [{ node: person }], pageInfo: { hasNextPage: false, endCursor: null } } } } : empty;
    });
    expect((await twenty.findPeople({ emails: ['John.Smith@Firm.com'] })).map((p) => p.id)).toEqual(['p-9']);
    expect(JSON.stringify(calls.find((c) => JSON.stringify(c.variables.filter ?? {}).includes('additionalEmails'))!.variables.filter)).toContain('john.smith@firm.com');
  });

  it('a failure of that second look fails the lookup instead of being swallowed', async () => {
    const { twenty } = client((c) => (JSON.stringify(c.variables.filter ?? {}).includes('additionalEmails') ? new Response('down', { status: 503 }) : empty));
    await expect(twenty.findPeople({ emails: ['john.smith@firm.com'] })).rejects.toThrow(/503/);
  });
});

describe('N08: a note or task whose link to the person fails is not left attached to nobody', () => {
  it('without an id marker the half-made note is removed before the write is queued again', async () => {
    const { twenty, calls } = client((c) => {
      if (c.query.includes('mutation CreateNote(')) return { data: { createNote: { id: 'n-1' } } };
      if (c.query.includes('mutation CreateNoteTarget(')) return new Response('bad request', { status: 400 });
      return { data: { deleteNote: { id: 'n-1' } } };
    });
    await expect(twenty.createNote({ title: 'Call', bodyMarkdown: 'b', personId: 'p-1' })).rejects.toThrow(/400/);
    expect(calls.find((c) => c.query.includes('mutation DeleteNote('))?.variables).toEqual({ id: 'n-1' });
  });

  it('with an id marker the task is kept, for the replay to find and link', async () => {
    const { twenty, calls } = client((c) => {
      if (c.query.includes('mutation CreateTask(')) return { data: { createTask: { id: '6f1c1d2e-0000-4000-8000-000000000002' } } };
      if (c.query.includes('mutation CreateTaskTarget(')) return new Response('bad request', { status: 400 });
      return { data: {} };
    });
    await expect(twenty.createTask({ id: '6f1c1d2e-0000-4000-8000-000000000002', title: 'T', personId: 'p-1' })).rejects.toThrow(/400/);
    expect(calls.some((c) => c.query.includes('mutation DeleteTask('))).toBe(false);
  });
});
