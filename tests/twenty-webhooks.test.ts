import { describe, expect, it } from 'vitest';
import { TwentyGraphqlClient } from '@/lib/twenty/graphql-client';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { mergeTwentySchema } from '@/lib/twenty/twenty-schema';

/**
 * Cadence registers its own webhook in Twenty. The REST resource has carried two shapes over
 * Twenty's versions (`operations: [...]`, then earlier `operation: "*.*"`); the client tries the
 * newer one and falls back, and reads either shape back.
 */
function fakeTwenty(shape: 'operations' | 'operation') {
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const hooks: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? 'GET', url, body });
    if (url.endsWith('/rest/webhooks?limit=60')) return new Response(JSON.stringify({ data: { webhooks: hooks } }), { status: 200 });
    if (url.endsWith('/rest/webhooks') && init?.method === 'POST') {
      if (shape === 'operation' && body && 'operations' in body) return new Response(JSON.stringify({ error: 'Unknown field operations' }), { status: 400 });
      const hook = { id: `wh-${hooks.length + 1}`, targetUrl: body?.targetUrl, description: body?.description, ...(shape === 'operations' ? { operations: body?.operations } : { operation: body?.operation }) };
      hooks.push(hook);
      return new Response(JSON.stringify({ data: { createWebhook: hook } }), { status: 201 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls, hooks, fetchImpl };
}

describe('Twenty webhooks', () => {
  it('creates a webhook for every operation and reads it back', async () => {
    const t = fakeTwenty('operations');
    const client = new TwentyGraphqlClient({ baseUrl: 'https://twenty.example', apiKey: 'k', schema: mergeTwentySchema(), fetchImpl: t.fetchImpl });
    expect(await client.listWebhooks()).toEqual([]);
    const hook = await client.createWebhook({ targetUrl: 'https://cadence.example/api/webhooks/twenty', secret: 's3', description: 'Cadence' });
    expect(hook).toMatchObject({ id: 'wh-1', targetUrl: 'https://cadence.example/api/webhooks/twenty', operations: ['*.*'] });
    const post = t.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ targetUrl: 'https://cadence.example/api/webhooks/twenty', operations: ['*.*'], secret: 's3', description: 'Cadence' });
    expect((await client.listWebhooks()).map((w) => w.operations)).toEqual([['*.*']]);
  });

  it('falls back to the older single-operation shape when the workspace refuses a list', async () => {
    const t = fakeTwenty('operation');
    const client = new TwentyGraphqlClient({ baseUrl: 'https://twenty.example/', apiKey: 'k', schema: mergeTwentySchema(), fetchImpl: t.fetchImpl });
    const hook = await client.createWebhook({ targetUrl: 'https://cadence.example/api/webhooks/twenty' });
    expect(hook.operations).toEqual(['*.*']);
    const posts = t.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toHaveProperty('operations');
    expect(posts[1].body).toMatchObject({ operation: '*.*' });
    expect(posts[1].body).not.toHaveProperty('secret');
    expect(posts[1].url).toBe('https://twenty.example/rest/webhooks');
  });

  it('the mock workspace keeps webhooks in memory', async () => {
    const mock = getMockTwentyClient();
    const before = (await mock.listWebhooks()).length;
    const hook = await mock.createWebhook({ targetUrl: 'https://cadence.example/api/webhooks/twenty' });
    expect(hook.operations).toEqual(['*.*']);
    expect((await mock.listWebhooks()).length).toBe(before + 1);
  });
});
