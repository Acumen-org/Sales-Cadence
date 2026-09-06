import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWebhookEvent, signWebhook, verifyWebhook } from '@/lib/twenty/webhook-auth';

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });
const body = JSON.stringify({ eventName: 'note.created', record: { id: 'n1' } });

describe('webhook verification', () => {
  it('accepts a valid timestamped signature and rejects a bad one', () => {
    const sig = signWebhook('s3cret', '1700000000', body);
    expect(verifyWebhook({ rawBody: body, headers: headers({ 'x-twenty-webhook-signature': sig, 'x-twenty-webhook-timestamp': '1700000000' }), queryToken: null, secret: 's3cret', token: null })).toEqual({ ok: true, method: 'signature' });
    expect(verifyWebhook({ rawBody: body, headers: headers({ 'x-twenty-webhook-signature': 'deadbeef', 'x-twenty-webhook-timestamp': '1700000000' }), queryToken: null, secret: 's3cret', token: null })).toEqual({ ok: false, reason: 'invalid signature' });
    expect(verifyWebhook({ rawBody: body, headers: headers({}), queryToken: null, secret: 's3cret', token: null })).toEqual({ ok: false, reason: 'missing signature' });
  });

  it('accepts a plain body HMAC as a fallback', () => {
    const sig = createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(verifyWebhook({ rawBody: body, headers: headers({ 'x-twenty-webhook-signature': `sha256=${sig}` }), queryToken: null, secret: 's3cret', token: null }).ok).toBe(true);
  });

  it('checks the shared token when no secret is configured', () => {
    expect(verifyWebhook({ rawBody: body, headers: headers({}), queryToken: 'abc', secret: null, token: 'abc' })).toEqual({ ok: true, method: 'token' });
    expect(verifyWebhook({ rawBody: body, headers: headers({}), queryToken: 'nope', secret: null, token: 'abc' })).toEqual({ ok: false, reason: 'invalid token' });
    expect(verifyWebhook({ rawBody: body, headers: headers({}), queryToken: null, secret: null, token: null })).toEqual({ ok: true, method: 'open' });
  });
});

describe('webhook payload parsing', () => {
  it('reads the current Twenty shape', () => {
    const parsed = parseWebhookEvent({ eventName: 'person.updated', objectMetadata: { nameSingular: 'person' }, record: { id: 'p1', updatedAt: '2026-09-06T10:00:00.000Z' }, updatedFields: ['dnd'] });
    expect(parsed).toEqual({ objectType: 'person', eventName: 'person.updated', record: { id: 'p1', updatedAt: '2026-09-06T10:00:00.000Z' }, recordId: 'p1', updatedAt: '2026-09-06T10:00:00.000Z' });
  });

  it('tolerates older shapes and rejects garbage', () => {
    expect(parseWebhookEvent({ eventType: 'note.created', data: { id: 'n1' }, eventDate: '2026-09-06T10:00:00.000Z' })).toMatchObject({ objectType: 'note', eventName: 'note.created', recordId: 'n1', updatedAt: '2026-09-06T10:00:00.000Z' });
    expect(parseWebhookEvent({ eventName: 'created', objectMetadata: { nameSingular: 'opportunity' }, record: { id: 'o1' } })).toMatchObject({ eventName: 'opportunity.created' });
    expect(parseWebhookEvent(null)).toBeNull();
    expect(parseWebhookEvent({ eventName: 'x' })).toBeNull();
  });
});
