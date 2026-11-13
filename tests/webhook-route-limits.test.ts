import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/webhooks/twenty/route';
import { resetEnvCache } from '@/lib/env';

/** Audit Q05 and Q22: the Twenty webhook caps what it reads and says nothing about why it refused. */
afterEach(() => { delete process.env.TWENTY_WEBHOOK_SECRET; resetEnvCache(); });

describe('the Twenty webhook', () => {
  it('refuses a body over 2 MB without reading it whole, even with no length header', async () => {
    const big = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); },
    });
    const req = new NextRequest('http://localhost/api/webhooks/twenty', { method: 'POST', body: big, duplex: 'half' } as unknown as ConstructorParameters<typeof NextRequest>[1]);
    expect((await POST(req)).status).toBe(413);
  });

  it('answers a bad signature with 401 and no reason', async () => {
    process.env.TWENTY_WEBHOOK_SECRET = 's3cret'; resetEnvCache();
    const res = await POST(new NextRequest('http://localhost/api/webhooks/twenty', { method: 'POST', body: '{}', headers: { 'x-twenty-webhook-signature': 'deadbeef' } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });
});
