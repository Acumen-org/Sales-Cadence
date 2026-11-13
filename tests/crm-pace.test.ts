import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { paceCrmRequest, setCrmRequestPriority } from '@/lib/twenty/pace';
import { TwentyGraphqlClient } from '@/lib/twenty/graphql-client';
import { mergeTwentySchema } from '@/lib/twenty/twenty-schema';

/** N12: the web app and the worker share one requests-per-minute budget through the database. */
describe('N12: one shared pace for CRM requests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setCrmRequestPriority('interactive');
  });

  it('background work stops at its share of the minute; a rep still has room', async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "CrmRequestBudget"');
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 13, 9, 0, 10));
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      throw new Error('waited');
    };
    setCrmRequestPriority('background');
    for (let i = 0; i < 70; i++) await paceCrmRequest(sleep);
    await expect(paceCrmRequest(sleep)).rejects.toThrow('waited');
    expect(waits[0]).toBeGreaterThanOrEqual(50_000);
    setCrmRequestPriority('interactive');
    for (let i = 0; i < 25; i++) await paceCrmRequest(sleep);
    await expect(paceCrmRequest(sleep)).rejects.toThrow('waited');
  });

  it('the GraphQL client takes a slot before every request', async () => {
    let paced = 0;
    const fetchImpl = (async () => new Response(JSON.stringify({ data: { __type: null } }))) as unknown as typeof fetch;
    const twenty = new TwentyGraphqlClient({ baseUrl: 'https://twenty.example', apiKey: 'k', schema: mergeTwentySchema(), fetchImpl, pace: async () => { paced += 1; } });
    await twenty.request('query X { __type(name: "Person") { name } }');
    expect(paced).toBe(1);
  });
});
