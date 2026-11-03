import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';
import { resetRateLimits } from '@/lib/sandbox/bellwether-api';
import { handleCheck, handlePing, handlePush, handleStatus } from '@/lib/sandbox/bellwether-http';

export const KEY = 'test-bellwether-key-0123456789abcdef0123456789';

export function enableBellwether(previous?: string) {
  process.env.BELLWETHER_API_KEY = KEY;
  if (previous) process.env.BELLWETHER_API_KEY_PREVIOUS = previous; else delete process.env.BELLWETHER_API_KEY_PREVIOUS;
  resetEnvCache();
  resetRateLimits();
}

export function disableBellwether() {
  delete process.env.BELLWETHER_API_KEY;
  delete process.env.BELLWETHER_API_KEY_PREVIOUS;
  resetEnvCache();
}

/** A Bellwether contact as the contract's example shapes one, with what a test overrides. */
export function bwContact(over: Record<string, unknown> = {}, firm: Record<string, unknown> = {}) {
  const n = Math.floor(Math.random() * 1e9);
  return {
    bellwetherContactId: `105943:i:${n}`,
    firstName: 'Jane',
    lastName: `Doe${n}`,
    jobTitle: 'Partner',
    email: `jane.${n}@example-advisors.com`,
    emailVerification: 'valid',
    phone: null,
    phoneType: 'unknown',
    linkedinUrl: null,
    city: 'Chicago',
    state: 'IL',
    country: 'US',
    source: 'SEC IAPD',
    firm: { name: 'Example Advisors LLC', crd: '105943', website: 'https://www.example-advisors.com', phone: '+1 312 555 0000', ...firm },
    ...over,
  };
}

export const envelope = (contacts: unknown[], over: Record<string, unknown> = {}) => ({ pushedBy: { email: 'alisa@cadence.local', name: 'Alisa' }, contacts, ...over });

type Init = { key?: string | null; idempotencyKey?: string | null; contentType?: string; raw?: string };
function request(path: string, body: unknown, init: Init = {}, method = 'POST') {
  const headers: Record<string, string> = { 'content-type': init.contentType ?? 'application/json' };
  if (init.key !== null) headers['x-cadence-api-key'] = init.key ?? KEY;
  if (init.idempotencyKey !== null && init.idempotencyKey !== undefined) headers['idempotency-key'] = init.idempotencyKey;
  return new Request(`http://localhost/api/integrations/bellwether/v1${path}`, { method, headers, body: method === 'GET' ? undefined : init.raw ?? JSON.stringify(body) });
}

/** A JSON answer read loosely, as a test inspects it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

export async function push(body: unknown, init: Init = {}) {
  const res = await handlePush(request('/contacts', body, { idempotencyKey: randomUUID(), ...init }));
  return { status: res.status, headers: res.headers, body: (await res.json()) as Body };
}
export async function check(body: unknown, init: Init = {}) {
  const res = await handleCheck(request('/contacts/check', body, init));
  return { status: res.status, headers: res.headers, body: (await res.json()) as Body };
}
export async function status(body: unknown, init: Init = {}) {
  const res = await handleStatus(request('/contacts/status', body, init));
  return { status: res.status, body: (await res.json()) as Body };
}
export async function ping(init: Init = {}) {
  const res = await handlePing(request('/ping', null, init, 'GET'));
  return { status: res.status, body: (await res.json()) as Body };
}

/** A sandbox contact that passes every CRM-ready rule, owned by `ownerId` in `podId`. */
export async function readyContact(ownerId: string, podId: string, over: Partial<Prisma.SandboxContactUncheckedCreateInput> = {}) {
  const n = Math.floor(Math.random() * 1e9);
  return prisma.sandboxContact.create({
    data: {
      source: 'BELLWETHER', firstName: 'Sam', lastName: `Rivera${n}`, sortName: `rivera${n} sam`, jobTitle: 'Advisor', email: `sam.${n}@rivera-wealth.com`,
      emailVerification: 'valid', phone: `+1312555${String(n % 10000).padStart(4, '0')}`, phoneType: 'direct', city: 'Chicago', state: 'IL', country: 'US',
      companyName: 'Rivera Wealth Partners', companyDomain: 'rivera-wealth.com', companyWebsite: 'https://rivera-wealth.com', productInterest: ['PHH'],
      ownerId, podId, claimedAt: new Date(), bellwetherContactId: `bw:${n}`, ...over,
    },
  });
}
