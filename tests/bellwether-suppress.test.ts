import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { handleSuppress } from '@/lib/sandbox/bellwether-http';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { bwContact, disableBellwether, enableBellwether, envelope, KEY, push, status } from './helpers/sandbox';

/**
 * B003: POST /v1/contacts/suppress (contract v1.1, PLAN 7.3). Bellwether's caller was built from the
 * same text; its reading of the shapes is in Scrapper/scripts/cadence_contract_fixture.json ("v1_1"),
 * copied here so the two cannot drift apart unnoticed.
 */
const FIXTURE_REQUEST = { contacts: [{ bellwetherContactId: '105943:i:7712001', emails: ['jane.doe@northstarwealth.com'], phones: ['+12125550142'], individualCrd: '7712001' }], reason: 'opted_out', note: 'Asked on a call', actor: { email: 'karson@acumen-strategy.com', name: 'Karson Example' } };
const FIXTURE_RESULT_KEYS = ['bellwetherContactId', 'cadenceContactId', 'crmPersonId', 'result'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function suppress(body: unknown, key: string | null = KEY): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-cadence-contract': '1.1' };
  if (key) headers['x-cadence-api-key'] = key;
  const res = await handleSuppress(new Request('http://localhost/api/integrations/bellwether/v1/contacts/suppress', { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

describe('B003: Do not contact set in Bellwether reaches Cadence', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    enableBellwether();
  });
  afterAll(() => disableBellwether());

  it('B003: matches the shapes Bellwether\'s caller was built from', async () => {
    const fixture = path.join(process.cwd(), '..', 'Scrapper', 'scripts', 'cadence_contract_fixture.json');
    if (fs.existsSync(fixture)) {
      const v11 = JSON.parse(fs.readFileSync(fixture, 'utf8')).v1_1;
      expect(v11.suppress_request).toEqual(FIXTURE_REQUEST);
      expect(Object.keys(v11.suppress_response.results[0]).sort()).toEqual(FIXTURE_RESULT_KEYS);
    }
    const r = await suppress(FIXTURE_REQUEST);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['results']);
    expect(Object.keys(r.body.results[0]).sort()).toEqual(FIXTURE_RESULT_KEYS);
    expect(r.body.results[0]).toEqual({ bellwetherContactId: '105943:i:7712001', result: 'not_found', cadenceContactId: null, crmPersonId: null });
  });

  it('B003: a contact in Cold outreach is opted out; Bellwether then reads opted_out, a second call says already_opted_out, and a push is refused', async () => {
    const c = bwContact({ individualCrd: '4455667' });
    const pushed = await push(envelope([c]));
    const id = pushed.body.results[0].cadenceContactId;
    const body = { contacts: [{ bellwetherContactId: c.bellwetherContactId, emails: [c.email], phones: [], individualCrd: '4455667' }], reason: 'do_not_contact', note: 'Asked by email', actor: { email: 'leigh@acumen-strategy.com', name: 'Leigh' } };
    const first = await suppress(body);
    expect(first.body.results).toEqual([{ bellwetherContactId: c.bellwetherContactId, result: 'opted_out', cadenceContactId: id, crmPersonId: null }]);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id } })).toEqual(expect.objectContaining({ status: 'OPTED_OUT', optOutSource: 'bellwether' }));
    expect((await status({ bellwetherContactIds: [c.bellwetherContactId] })).body.results[0].status).toBe('opted_out');
    expect((await suppress(body)).body.results[0].result).toBe('already_opted_out');
    const again = await push(envelope([bwContact({ individualCrd: '4455667' }, { name: 'Elsewhere LLC' })]));
    expect(again.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'suppressed' }));
  });

  it('B003: a moved contact and a CRM person are opted out through the CRM, which gets Do not contact (D6)', async () => {
    const person = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-02' } });
    const r = await suppress({ contacts: [{ bellwetherContactId: 'bw:crm-only', emails: [person.email!.toUpperCase()], phones: [], individualCrd: null }], reason: 'do_not_contact', note: null, actor: { email: 'leigh@acumen-strategy.com' } });
    expect(r.body.results[0]).toEqual({ bellwetherContactId: 'bw:crm-only', result: 'opted_out', cadenceContactId: null, crmPersonId: 'person-02' });
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-02' } })).optedOut).toBe(true);
    expect(getMockTwentyClient().people.find((p) => p.id === 'person-02')?.dnd).toBe(true);
    // The id never became a cold contact, and still reads opted_out from now on.
    expect((await status({ bellwetherContactIds: ['bw:crm-only'] })).body.results[0].status).toBe('opted_out');
  });

  it('B003: refuses a request without contacts or an actor (422), and a wrong key (401)', async () => {
    expect((await suppress({ contacts: [], actor: { email: 'x@y.z' } })).status).toBe(422);
    const noActor = await suppress({ contacts: FIXTURE_REQUEST.contacts });
    expect(noActor).toEqual({ status: 422, body: { error: expect.objectContaining({ code: 'invalid_request', fields: [{ path: 'actor', problem: 'actor is required.' }] }) } });
    expect((await suppress({ contacts: [{ emails: [] }], actor: { email: 'x@y.z' } })).body.error.fields[0].path).toBe('contacts[0].bellwetherContactId');
    expect((await suppress(FIXTURE_REQUEST, 'wrong')).status).toBe(401);
    expect(b.users.alisa).toBeTruthy();
  });

  it('B003: a phone from Bellwether blocks only the people it matched, never a colleague on the same line', async () => {
    const c = bwContact({ phone: '+1 212 555 0142', phoneType: 'office' });
    const pushed = await push(envelope([c]));
    const colleague = await push(envelope([bwContact({ phone: '+1 212 555 0142', phoneType: 'office' })]));
    await suppress({ contacts: [{ bellwetherContactId: c.bellwetherContactId, emails: [], phones: ['+12125550142'], individualCrd: null }], actor: { email: 'leigh@acumen-strategy.com' } });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: pushed.body.results[0].cadenceContactId } })).status).toBe('OPTED_OUT');
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: colleague.body.results[0].cadenceContactId } })).status).toBe('ACTIVE');
  });
});
