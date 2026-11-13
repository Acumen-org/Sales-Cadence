import { describe, expect, it, vi } from 'vitest';
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

describe('N11: the data model read is not kept for ever', () => {
  it('a failed first read is tried again a minute later, so Do not contact writes recover without a restart', async () => {
    let down = true;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as Call;
      if (call.query.includes('query Fields(')) {
        if (down) return new Response('timeout', { status: 504 });
        return new Response(JSON.stringify({ data: { __type: { fields: [{ name: 'id' }, { name: 'dnd' }] } } }));
      }
      return new Response(JSON.stringify({ data: { updatePerson: { id: 'p-1' } } }));
    }) as typeof fetch;
    const twenty = new TwentyGraphqlClient({ baseUrl: 'https://twenty.example', apiKey: 'k', schema: mergeTwentySchema(), fetchImpl });
    twenty.sleep = async () => {};
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      await expect(twenty.setPersonDnd('p-1', { dnd: true })).rejects.toThrow(/could not be verified/);
      down = false;
      clock.mockReturnValue(t0 + 61_000);
      await expect(twenty.setPersonDnd('p-1', { dnd: true })).resolves.toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('N16, N14: meeting records in the CRM', () => {
  const schema = { meeting: { typeName: 'Meeting', plural: 'meetings', createdBy: false }, fields: { cadenceId: null } as never, contact: { typeName: 'MeetingContact', plural: 'meetingContacts', meetingId: 'meetingId', personId: 'personId' } };

  it('N16: when the contacts fail after the record is made, the error carries its id', async () => {
    const { twenty } = client((c) => {
      if (c.query.includes('mutation CreateMeeting(')) return { data: { createMeeting: { id: 'mt-1' } } };
      if (c.query.includes('query MeetingContacts(')) return new Response('down', { status: 503 });
      return { data: {} };
    });
    twenty.sleep = async () => {};
    const err = await twenty.saveMeetingRecord(schema as never, { id: null, cadenceId: 'c-1', data: { name: 'M' }, contacts: [{ personId: 'p-1', name: 'M · P' }] }).catch((e) => e);
    expect(err).toMatchObject({ meetingRecordId: 'mt-1' });
  });

  it('N14: a tag the CRM refused is not asked for again at every meeting', async () => {
    const { twenty, calls } = client((c) => (c.query.includes('AddOption') ? new Response('forbidden', { status: 403 }) : { data: { objects: { edges: [] } } }));
    const field = { id: 'f-1', name: 'products', multi: true, text: false, options: [] };
    expect(await twenty.addSelectOption(field, 'New Product')).toBeNull();
    const before = calls.length;
    expect(await twenty.addSelectOption(field, 'New Product')).toBeNull();
    expect(calls.length).toBe(before);
  });
});

describe('N19: listings of all notes, mail, tasks and opportunities', () => {
  it('are not ordered by a timestamp, which Twenty cuts short on ties', async () => {
    const { twenty, calls } = client(() => ({ data: { notes: { edges: [] }, messages: { edges: [] }, tasks: { edges: [] }, opportunities: { edges: [] } } }));
    await twenty.listNotes({ updatedSince: '2026-11-01T00:00:00Z' });
    await twenty.listMessages({ updatedSince: '2026-11-01T00:00:00Z' });
    await twenty.listTasks({ updatedSince: '2026-11-01T00:00:00Z' });
    await twenty.listOpportunities({ updatedSince: '2026-11-01T00:00:00Z' });
    const listings = calls.filter((c) => c.query.startsWith('query List('));
    expect(listings).toHaveLength(4);
    for (const c of listings) expect(c.variables.orderBy).toBeUndefined();
  });
});

describe('N33: reads that asked for one page', () => {
  it('workspace members and companies by domain are read past the first page', async () => {
    const page = (plural: string, nodes: unknown[], next: string | null) => ({ data: { [plural]: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: Boolean(next), endCursor: next } } } });
    const { twenty } = client((c) => {
      if (c.query.includes('query Members(')) return c.variables.after ? page('workspaceMembers', [{ id: 'wm-61', name: { firstName: 'Late', lastName: 'Joiner' }, userEmail: 'late@acumen.example' }], null) : page('workspaceMembers', [{ id: 'wm-1', name: { firstName: 'A', lastName: 'B' }, userEmail: 'a@acumen.example' }], 'c1');
      return c.variables.after ? page('companies', [{ id: 'co-2', name: 'Acme', domainName: { primaryLinkUrl: 'acme.example' } }], null) : page('companies', [{ id: 'co-1', name: 'Other', domainName: { primaryLinkUrl: 'acme.example.org' } }], 'c1');
    });
    expect((await twenty.listWorkspaceMembers()).map((m) => m.id)).toEqual(['wm-1', 'wm-61']);
    expect((await twenty.findCompanies({ domain: 'acme.example' })).map((c) => c.id)).toEqual(['co-2']);
  });
});

describe('N39: pauses before asking the CRM again', () => {
  it('waits before retrying a 5xx, and honours a Retry-After given as a date', async () => {
    let n = 0;
    const when = new Date(Date.now() + 9_000).toUTCString();
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) return new Response('busy', { status: 429, headers: { 'retry-after': when } });
      if (n === 2) return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({ data: { ok: true } }));
    }) as unknown as typeof fetch;
    const twenty = new TwentyGraphqlClient({ baseUrl: 'https://twenty.example', apiKey: 'k', schema: mergeTwentySchema(), fetchImpl });
    const waits: number[] = [];
    twenty.sleep = async (ms) => { waits.push(ms); };
    await twenty.request('query Q { ok }');
    expect(waits[0]).toBeGreaterThan(6_000);
    expect(waits[1]).toBeGreaterThanOrEqual(1_000);
  });
});
