import { describe, expect, it } from 'vitest';
import { collectAll, paginate } from '@/lib/twenty/client';
import { MockTwentyClient } from '@/lib/twenty/mock-client';

describe('CRM pagination', () => {
  it('collects every page beyond the previous account-sync cutoff', async () => {
    const values = await collectAll(async (after) => {
      const index = after ? Number(after) : 0;
      return { items: [index], hasNextPage: index < 24, endCursor: String(index + 1) };
    });
    expect(values).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
  it('reports a repeated or missing cursor as an incomplete sync', async () => {
    await expect(collectAll(async () => ({ items: [], hasNextPage: true, endCursor: 'same' }))).rejects.toThrow('did not advance');
    await expect(collectAll(async () => ({ items: [], hasNextPage: true, endCursor: null }))).rejects.toThrow('did not advance');
  });
  it('reports the safety limit instead of claiming a truncated sync succeeded', async () => {
    const read = async () => { for await (const item of paginate(async (after) => ({ items: [1], hasNextPage: true, endCursor: String(Number(after ?? 0) + 1) }), 2)) void item; };
    await expect(read()).rejects.toThrow('exceeded 2 pages');
  });
  it('supports the same account filter in the mock client', async () => {
    const client = new MockTwentyClient();
    const all = await client.listPeople();
    const companyId = all.items.find((p) => p.companyId)?.companyId;
    expect(companyId).toBeTruthy();
    const page = await client.listPeople({ companyId: companyId! });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((p) => p.companyId === companyId)).toBe(true);
  });
});
