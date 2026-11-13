import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { fetchH00ksStaff, h00ksStatus, syncH00ksNumbers } from '@/lib/calls/h00ks';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/** Reps' Twilio numbers come from h00ks (owner, 12 Nov 2026). */
let b: Basics;
beforeEach(async () => { await resetDb(); b = await seedBasics(); });

const staff = (rows: Record<string, unknown>[], mode = 'live') => (async () => new Response(JSON.stringify({ mode, data: rows }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
const row = (email: string | null, numbers: string[], extra: Record<string, unknown> = {}) => ({ id: `h-${email}`, name: email?.split('@')[0] ?? 'Someone', email, resigned: false, clientIdentity: null, workPhone: numbers[0] ?? null, numbers, ...extra });
const opts = (fetchImpl: typeof fetch) => ({ token: 'ak_test', baseUrl: 'https://h00ks.test/api/partner/v1', fetchImpl });
const user = (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, select: { callerNumber: true, callerNumberSince: true, aliases: true } });

describe('numbers from h00ks', () => {
  it('gives each rep the number h00ks assigns them by email, from now, with their dialpad identity', async () => {
    const now = new Date('2026-11-13T10:00:00Z');
    await prisma.user.update({ where: { id: b.users.leigh.id }, data: { callerNumber: '+13125550199', callerNumberSince: new Date('2026-10-01T00:00:00Z') } });
    await prisma.user.update({ where: { id: b.users.karson.id }, data: { callerNumber: '+13125550177', callerNumberSince: new Date('2026-10-01T00:00:00Z') } });
    const r = await syncH00ksNumbers({ ...opts(staff([
      row(b.users.alisa.email.toUpperCase(), ['+1 (312) 555-0101'], { clientIdentity: 'tw_ALISA' }),
      // Leigh's number is the same: untouched, and its start date kept.
      row(b.users.leigh.email, ['+13125550199']),
      row(b.users.daniel.email, ['+13125550177']),
      row(b.users.andrew.email, ['+13125550188'], { resigned: true }),
      row('newhire@acumen-strategy.com', ['+13125550166']),
    ])), now });

    expect(r.error).toBeUndefined();
    expect(await user(b.users.alisa.id)).toEqual({ callerNumber: '+13125550101', callerNumberSince: now, aliases: expect.arrayContaining(['tw_alisa']) });
    expect(await user(b.users.leigh.id)).toEqual(expect.objectContaining({ callerNumber: '+13125550199', callerNumberSince: new Date('2026-10-01T00:00:00Z') }));
    // Karson's old number went to Daniel in h00ks; Karson is not in h00ks, so holds none now.
    expect(await user(b.users.daniel.id)).toEqual(expect.objectContaining({ callerNumber: '+13125550177', callerNumberSince: now }));
    expect((await user(b.users.karson.id)).callerNumber).toBeNull();
    // Resigned in h00ks: no number.
    expect((await user(b.users.andrew.id)).callerNumber).toBeNull();
    expect(r.unmatched).toEqual([{ name: 'newhire', email: 'newhire@acumen-strategy.com', number: '+13125550166' }]);
    expect(await prisma.auditLog.count({ where: { action: 'caller_number_synced' } })).toBe(3);
    expect(await h00ksStatus()).toEqual(expect.objectContaining({ lastOkAt: now.toISOString(), lastError: null, unmatched: r.unmatched }));

    // A second run changes nothing.
    const again = await syncH00ksNumbers({ ...opts(staff([row(b.users.alisa.email, ['+13125550101'], { clientIdentity: 'tw_alisa' }), row(b.users.leigh.email, ['+13125550199']), row(b.users.daniel.email, ['+13125550177'])])), now: new Date('2026-11-13T10:02:00Z') });
    expect(again.changed).toEqual([]);
    expect(again.identitiesAdded).toBe(0);
  });

  it('a removed Cadence user keeps no number, even one h00ks still gives them', async () => {
    await prisma.user.update({ where: { id: b.users.leigh.id }, data: { active: false, callerNumber: '+13125550199' } });
    await syncH00ksNumbers(opts(staff([row(b.users.leigh.email, ['+13125550199'])])));
    expect((await user(b.users.leigh.id)).callerNumber).toBeNull();
  });

  it('an error, a test key or an empty list changes nothing and says why', async () => {
    await prisma.user.update({ where: { id: b.users.alisa.id }, data: { callerNumber: '+13125550101' } });
    const down = (async () => new Response('{"error":"Unauthorized"}', { status: 401 })) as unknown as typeof fetch;
    expect((await syncH00ksNumbers(opts(down))).error).toContain('401');
    expect((await syncH00ksNumbers(opts(staff([row(b.users.alisa.email, [])], 'test')))).error).toContain('Live');
    expect((await syncH00ksNumbers(opts(staff([])))).error).toContain('empty');
    expect((await user(b.users.alisa.id)).callerNumber).toBe('+13125550101');
    expect((await h00ksStatus()).lastError).toContain('empty');
  });

  it('reads the partner staff list with the key', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const f = (async (url: string, init: RequestInit) => { seen = { url, auth: new Headers(init.headers).get('authorization') }; return new Response(JSON.stringify({ mode: 'live', data: [row('a@x.com', ['+13125550101'])] })); }) as unknown as typeof fetch;
    expect(await fetchH00ksStaff(opts(f))).toEqual([expect.objectContaining({ email: 'a@x.com', numbers: ['+13125550101'], resigned: false })]);
    expect(seen).toEqual({ url: 'https://h00ks.test/api/partner/v1/staff', auth: 'Bearer ak_test' });
  });
});
