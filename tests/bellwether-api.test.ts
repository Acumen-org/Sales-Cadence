import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { MOCK_PEOPLE } from '@/lib/twenty/fixtures';
import { addSuppressions } from '@/lib/sandbox/suppression';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { bwContact, check, disableBellwether, enableBellwether, envelope, KEY, ping, push, status } from './helpers/sandbox';

const person = (i: number) => MOCK_PEOPLE[i];

describe('Bellwether push API (contract section 14)', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    enableBellwether();
  });
  afterAll(() => disableBellwether());

  describe('authentication (14.2)', () => {
    it('refuses a missing or wrong key, accepts the previous key during a rotation, and is off without a key', async () => {
      expect((await ping({ key: null })).status).toBe(401);
      expect((await ping({ key: 'wrong' })).body.error.code).toBe('unauthorized');
      expect((await ping()).body).toEqual(expect.objectContaining({ ok: true, version: '1', maxBatch: 500 }));
      enableBellwether('old-key-still-valid-for-a-day-1234567890');
      expect((await ping({ key: 'old-key-still-valid-for-a-day-1234567890' })).status).toBe(200);
      disableBellwether();
      const off = await ping();
      expect(off.status).toBe(503);
      expect(off.body.error.code).toBe('integration_disabled');
    });
  });

  describe('envelope validation (14.4, 14.9)', () => {
    it('answers 422 for each envelope problem, 413 over 500 contacts, 400 for bad JSON and 415 for another type', async () => {
      expect((await push(envelope([bwContact()]), { idempotencyKey: null })).status).toBe(422);
      expect((await push({ pushedBy: {}, contacts: [bwContact()] })).body.error.code).toBe('invalid_request');
      expect((await push(envelope([]))).status).toBe(422);
      expect((await push(envelope([bwContact()], { assignTo: { name: 'x' } }))).body.error.fields[0].path).toBe('assignTo.email');
      expect((await push(envelope(Array.from({ length: 501 }, () => bwContact())))).status).toBe(413);
      expect((await push(null, { raw: '{not json' })).body.error.code).toBe('invalid_json');
      expect((await push(envelope([bwContact()]), { contentType: 'text/plain' })).status).toBe(415);
    });
  });

  describe('per-contact results and the dedupe order (14.6)', () => {
    it('creates a contact with its owner, pod, normalised fields and first note', async () => {
      const c = bwContact({ phone: '(312) 555-0142 x12', phoneType: 'direct', linkedinUrl: 'https://uk.linkedin.com/in/Jane-Doe-CFP/?trk=x', notes: 'Met at FPA Wisconsin' });
      const r = await push(envelope([c]));
      expect(r.status).toBe(200);
      expect(r.body.summary).toEqual({ created: 1, duplicate_in_sandbox: 0, already_in_crm: 0, rejected: 0 });
      expect(r.body.owner).toEqual({ email: 'alisa@cadence.local', name: b.users.alisa.name });
      const res = r.body.results[0];
      expect(res).toEqual(expect.objectContaining({ result: 'created', ownerEmail: 'alisa@cadence.local', filledFields: [], warnings: [] }));
      const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: res.cadenceContactId }, include: { notes: true } });
      expect(row).toEqual(expect.objectContaining({ ownerId: b.users.alisa.id, podId: b.pods.Alisa.id, phone: '+13125550142', phoneExtension: '12', linkedinUrl: 'linkedin.com/in/jane-doe-cfp', companyDomain: 'example-advisors.com', companyCrd: '105943', companyPhone: '+13125550000', source: 'BELLWETHER' }));
      expect(row.notes.map((n) => n.body)).toEqual(['Met at FPA Wisconsin']);
    });

    it('rejects a missing required field, a duplicate in the request and a do-not-contact contact; drops a bad optional field with a warning', async () => {
      const dup = bwContact();
      const r = await push(envelope([bwContact({ lastName: '  ' }), dup, { ...dup }, bwContact({ doNotContact: true }), bwContact({ email: 'not-an-email', productInterest: ['PHH', 'ATS'] })]));
      expect(r.body.results.map((x: { result: string; reason: string | null }) => [x.result, x.reason])).toEqual([['rejected', 'invalid_field'], ['created', null], ['rejected', 'duplicate_in_request'], ['rejected', 'do_not_contact'], ['created', null]]);
      expect(r.body.results[0].detail).toBe('lastName is empty');
      expect(r.body.results[4].warnings.map((w: { code: string }) => w.code)).toEqual(['email_dropped', 'product_dropped']);
    });

    it('rule 2: refuses a suppressed email, and Bellwether then reads it as opted out', async () => {
      const c = bwContact();
      await addSuppressions([{ kind: 'email', value: c.email as string }], { reason: 'opted_out' });
      const r = await push(envelope([c]));
      expect(r.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'suppressed' }));
      expect((await status({ bellwetherContactIds: [c.bellwetherContactId] })).body.results[0].status).toBe('opted_out');
    });

    it('rule 3: refuses our own domains and blocked accounts', async () => {
      await prisma.blockedAccount.create({ data: { companyId: 'blocked-co', name: 'Blocked Wealth', domain: 'blocked-wealth.com' } });
      const r = await push(envelope([bwContact({ email: 'someone@acumen-strategy.com' }), bwContact({}, { name: 'Blocked Wealth LLC', website: 'blocked-wealth.com' })]));
      expect(r.body.results.map((x: { reason: string }) => x.reason)).toEqual(['internal_contact', 'blocked_account']);
    });

    it('rule 4: finds a CRM person by email and by LinkedIn', async () => {
      const r = await push(envelope([bwContact({ email: person(0).email!.toUpperCase() }), bwContact({ email: null, linkedinUrl: person(1).linkedinUrl })]));
      expect(r.body.results.map((x: { result: string; matchedOn: string; crmPersonId: string }) => [x.result, x.matchedOn, x.crmPersonId])).toEqual([['already_in_crm', 'email', person(0).id], ['already_in_crm', 'linkedin_url', person(1).id]]);
      expect(r.body.results[0].crmUrl).toContain(`/object/person/${person(0).id}`);
      expect(r.body.results[0].ownerEmail).toBe('alisa@cadence.local');
    });

    it('rule 4 phones: direct, mobile, office and unknown match; the firm line, main and toll-free never do', async () => {
      const phoneOf = (i: number) => person(i).phone!;
      const base = { email: null };
      const r = await push(envelope([
        bwContact({ ...base, phone: phoneOf(2), phoneType: 'direct' }),
        bwContact({ ...base, phone: phoneOf(3), phoneType: 'mobile' }),
        bwContact({ ...base, phone: phoneOf(4), phoneType: 'office' }),
        bwContact({ ...base, phone: phoneOf(5), phoneType: 'unknown' }),
        bwContact({ ...base, phone: phoneOf(6), phoneType: 'main' }),
        bwContact({ ...base, phone: phoneOf(7), phoneType: 'toll_free' }),
        bwContact({ ...base, phone: phoneOf(8), phoneType: 'office' }, { phone: phoneOf(8) }),
        bwContact({ ...base, phone: '+1 312 555 0111', phoneType: 'direct', additionalPhones: [{ number: phoneOf(9), type: 'mobile' }] }),
      ]));
      expect(r.body.results.map((x: { result: string; matchedOn: string | null }) => `${x.result}:${x.matchedOn ?? ''}`)).toEqual([
        'already_in_crm:phone', 'already_in_crm:phone', 'already_in_crm:phone', 'already_in_crm:phone', 'created:', 'created:', 'created:', 'already_in_crm:phone',
      ]);
    });

    it('rule 4 phones: an office number that is the main line of the person\'s company in Twenty does not match', async () => {
      const p = person(10);
      await prisma.companyCache.update({ where: { id: p.companyId! }, data: { raw: { phone: p.phone } } });
      const r = await push(envelope([bwContact({ email: null, phone: p.phone, phoneType: 'office' }, { phone: null })]));
      expect(r.body.results[0].result).toBe('created');
    });

    it('rule 5: a second push of the same person fills empty fields, keeps the owner and records the alias', async () => {
      const first = bwContact({ linkedinUrl: null, jobTitle: null });
      const created = await push(envelope([first]));
      const again = { ...first, bellwetherContactId: `${first.bellwetherContactId}-b`, linkedinUrl: 'linkedin.com/in/jane-later', jobTitle: 'Managing Partner', firstName: 'Janet' };
      const r = await push(envelope([again], { pushedBy: { email: 'karson@cadence.local' } }));
      expect(r.body.results[0]).toEqual(expect.objectContaining({ result: 'duplicate_in_sandbox', matchedOn: 'email', cadenceContactId: created.body.results[0].cadenceContactId, ownerEmail: 'alisa@cadence.local', filledFields: ['jobTitle', 'linkedinUrl'] }));
      const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: created.body.results[0].cadenceContactId } });
      expect(row).toEqual(expect.objectContaining({ firstName: 'Jane', jobTitle: 'Managing Partner', linkedinUrl: 'linkedin.com/in/jane-later', ownerId: b.users.alisa.id, bellwetherAliases: [again.bellwetherContactId] }));
      expect((await status({ bellwetherContactIds: [again.bellwetherContactId] })).body.results[0]).toEqual(expect.objectContaining({ status: 'in_sandbox', cadenceContactId: row.id }));
    });

    it('warns of a possible CRM match by name at the same firm', async () => {
      const p = person(0);
      const company = await prisma.companyCache.findUniqueOrThrow({ where: { id: p.companyId! } });
      const r = await push(envelope([bwContact({ firstName: p.firstName, lastName: p.lastName, email: 'other@elsewhere.example' }, { website: company.domain })]));
      expect(r.body.results[0].warnings).toEqual([expect.objectContaining({ code: 'possible_crm_match', crmPersonId: p.id })]);
    });
  });

  describe('ownership (14.7)', () => {
    it('owns by assignTo, leaves an unknown pusher unclaimed, and ignores a pod the owner does not work', async () => {
      const r1 = await push(envelope([bwContact()], { assignTo: { email: 'karson@cadence.local' } }));
      expect(r1.body.results[0].ownerEmail).toBe('karson@cadence.local');
      const r2 = await push(envelope([bwContact()], { pushedBy: { email: 'stranger@bellwether.example' } }));
      expect(r2.body.owner).toBeNull();
      expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: r2.body.results[0].cadenceContactId } })).ownerId).toBeNull();
      const r3 = await push(envelope([bwContact()], { pod: 'LEIGH' }));
      expect(r3.body.results[0].warnings.map((w: { code: string }) => w.code)).toContain('pod_ignored');
    });
  });

  describe('idempotency (14.10)', () => {
    it('replays the same key and body, refuses the same key with another body, and says when it is still in progress', async () => {
      const key = randomUUID();
      const body = envelope([bwContact()]);
      const first = await push(body, { idempotencyKey: key });
      const replay = await push(body, { idempotencyKey: key });
      expect(replay.body).toEqual({ ...first.body, replayed: true });
      expect(await prisma.sandboxContact.count()).toBe(1);
      const conflict = await push(envelope([bwContact()]), { idempotencyKey: key });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('idempotency_conflict');
      const busyKey = randomUUID();
      const busyBody = envelope([bwContact()]);
      const { createHash } = await import('node:crypto');
      await prisma.bellwetherPush.create({ data: { idempotencyKey: busyKey, bodyHash: createHash('sha256').update(JSON.stringify(busyBody)).digest('hex'), state: 'PROCESSING', pushedByEmail: 'alisa@cadence.local', contactCount: 1 } });
      const busy = await push(busyBody, { idempotencyKey: busyKey });
      expect(busy.status).toBe(409);
      expect(busy.body.error.code).toBe('idempotency_in_progress');
      expect(busy.headers.get('retry-after')).toBe('5');
    });
  });

  describe('limits (14.11)', () => {
    it('allows 30 push requests a minute, then answers 429 with Retry-After; checks count as pushes', async () => {
      for (let i = 0; i < 20; i++) expect((await check(envelope([bwContact()]))).status).toBe(200);
      for (let i = 0; i < 10; i++) expect((await push(envelope([bwContact({ firstName: `P${i}` })]))).status).toBe(200);
      const over = await push(envelope([bwContact()]));
      expect(over.status).toBe(429);
      expect(over.body.error.code).toBe('rate_limited');
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
      // The status endpoint has its own 60 a minute.
      expect((await status({ bellwetherContactIds: ['x'] })).status).toBe(200);
    }, 120_000);
  });

  describe('check before push (14.14)', () => {
    it('answers what the push would, writes nothing, and needs no Idempotency-Key', async () => {
      const inCrm = bwContact({ email: person(0).email });
      const fresh = bwContact();
      const before = { contacts: await prisma.sandboxContact.count(), pushes: await prisma.bellwetherPush.count(), refusals: await prisma.bellwetherRefusal.count() };
      const c = await check(envelope([inCrm, fresh]));
      expect(c.status).toBe(200);
      expect(c.body.pushId).toBeNull();
      expect(c.body.results.map((r: { result: string; cadenceContactId: string | null }) => [r.result, r.cadenceContactId])).toEqual([['already_in_crm', null], ['created', null]]);
      expect({ contacts: await prisma.sandboxContact.count(), pushes: await prisma.bellwetherPush.count(), refusals: await prisma.bellwetherRefusal.count() }).toEqual(before);
      const p = await push(envelope([inCrm, fresh]));
      expect(p.body.results.map((r: { result: string }) => r.result)).toEqual(['already_in_crm', 'created']);
    });
  });

  describe('status (14.12)', () => {
    it('answers by id in request order, with not_found for an id never received', async () => {
      const a = bwContact();
      const crm = bwContact({ email: person(0).email });
      await push(envelope([a, crm]));
      const r = await status({ bellwetherContactIds: ['never-sent', a.bellwetherContactId, crm.bellwetherContactId] });
      expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['not_found', 'in_sandbox', 'already_in_crm']);
      expect(r.body.results[2].crmPersonId).toBe(person(0).id);
    });

    it('pages changedSince oldest change first, following nextCursor until it is null', async () => {
      const contacts = Array.from({ length: 5 }, () => bwContact());
      await push(envelope(contacts));
      const rows = await prisma.sandboxContact.findMany({ orderBy: { createdAt: 'asc' } });
      for (const [i, row] of rows.entries()) await prisma.sandboxContact.update({ where: { id: row.id }, data: { statusChangedAt: new Date(Date.UTC(2026, 10, 3, 12, i)) } });
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const r = await status({ changedSince: '2026-11-03T12:01:00Z', cursor, limit: 2 });
        expect(r.status).toBe(200);
        seen.push(...r.body.results.map((x: { bellwetherContactId: string }) => x.bellwetherContactId));
        cursor = r.body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(rows.slice(1).map((r) => r.bellwetherContactId));
      expect((await status({ changedSince: 'yesterday' })).status).toBe(422);
      expect((await status({ bellwetherContactIds: ['a'], changedSince: '2026-11-03T00:00:00Z' })).status).toBe(422);
    });
  });

  it('keeps the key out of every response', async () => {
    const r = await push(envelope([bwContact()]));
    expect(JSON.stringify(r.body)).not.toContain(KEY);
  });
});
