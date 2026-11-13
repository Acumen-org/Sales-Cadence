import { createHmac, timingSafeEqual } from 'node:crypto';

/** The Console signs the raw body: X-LinkedIn-Console-Signature: sha256=<hex HMAC-SHA256>. */
export function validSignature(rawBody: string, header: string | null, secret: string): boolean {
  const given = (header ?? '').replace(/^sha256=/i, '').trim();
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(given, 'hex'), expected);
}
