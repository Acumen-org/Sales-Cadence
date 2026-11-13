import { afterEach, describe, expect, it, vi } from 'vitest';
import { signInPostTooBig } from '@/middleware';
import { readJson } from '@/lib/sandbox/bellwether-api';
import { resetEnvCache } from '@/lib/env';

/** Audit 15 (Cadence security): headers, request sizes, test routes and the record re-read. */
const saved = { ...process.env };
afterEach(() => { for (const k of ['CADENCE_FAKE_TWILIO', 'TWENTY_MODE']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetEnvCache(); });

const stream = (bytes: number) => new ReadableStream<Uint8Array>({ start(c) { for (let left = bytes; left > 0; left -= 1024 * 1024) c.enqueue(new Uint8Array(Math.min(left, 1024 * 1024))); c.close(); } });

describe('security edges', () => {
  it('sends the security headers on every page (Q16)', async () => {
    type Config = { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    const nextConfig = ((await import('../next.config.mjs' as string)) as { default: Config }).default;
    const rules = await nextConfig.headers();
    const names = rules.find((r) => r.source === '/:path*')!.headers.map((h) => h.key);
    expect(names).toEqual(expect.arrayContaining(['Content-Security-Policy', 'X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Strict-Transport-Security']));
  });

  it('refuses a big or unmeasured post to the sign-in pages only (Q28)', () => {
    const req = (method: string, length: string | null) => ({ method, headers: new Headers(length === null ? {} : { 'content-length': length }) });
    expect(signInPostTooBig(req('POST', '400'), '/login')).toBe(false);
    expect(signInPostTooBig(req('POST', String(5 * 1024 * 1024)), '/login/admin')).toBe(true);
    expect(signInPostTooBig(req('POST', null), '/login')).toBe(true);
    expect(signInPostTooBig(req('POST', String(5 * 1024 * 1024)), '/meetings/new')).toBe(false);
    expect(signInPostTooBig(req('GET', null), '/login')).toBe(false);
  });

  it('reads a Bellwether body without a length header only up to 2 MB (Q21)', async () => {
    const r = new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream(3 * 1024 * 1024), duplex: 'half' } as RequestInit & { duplex: 'half' });
    expect(await readJson(r)).toMatchObject({ status: 413 });
  });

  it('keeps the fake Twilio route shut on a server that runs the real CRM (Q24)', async () => {
    process.env.CADENCE_FAKE_TWILIO = '1'; process.env.TWENTY_MODE = 'graphql'; resetEnvCache();
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline in tests')));
    try {
      const { POST } = await import('@/app/api/test/fake-twilio/route');
      expect((await POST(new Request('http://localhost/api/test/fake-twilio', { method: 'POST', body: '{}' }))).status).toBe(404);
    } finally { vi.unstubAllGlobals(); }
  });

  it('re-reads a record only on a POST (Q18)', async () => {
    const route = await import('@/app/api/record-sync/route');
    expect('GET' in route).toBe(false);
    expect(typeof route.POST).toBe('function');
  });
});
