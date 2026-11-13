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
