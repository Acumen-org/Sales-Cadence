import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { clientIp, createApiKey, ipAllowed, parseCidr, pruneReadApiLog, revokeApiKey, validateKeyInput, type Scope } from '@/lib/public-api/keys';
import { handleReadApi, RATE_LIMIT, resetReadApiLimits } from '@/lib/public-api/http';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/** The read API, /api/v1 (Notes/public-api-2026-11-08/CONTRACT.md). */

async function call(path: string, opts: { key?: string | null; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  const res = await handleReadApi(new Request(`http://cadence.test/api/v1${path}`, { method: opts.method ?? 'GET', headers }));
  return { status: res.status, headers: res.headers, body: await res.json() };
}

describe('read API', () => {
  let b: Basics;
  const by = () => ({ id: b.users.alisa.id, name: 'Alisa' });
  const makeKey = async (scopes: Scope[], over: { expiresInDays?: number | null; allowedIps?: string[] } = {}) => {
    const r = await createApiKey({ name: 'Test tool', scopes, expiresInDays: over.expiresInDays === undefined ? 90 : over.expiresInDays, allowedIps: over.allowedIps ?? [] }, by(), SYSTEM_ACTOR);
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    await resetReadApiLimits();
  });
  afterEach(() => {
    delete process.env.API_TRUSTED_PROXY_HOPS;
    resetEnvCache();
  });

  describe('keys', () => {
    it('stores only the hash, and the key has the documented shape', async () => {
      const { id, key } = await makeKey(['crm']);
      expect(key).toMatch(/^cad_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
      const row = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
      expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(key.split('_').pop());
      expect(await prisma.auditLog.count({ where: { entityType: 'api_key', entityId: id, action: 'api_key_created' } })).toBe(1);
    });

    it('refuses a key with no name, no scope, an unknown scope, a bad expiry or a bad IP', () => {
      const ok = { name: 'x', scopes: ['crm'], expiresInDays: 90, allowedIps: [] };
      expect(validateKeyInput(ok)).toBeNull();
      expect(validateKeyInput({ ...ok, name: ' ' })).toMatch(/name/);
      expect(validateKeyInput({ ...ok, scopes: [] })).toMatch(/at least one/);
      expect(validateKeyInput({ ...ok, scopes: ['everything'] })).toMatch(/not a scope/);
      expect(validateKeyInput({ ...ok, expiresInDays: 366 })).toMatch(/Expiry/);
      expect(validateKeyInput({ ...ok, expiresInDays: null })).toBeNull();
      expect(validateKeyInput({ ...ok, allowedIps: ['10.0.0.0/33'] })).toMatch(/not an IP/);
    });
  });

  describe('authentication', () => {
    it('answers 401 without a key, with a malformed or wrong key, a revoked or an expired one, and to a session cookie', async () => {
      const { id, key } = await makeKey(['crm']);
      expect((await call('')).status).toBe(401);
      expect((await call('', { key: 'nonsense' })).body.error.code).toBe('unauthorized');
      // The right id with another secret.
      expect((await call('', { key: `cad_${id}_${'A'.repeat(43)}` })).status).toBe(401);
      expect((await call('', { headers: { cookie: 'cadence_session=whatever', authorization: 'Basic abc' } })).status).toBe(401);
      expect((await call('', { key })).status).toBe(200);

      const expired = await makeKey(['crm'], { expiresInDays: 1 });
      await prisma.apiKey.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await call('', { key: expired.key })).status).toBe(401);

      await revokeApiKey(id, { name: 'Alisa' }, SYSTEM_ACTOR);
      expect((await call('', { key })).status).toBe(401);
      expect((await revokeApiKey(id, { name: 'Alisa' }, SYSTEM_ACTOR)).ok).toBe(false);
    });

    it('is read only: any other method is a 405 naming GET', async () => {
      const { key } = await makeKey(['crm']);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const r = await call('/people', { key, method });
        expect(r.status).toBe(405);
        expect(r.headers.get('allow')).toBe('GET');
      }
    });

    it('lists only what the key may read, and answers 403 naming the missing scope', async () => {
      const { key } = await makeKey(['crm']);
      const root = await call('', { key });
      expect(root.body).toEqual(expect.objectContaining({ app: 'cadence', version: '1' }));
      expect(root.body.resources.map((r: { name: string }) => r.name).sort()).toEqual(['companies', 'people']);
      expect(root.headers.get('cache-control')).toBe('no-store');
      const denied = await call('/users', { key });
      expect(denied.status).toBe(403);
      expect(denied.body.error.message).toContain('team');
      expect((await call('/reports', { key })).status).toBe(403);
      expect((await call('/nothing-here', { key })).status).toBe(404);
    });
  });

  describe('lists', () => {
    it('pages through every person exactly once, by id', async () => {
      const { key } = await makeKey(['crm']);
      const total = await prisma.personCache.count({ where: { deletedAt: null } });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const r = await call(`/people?limit=15${cursor ? `&cursor=${cursor}` : ''}`, { key });
        expect(r.status).toBe(200);
        expect(r.body.data.length).toBeLessThanOrEqual(15);
        seen.push(...r.body.data.map((p: { id: string }) => p.id));
        cursor = r.body.nextCursor;
      } while (cursor);
      expect(seen.length).toBe(total);
      expect(new Set(seen).size).toBe(total);
    });

    it('reads changes since a time in order of change, and refuses a cursor from the other ordering', async () => {
      const { key } = await makeKey(['crm']);
      const ids = (await prisma.personCache.findMany({ select: { id: true }, orderBy: { id: 'asc' }, take: 3 })).map((p) => p.id);
      const since = new Date(Date.now() + 60_000);
      await prisma.personCache.updateMany({ where: { id: { in: ids } }, data: { syncedAt: new Date(since.getTime() + 1000) } });
      const r = await call(`/people?updatedSince=${since.toISOString()}&limit=2`, { key });
      expect(r.body.data.map((p: { id: string }) => p.id)).toEqual(ids.slice(0, 2));
      const next = await call(`/people?updatedSince=${since.toISOString()}&limit=2&cursor=${r.body.nextCursor}`, { key });
      expect(next.body.data.map((p: { id: string }) => p.id)).toEqual([ids[2]]);
      expect(next.body.nextCursor).toBeNull();

      const byId = await call('/people?limit=1', { key });
      expect((await call(`/people?updatedSince=${since.toISOString()}&cursor=${byId.body.nextCursor}`, { key })).status).toBe(422);
      expect((await call('/people?cursor=bm9wZQ', { key })).body.error.code).toBe('invalid_request');
    });

    it('answers 422 for a bad limit, an unknown filter and a bad filter value', async () => {
      const { key } = await makeKey(['crm', 'tasks']);
      expect((await call('/people?limit=0', { key })).status).toBe(422);
      expect((await call('/people?limit=501', { key })).status).toBe(422);
      expect((await call('/people?email=a@b.c', { key })).body.error.code).toBe('unsupported_filter');
      expect((await call('/people?deleted=maybe', { key })).status).toBe(422);
      expect((await call('/tasks?state=NOPE', { key })).status).toBe(422);
      expect((await call('/people?updatedSince=yesterday', { key })).status).toBe(422);
    });

    it('filters, and keeps CRM-deleted records out unless asked', async () => {
      const { key } = await makeKey(['crm']);
      const gone = await prisma.personCache.findFirstOrThrow({ orderBy: { id: 'asc' } });
      await prisma.personCache.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
      const ids = async (q: string) => (await call(`/people?limit=500${q}`, { key })).body.data.map((p: { id: string }) => p.id);
      expect(await ids('')).not.toContain(gone.id);
      expect(await ids('&deleted=only')).toEqual([gone.id]);
      expect(await ids('&deleted=include')).toContain(gone.id);
      const alisa = await ids('&podOwner=ALISA');
      expect(alisa.length).toBe(await prisma.personCache.count({ where: { podOwner: 'ALISA', deletedAt: null } }));
    });
  });

  describe('what is sent', () => {
    it('never sends password hashes, Microsoft ids or raw CRM payloads; sends pods and member ids', async () => {
      const { key } = await makeKey(['team', 'crm']);
      const users = (await call('/users', { key })).body.data;
      expect(users.length).toBeGreaterThan(0);
      for (const u of users) {
        expect(u).not.toHaveProperty('passwordHash');
        expect(u).not.toHaveProperty('microsoftId');
        expect(Array.isArray(u.podIds)).toBe(true);
      }
      const pods = (await call('/pods', { key })).body.data;
      expect(pods.find((p: { id: string }) => p.id === b.pods.Alisa.id).userIds).toContain(b.users.alisa.id);
      const person = (await call('/people?limit=1', { key })).body.data[0];
      expect(person).not.toHaveProperty('raw');
      expect(person).not.toHaveProperty('emailNorm');
      expect(person.syncedAt).toMatch(/Z$/);
    });

    it('answers one record by id, or 404', async () => {
      const { key } = await makeKey(['team']);
      const one = await call(`/users/${b.users.leigh.id}`, { key });
      expect(one.status).toBe(200);
      expect(one.body.data.id).toBe(b.users.leigh.id);
      expect(one.body.data).not.toHaveProperty('passwordHash');
      expect((await call('/users/not-a-user', { key })).status).toBe(404);
    });

    it('reads the Reports figures for a period, and refuses a bad audience', async () => {
      const { key } = await makeKey(['reports']);
      const r = await call('/reports?from=2026-10-01&to=2026-10-31&audience=all', { key });
      expect(r.status).toBe(200);
      expect(r.body.data.totals).toEqual(expect.objectContaining({ sent: expect.any(Number), meetings: expect.any(Number) }));
      expect((await call('/reports?audience=everyone', { key })).status).toBe(422);
      expect((await call('/reports?from=October', { key })).status).toBe(422);
    });
  });

  describe('limits and logging', () => {
    it(`allows ${RATE_LIMIT} requests a minute per key, then 429 with Retry-After`, async () => {
      const { key } = await makeKey(['crm']);
      const other = await makeKey(['crm']);
      for (let i = 0; i < RATE_LIMIT; i++) await handleReadApi(new Request('http://cadence.test/api/v1', { headers: { authorization: `Bearer ${key}` } }));
      const over = await call('', { key });
      expect(over.status).toBe(429);
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(over.headers.get('x-ratelimit-remaining')).toBe('0');
      expect((await call('', { key: other.key })).status).toBe(200);
    });

    it('V09: the limit is shared through the database, and a caller sending wrong keys is slowed', async () => {
      const { id, key } = await makeKey(['crm']);
      const now = new Date();
      await prisma.apiRateHit.createMany({ data: Array.from({ length: RATE_LIMIT }, () => ({ bucket: `read:${id}`, at: now })) });
      expect((await call('', { key })).status).toBe(429);
      for (let i = 0; i < 20; i++) expect((await call('', { key: 'cad_wrong' })).status).toBe(401);
      const slowed = await call('', { key: 'cad_wrong' });
      expect(slowed.status).toBe(429);
      expect(Number(slowed.headers.get('retry-after'))).toBeGreaterThan(0);
    });

    it('logs each request by path without its query, stamps last used, and prunes after 90 days', async () => {
      const { id, key } = await makeKey(['crm']);
      await call('/people?podOwner=ALISA&limit=5', { key });
      await call('/users', { key });
      const log = await prisma.apiRequestLog.findMany({ where: { keyId: id }, orderBy: { createdAt: 'asc' } });
      expect(log.map((l) => [l.path, l.status])).toEqual([['/api/v1/people', 200], ['/api/v1/users', 403]]);
      expect(log[0].rows).toBe(5);
      expect((await prisma.apiKey.findUniqueOrThrow({ where: { id } })).lastUsedAt).not.toBeNull();
      await prisma.apiRequestLog.updateMany({ where: { keyId: id, path: '/api/v1/users' }, data: { createdAt: new Date(Date.now() - 91 * 86_400_000) } });
      expect(await pruneReadApiLog()).toEqual({ removed: 1 });
    });

    it('keeps a key with an IP allowlist to those addresses, and refuses it when the address cannot be known', async () => {
      const { key } = await makeKey(['crm'], { allowedIps: ['203.0.113.0/24'] });
      expect((await call('', { key, headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(403);
      process.env.API_TRUSTED_PROXY_HOPS = '1';
      resetEnvCache();
      // The last entry is the one our proxy wrote; the first can be anything the caller sent.
      expect((await call('', { key, headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.9' } })).status).toBe(200);
      expect((await call('', { key, headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.1' } })).status).toBe(403);
    });
  });

  it('matches IPv4 and IPv6 ranges', () => {
    expect(parseCidr('10.0.0.0/8')).not.toBeNull();
    expect(parseCidr('2001:db8::/32')).not.toBeNull();
    expect(parseCidr('300.1.1.1')).toBeNull();
    expect(ipAllowed('10.4.5.6', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('11.4.5.6', ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('::ffff:10.4.5.6', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('2001:db8:1::5', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::5', ['2001:db8::/32'])).toBe(false);
    expect(ipAllowed(null, [])).toBe(true);
    expect(ipAllowed(null, ['10.0.0.0/8'])).toBe(false);
    expect(clientIp(new Headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), 0)).toBeNull();
    expect(clientIp(new Headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), 2)).toBe('1.1.1.1');
  });
});
