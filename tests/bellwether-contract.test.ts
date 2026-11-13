import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { databaseNow, prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { MOCK_PEOPLE } from '@/lib/twenty/fixtures';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { databaseDown, normalizeContact, pushWithIdempotency, sweepStuckPushes, validateEnvelope, type Envelope } from '@/lib/sandbox/bellwether-api';
import { cutAtWord, normalizeCountry, normalizeEmail, normalizeFirmName, normalizeLinkedin, parsePhone, plainText } from '@/lib/sandbox/normalize';
import { isInternalCompany } from '@/lib/internal-organizations';
import { assignContact, claimContact, createContact, eraseContact, removeContact } from '@/lib/sandbox/contacts';
import { liftOptOut, optOutContact, optOutPerson } from '@/lib/outreach/transitions';
import { bounceDetected } from '@/lib/engine/outcomes';
import { logManualCall, submitCallForm } from '@/lib/calls/form';
import { personInput } from '@/lib/sandbox/move';
import { writeNote } from '@/lib/sandbox/history-notes';
import { getSettings } from '@/lib/settings';
import { coldRef, personRef } from '@/lib/subject';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { bwContact, check, disableBellwether, enableBellwether, envelope, owners, ping, push, status } from './helpers/sandbox';

/**
 * W11 (cold outreach PLAN 7.3, 8.10): contract v1.1 between Bellwether and Cadence and the push
 * intake. Bellwether's side was built from its reading of 7.3 (Scrapper/scripts/cadence_contract_fixture.json,
 * now generated from section 14 of docs/outreach-sandbox-plan.md, which both plans carry word for
 * word); the last tests hold the code, the section and the fixture together. Each test is named after its bug.
 */

const V11 = { contract: '1.1' as const };
const person = (i: number) => MOCK_PEOPLE[i];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const codes = (r: Row) => (r.warnings as { code: string }[]).map((w) => w.code);

describe('contract v1.1 and the push intake (W11)', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    enableBellwether();
  });
  afterAll(() => disableBellwether());

  const admin = () => ({ id: b.users.ria.id, role: 'ADMIN' as Role, podIds: [] as string[] });
  const alisaGuard = () => ({ id: b.users.alisa.id, role: 'SENIOR_FO' as Role, podIds: [b.pods.Alisa.id] });
  const statusOf = async (id: string, contract?: '1.1') => (await status({ bellwetherContactIds: [id] }, contract ? V11 : {})).body.results[0] as Row;

  describe('versions (PLAN 7.3)', () => {
    it('ping lists contracts 1 and 1.1 to every caller, so Bellwether can learn it before it sends the header', async () => {
      expect((await ping()).body).toEqual(expect.objectContaining({ ok: true, version: '1', contracts: ['1', '1.1'] }));
      expect((await ping(V11)).body.contracts).toEqual(['1', '1.1']);
    });

    it('a request without X-Cadence-Contract gets exactly the v1 answer: v1 fields, v1 warning codes, no refused status', async () => {
      const c = bwContact({ email: null, phone: null });
      const v1 = await push(envelope([c]));
      expect(Object.keys(v1.body.results[0]).sort()).toEqual(['bellwetherContactId', 'cadenceContactId', 'crmPersonId', 'crmUrl', 'detail', 'filledFields', 'matchedOn', 'ownerEmail', 'ownerName', 'reason', 'result', 'warnings']);
      expect(codes(v1.body.results[0])).toEqual([]);
      const row = await statusOf(c.bellwetherContactId);
      expect(Object.keys(row)).toEqual(['bellwetherContactId', 'status', 'cadenceContactId', 'ownerEmail', 'ownerName', 'campaignName', 'callCount', 'lastActivityAt', 'movedToCrmAt', 'crmPersonId', 'crmUrl', 'statusChangedAt']);
      // The same contact read with 1.1 has the new fields, and the push's warnings were kept for it.
      const v11 = await statusOf(c.bellwetherContactId, '1.1');
      expect(v11.cadenceUrl).toMatch(new RegExp(`/cold-outreach/${row.cadenceContactId}$`));
      const again = await check(envelope([bwContact({ email: null, phone: null })]), V11);
      expect(codes(again.body.results[0])).toEqual(['no_reach']);
    });
  });

  describe('push intake (PLAN 8.10)', () => {
    it('B012: one contact Cadence fails on is that contact\'s internal_error; the rest go in and the push is DONE', async () => {
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION b012_breaks() RETURNS trigger AS $$ BEGIN IF NEW."lastName" = 'Breaks' THEN RAISE EXCEPTION 'b012: this row breaks'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER b012_breaks BEFORE INSERT ON "SandboxContact" FOR EACH ROW EXECUTE FUNCTION b012_breaks()`);
      try {
        const key = randomUUID();
        const r = await push(envelope([bwContact(), bwContact({ lastName: 'Breaks' }), bwContact()]), { ...V11, idempotencyKey: key });
        expect(r.status).toBe(200);
        expect(r.body.results.map((x: Row) => `${x.result}:${x.reason ?? ''}`)).toEqual(['created:', 'rejected:internal_error', 'created:']);
        expect(await prisma.bellwetherPush.findUniqueOrThrow({ where: { idempotencyKey: key } })).toEqual(expect.objectContaining({ state: 'DONE' }));
        // An internal error is never kept as a refusal: Bellwether may send the person again.
        expect(await prisma.bellwetherRefusal.count()).toBe(0);
        // The check answers the same, and its failed contact does not spoil the rest of its transaction.
        const c = await check(envelope([bwContact({ lastName: 'Breaks' }), bwContact()]), V11);
        expect(c.body.results.map((x: Row) => `${x.result}:${x.reason ?? ''}`)).toEqual(['rejected:internal_error', 'created:']);
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS b012_breaks ON "SandboxContact"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS b012_breaks()');
      }
    });

    it('B012: 503 is only for a database that is really down; control characters and numbers out of range never reach the database', async () => {
      expect(databaseDown({ code: 'P1001' })).toBe(true);
      expect(databaseDown(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(true);
      expect(databaseDown(new Error('Invalid `prisma.sandboxContact.create()` invocation: ConnectorError ... database'))).toBe(false);
      const r = await push(envelope([bwContact({ jobTitle: 'Part\u0000ner', city: 'Chi\u0007cago' }, { aumUsd: 1e30, employees: 3_000_000_000 })]), V11);
      expect(r.body.results[0].result).toBe('created');
      expect(r.body.results[0].warnings.map((w: Row) => w.field)).toEqual(['firm.aumUsd', 'firm.employees']);
      const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: r.body.results[0].cadenceContactId } });
      expect(row).toEqual(expect.objectContaining({ jobTitle: 'Partner', city: 'Chicago', companyAumUsd: null, companyEmployees: null }));
      expect((await push(envelope([bwContact({ bellwetherContactId: 'id\u0000x' })]))).body.results[0].detail).toBe('bellwetherContactId has control characters');
    });

    it('B012: a push cut off part-way is swept as failed, and the retry with the same key runs it again', async () => {
      const body = envelope([bwContact()]);
      const key = randomUUID();
      const { createHash } = await import('node:crypto');
      await prisma.bellwetherPush.create({ data: { idempotencyKey: key, bodyHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'), state: 'PROCESSING', pushedByEmail: 'alisa@cadence.local', contactCount: 1, createdAt: new Date(Date.now() - 11 * 60_000) } });
      expect(await sweepStuckPushes()).toBe(1);
      expect((await prisma.bellwetherPush.findUniqueOrThrow({ where: { idempotencyKey: key } })).state).toBe('FAILED');
      const retry = await push(body, { idempotencyKey: key });
      expect(retry.body.results[0].result).toBe('created');
      expect((await prisma.bellwetherPush.findUniqueOrThrow({ where: { idempotencyKey: key } })).state).toBe('DONE');
    });

    it('B014: a number with a typo is dropped, never read as a foreign one; "+44 (0)20" loses its trunk 0', () => {
      expect(parsePhone('212555014', 'US')).toBeNull();
      expect(parsePhone('44 20 7946 0000', 'US')).toBeNull();
      expect(parsePhone('1 (312) 555-0142', 'US')?.e164).toBe('+13125550142');
      expect(parsePhone('+44 (0)20 7946 0000', 'US')?.e164).toBe('+442079460000');
      expect(parsePhone('020 7946 0000', 'GB')?.e164).toBe('+442079460000');
      const c = normalizeContact(bwContact({ phone: '312555014', phoneType: 'direct' }));
      expect(c.ok && c.contact.phone).toBeNull();
      expect(c.ok && c.contact.warnings.map((w) => w.code)).toEqual(['phone_dropped']);
    });

    it('B072: options read in any case; a value Cadence cannot use is defaulted or left out with a warning, never silently', async () => {
      const c = normalizeContact(bwContact({ emailVerification: 'Valid', phone: '+1 312 555 0142', phoneType: 'Mobile', country: 'United Kingdom', doNotContact: 'false', notes: 'x'.repeat(5100), state: 'y'.repeat(120) }, { country: 'Narnia' }));
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      expect(c.contact).toEqual(expect.objectContaining({ emailVerification: 'valid', phoneType: 'mobile', country: 'GB', doNotContact: false, state: null, companyCountry: null }));
      expect(c.contact.notes!.length).toBeLessThanOrEqual(5000);
      expect(c.contact.warnings.map((w) => `${w.code}:${w.field}`)).toEqual(['note_truncated:notes', 'value_defaulted:firm.country', 'value_defaulted:state']);
      const odd = normalizeContact(bwContact({ phoneType: 'pager', country: 'Atlantis', doNotContact: 'true' }));
      expect(odd.ok && odd.contact.country).toBe('US');
      expect(odd.ok && odd.contact.doNotContact).toBe(true);
      expect(odd.ok && odd.contact.warnings.map((w) => w.field)).toEqual(['country', 'phoneType']);
      expect((await push(envelope([bwContact({}, { name: 'F'.repeat(201) })]))).body.results[0].detail).toBe('firm.name is longer than 200 characters');
      expect(normalizeCountry('uk')).toBe('GB');
      expect(normalizeCountry('U.S.A.')).toBe('US');
      expect(normalizeCountry('Deutschland')).toBeNull();
      // The manual form: a country name is its code; one Cadence does not know is asked again (contacts.ts:45).
      const added = await createContact({ firstName: 'Ann', lastName: 'Lee', country: 'United Kingdom', email: 'ann.lee@example-uk.co.uk' }, { id: b.users.alisa.id, podIds: [b.pods.Alisa.id], ownsContacts: true }, userActor(b.users.alisa));
      expect(added.ok && (await prisma.sandboxContact.findUniqueOrThrow({ where: { id: added.id } })).country).toBe('GB');
      expect(await createContact({ firstName: 'Bo', lastName: 'Ng', country: 'Atlantis' }, { id: b.users.alisa.id, podIds: [b.pods.Alisa.id], ownsContacts: true }, userActor(b.users.alisa))).toEqual({ ok: false, error: 'Enter the country as a two-letter code, like US or GB.' });
    });

    it('B114: HTML and markdown from Bellwether are made plain at the door, and every note Cadence writes to the CRM is plain', async () => {
      const r = await push(envelope([bwContact({ firstName: '<b>Jane</b>', lastName: 'Doe [x](javascript:alert(1))', notes: '<p>Met at <b>FPA</b></p><!-- x --> [deck](https://example.com/deck) [bad](javascript:alert(1))' })]), V11);
      const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: r.body.results[0].cadenceContactId }, include: { notes: true } });
      expect([row.firstName, row.lastName]).toEqual(['Jane', 'Doe x']);
      expect(row.notes[0].body).toBe('Met at FPA\ndeck (https://example.com/deck) bad');
      const mock = getMockTwentyClient();
      await writeNote(mock, { title: '<i>Call</i> 3 Nov', bodyMarkdown: 'Said <script>x</script> [here](javascript:y)', personId: person(0).id });
      expect(mock.notes.at(-1)).toEqual(expect.objectContaining({ title: 'Call 3 Nov' }));
      expect(JSON.stringify(mock.notes.at(-1))).not.toMatch(/<script>|javascript:/);
      expect(plainText('a < b and c > d')).toBe('a < b and c > d');
    });

    it('B169: LinkedIn is decoded before it is lower-cased; mailto: and a trailing dot are dropped; a CRM profile kept encoded is found', async () => {
      expect(normalizeLinkedin('https://www.linkedin.com/in/%C3%89lodie-D/')).toBe('linkedin.com/in/élodie-d');
      expect(normalizeLinkedin('linkedin.com/in/élodie-d')).toBe('linkedin.com/in/élodie-d');
      expect(normalizeEmail('mailto:Jane@Firm.com.')).toBe('jane@firm.com');
      expect(normalizeEmail('jane@firm')).toBeNull();
      expect(normalizeEmail('jane@@firm.com')).toBeNull();
      await prisma.personCache.update({ where: { id: person(1).id }, data: { linkedinUrl: 'https://www.linkedin.com/in/%C3%A9lodie-d' } });
      const r = await push(envelope([bwContact({ email: null, linkedinUrl: 'https://linkedin.com/in/%C3%89LODIE-D' })]));
      expect(r.body.results[0]).toEqual(expect.objectContaining({ result: 'already_in_crm', matchedOn: 'linkedin_url', crmPersonId: person(1).id }));
    });

    it('B170: an id of spaces is refused; the key and the pod are read in any case; internal and non-ASCII firm names compare whole', async () => {
      expect((await push(envelope([bwContact({ bellwetherContactId: '   ' })]))).body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'invalid_field', detail: 'bellwetherContactId is empty' }));
      const body = envelope([bwContact()]);
      const key = randomUUID();
      const first = await push(body, { idempotencyKey: key.toUpperCase() });
      const replay = await push(body, { idempotencyKey: key });
      expect(replay.body).toEqual({ ...first.body, replayed: true });
      const r = await push(envelope([bwContact()], { pushedBy: { email: 'karson@cadence.local' }, pod: 'alisa' }));
      expect(codes(r.body.results[0])).not.toContain('pod_ignored');
      const rules = (await getSettings()).rules;
      expect(isInternalCompany({ name: 'Acumen Strategy Group, LLC', domain: null }, rules)).toBe(true);
      expect(isInternalCompany({ name: 'Acumen Strategic Partners', domain: null }, rules)).toBe(false);
      expect(normalizeFirmName('Müller Vermögen GmbH & Co')).toBe('müller vermögen gmbh and');
    });

    it('B171: a contact nobody can reach is still created, and the push says so', async () => {
      const r = await push(envelope([bwContact({ email: 'not-an-email', phone: null, linkedinUrl: null })]), V11);
      expect(r.body.results[0].result).toBe('created');
      expect(codes(r.body.results[0])).toEqual(['email_dropped', 'no_reach']);
    });

    it('B172: a long job title is cut at a word, and the push says so', async () => {
      const title = `${'Managing Director '.repeat(12)}and Head of Wealth`;
      const r = await push(envelope([bwContact({ jobTitle: title })]), V11);
      const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: r.body.results[0].cadenceContactId } });
      expect(row.jobTitle!.length).toBeLessThanOrEqual(200);
      expect(title.startsWith(`${row.jobTitle!} `)).toBe(true);
      expect(r.body.results[0].warnings).toEqual([expect.objectContaining({ code: 'value_defaulted', field: 'jobTitle' })]);
      expect(cutAtWord('alpha beta gamma', 12)).toBe('alpha beta');
    });

    it('B173: two contacts of one push with one email: the one whose firm uses the domain keeps it, whatever the order; a shared inbox makes nobody a duplicate', async () => {
      const elsewhere = bwContact({ email: 'jane@northstarwealth.com' });
      const owner = bwContact({ email: 'jane@northstarwealth.com', firstName: 'Janet' }, { name: 'Northstar Wealth', website: 'https://northstarwealth.com' });
      const r = await push(envelope([elsewhere, owner]));
      expect(r.body.results.map((x: Row) => `${x.result}:${x.reason ?? ''}`)).toEqual(['rejected:duplicate_in_request', 'created:']);
      expect(r.body.results[0].detail).toBe(`jane@northstarwealth.com is also on Janet ${owner.lastName} in this push, whose firm uses that address's domain.`);
      const shared = await push(envelope([bwContact({ email: 'info@example-advisors.com' }), bwContact({ email: 'info@example-advisors.com' })]));
      expect(shared.body.results.map((x: Row) => x.result)).toEqual(['created', 'created']);
    });

    it('B018: a number that is the firm\'s switchboard is kept as the firm\'s line, never the person\'s, and never written onto the CRM person', async () => {
      const r = await push(envelope([bwContact({ phone: '+1 312 555 0000', phoneType: 'office', additionalPhones: [{ number: '+1 312 555 0177', type: 'direct' }] })]), V11);
      expect(r.body.results[0].warnings).toEqual([expect.objectContaining({ code: 'value_defaulted', field: 'phoneType' })]);
      const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: r.body.results[0].cadenceContactId }, include: { owner: true, pod: true } });
      expect(row.phoneType).toBe('main');
      const input = personInput(row as never, null, (await getSettings()).sandbox, (_f, v) => v, { leadSource: 'leadSource', productInterest: 'productInterest', tags: 'tags', contactType: 'contactType', listCategory: 'listCategory', pipelineStageField: 'pipelineStage' });
      expect([input.phone, input.additionalPhone]).toEqual(['+13125550177', null]);
    });
  });

  describe('dedupe and ownership (14.6, 14.7)', () => {
    it('B067: a note pushed for someone already in Cold outreach is added to that contact, once', async () => {
      const first = bwContact();
      const created = await push(envelope([first]));
      const again = { ...first, notes: 'Spoke at the conference' };
      const r = await push(envelope([again]), V11);
      expect(r.body.results[0]).toEqual(expect.objectContaining({ result: 'duplicate_in_sandbox', cadenceContactId: created.body.results[0].cadenceContactId }));
      expect(codes(r.body.results[0])).toEqual(['note_added']);
      await push(envelope([again]), V11);
      expect((await prisma.sandboxNote.findMany({ where: { sandboxContactId: created.body.results[0].cadenceContactId } })).map((n) => n.body)).toEqual(['Spoke at the conference']);
    });

    it('B068: a newer email and mobile are added for the owner to review; a new firm\'s office line is not; the owner reads what changed', async () => {
      const first = bwContact({ individualCrd: '7712001' });
      const created = await push(envelope([first]));
      const moved = bwContact({ individualCrd: '7712001', email: 'jane@northstarwealth.com', jobTitle: 'Managing Partner', phone: '+1 212 555 0142', phoneType: 'office', additionalPhones: [{ number: '+1 917 555 0101', type: 'mobile' }] }, { name: 'Northstar Wealth', crd: '288810', website: 'northstarwealth.com', phone: null });
      const r = await push(envelope([moved]), V11);
      // The mobile fills the empty extra phones; the email the contact has a different one of is added.
      expect(r.body.results[0]).toEqual(expect.objectContaining({ result: 'duplicate_in_sandbox', matchedOn: 'individual_crd', filledFields: ['additionalPhones'] }));
      expect(r.body.results[0].warnings).toEqual([expect.objectContaining({ code: 'details_changed', detail: 'Newer details from Bellwether: email jane@northstarwealth.com added; their firm there is Northstar Wealth; their title there is Managing Partner.' })]);
      const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: created.body.results[0].cadenceContactId }, include: { notes: true } });
      expect(row.additionalEmails).toEqual(['jane@northstarwealth.com']);
      expect(row.additionalPhones).toEqual([{ number: '+19175550101', type: 'mobile' }]);
      expect([row.companyName, row.jobTitle]).toEqual(['Example Advisors LLC', 'Partner']);
      expect(row.notes.map((n) => n.body)).toEqual([expect.stringMatching(/^Newer details from Bellwether: .* Check them before the next step\.$/)]);
      // The newer email now finds the same contact: no second one.
      expect((await push(envelope([bwContact({ email: 'jane@northstarwealth.com' })]))).body.results[0].result).toBe('duplicate_in_sandbox');
    });

    it('B069: the check answers exactly what the push will, duplicates within the request included, and writes nothing', async () => {
      const a = bwContact({ individualCrd: '4400001', notes: 'First' });
      const twin = bwContact({ individualCrd: '4400001', notes: 'Second', email: null });
      const before = await counts();
      const c = await check(envelope([a, twin]), V11);
      expect(await counts()).toEqual(before);
      expect(c.body.results.map((x: Row) => [x.result, x.matchedOn, x.cadenceContactId, codes(x)])).toEqual([['created', null, null, []], ['duplicate_in_sandbox', 'individual_crd', null, ['note_added']]]);
      const p = await push(envelope([a, twin]), V11);
      expect(p.body.results.map((x: Row) => [x.result, x.matchedOn, codes(x)])).toEqual([['created', null, []], ['duplicate_in_sandbox', 'individual_crd', ['note_added']]]);
      expect(p.body.results[1].cadenceContactId).toBe(p.body.results[0].cadenceContactId);
    });

    it('B073: the check asks the CRM itself like the push, and leaves Cadence\'s copy of the CRM as it was', async () => {
      await prisma.personCache.delete({ where: { id: person(0).id } });
      const c = await check(envelope([bwContact({ email: person(0).email })]));
      expect(c.body.results[0]).toEqual(expect.objectContaining({ result: 'already_in_crm', crmPersonId: person(0).id }));
      expect(await prisma.personCache.findUnique({ where: { id: person(0).id } })).toBeNull();
      expect((await push(envelope([bwContact({ email: person(0).email })]))).body.results[0].result).toBe('already_in_crm');
      expect(await prisma.personCache.findUnique({ where: { id: person(0).id } })).not.toBeNull();
    });

    it('B017: someone who may already be in Cold outreach (same firm and last name, or a shared office line) is created with a warning naming them', async () => {
      const first = await push(envelope([bwContact({ lastName: 'Okafor' })]));
      const r = await push(envelope([bwContact({ firstName: 'Bob', lastName: 'Okafor', email: 'bob.okafor@other-mail.com' })]), V11);
      expect(r.body.results[0].result).toBe('created');
      expect(r.body.results[0].warnings).toEqual([expect.objectContaining({ code: 'possible_sandbox_duplicate', detail: `Possibly the same person as Jane Okafor, already in Cold outreach at the same firm.` })]);
      expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: r.body.results[0].cadenceContactId } })).possibleDuplicateId).toBe(first.body.results[0].cadenceContactId);
      const line = await push(envelope([bwContact({ phone: '+1 312 555 0190', phoneType: 'office' })]));
      const colleague = await push(envelope([bwContact({ phone: '+1 312 555 0190', phoneType: 'office' })]), V11);
      expect(colleague.body.results[0].warnings[0]).toEqual(expect.objectContaining({ code: 'possible_sandbox_duplicate' }));
      expect(line.body.results[0].result).toBe('created');
    });

    // U01, U02, U03, U05 (agreed owner contract, 13 Nov 2026): this test used to expect unclaimed contacts.
    it('B070, U01: an owner Cadence cannot give contacts to, an admin included, gets each new contact refused (owner_not_found), saying who and why', async () => {
      const admin = await push(envelope([bwContact()], { pushedBy: { email: 'ria@cadence.local' } }), V11);
      expect(admin.body.owner).toBeNull();
      expect(admin.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'owner_not_found', cadenceContactId: null, detail: expect.stringContaining('an admin') }));
      const unknown = await push(envelope([bwContact()], { assignTo: { email: 'nobody@cadence.local' } }), V11);
      expect(unknown.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'owner_not_found', detail: expect.stringContaining('nobody@cadence.local is not a Cadence user.') }));
      // U02, U03: checked when the push arrives, however old Bellwether's list or its queued request is.
      await prisma.user.update({ where: { id: b.users.karson.id }, data: { active: false } });
      const left = await push(envelope([bwContact()], { assignTo: { email: 'karson@cadence.local' } }), V11);
      expect(left.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'owner_not_found', detail: expect.stringMatching(/no longer has access/) }));
      // The check says the same before any send, so Bellwether can stop it.
      const preview = await check(envelope([bwContact()], { assignTo: { email: 'karson@cadence.local' } }), V11);
      expect(preview.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'owner_not_found' }));
      expect(await prisma.sandboxContact.count({ where: { ownerId: null } })).toBe(0);
      // U05: a person already in Cold outreach keeps the owner they have; the push changes nothing there.
      const kept = bwContact();
      await push(envelope([kept]), V11);
      const again = await push(envelope([kept], { pushedBy: { email: 'ria@cadence.local' } }), V11);
      expect(again.body.results[0]).toEqual(expect.objectContaining({ result: 'duplicate_in_sandbox', ownerEmail: 'alisa@cadence.local' }));
    });

    it('B071: pushing a moved contact again keeps it moved_to_crm, with its Cadence id and move date', async () => {
      const c = bwContact({ email: person(0).email!.replace('@', '.cold@') });
      const created = await push(envelope([c]));
      const id = created.body.results[0].cadenceContactId;
      const movedAt = new Date('2026-11-04T10:00:00Z');
      await prisma.sandboxContact.update({ where: { id }, data: { status: 'MOVED', twentyPersonId: person(0).id, movedAt, statusChangedAt: movedAt } });
      const again = await push(envelope([{ ...c, email: person(0).email }]));
      expect(again.body.results[0]).toEqual(expect.objectContaining({ result: 'already_in_crm', crmPersonId: person(0).id }));
      expect(await statusOf(c.bellwetherContactId)).toEqual(expect.objectContaining({ status: 'moved_to_crm', cadenceContactId: id, movedToCrmAt: '2026-11-04T10:00:00Z' }));
      expect(await prisma.bellwetherRefusal.count()).toBe(0);
    });

    it('N003: the same name at the same firm as a CRM Do not contact person is refused and reads opted_out', async () => {
      const p = person(3);
      await prisma.personCache.update({ where: { id: p.id }, data: { dnd: true } });
      const company = await prisma.companyCache.findUniqueOrThrow({ where: { id: p.companyId! } });
      const c = bwContact({ firstName: p.firstName, lastName: p.lastName, email: 'someone.new@elsewhere-mail.com' }, { name: company.name });
      expect((await push(envelope([c]), V11)).body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'suppressed' }));
      expect(await statusOf(c.bellwetherContactId, '1.1')).toEqual(expect.objectContaining({ status: 'opted_out', crmPersonId: p.id }));
    });
  });

  describe('status read-back (14.12)', () => {
    it('B015: every refusal is kept and read back as refused with its reason (1.1); a v1 reader never sees one', async () => {
      await prisma.blockedAccount.create({ data: { companyId: 'blocked-co', name: 'Blocked Wealth', domain: 'blocked-wealth.com' } });
      const blocked = bwContact({}, { name: 'Blocked Wealth LLC', website: 'blocked-wealth.com' });
      const broken = bwContact({ lastName: '' });
      const dnc = bwContact({ doNotContact: true });
      const since = new Date(Date.now() - 60_000).toISOString();
      await push(envelope([blocked, broken, dnc]), V11);
      const r = (await status({ bellwetherContactIds: [blocked.bellwetherContactId, broken.bellwetherContactId, dnc.bellwetherContactId] }, V11)).body.results;
      expect(r.map((x: Row) => `${x.status}:${x.reason}`)).toEqual(['refused:blocked_account', 'refused:invalid_field', 'refused:do_not_contact']);
      expect((await statusOf(blocked.bellwetherContactId)).status).toBe('not_found');
      expect((await status({ changedSince: since }, V11)).body.results).toHaveLength(3);
      expect((await status({ changedSince: since })).body.results).toHaveLength(0);
      // A refusal never hides a contact Cadence still has for the same id.
      const live = bwContact();
      await push(envelope([live]));
      await push(envelope([{ ...live, doNotContact: true }]), V11);
      expect((await statusOf(live.bellwetherContactId, '1.1')).status).toBe('in_sandbox');
    });

    it('B022: GET /owners lists who can own contacts, with their pods as Bellwether sends them; never an admin, Biz Ops, a leaver or someone in no pod', async () => {
      await prisma.user.update({ where: { id: b.users.daniel.id }, data: { active: false } });
      await prisma.user.create({ data: { email: 'ops@cadence.local', name: 'Ops Person', role: 'BIZ_OPS', passwordHash: 'x', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
      await prisma.userPod.create({ data: { userId: b.users.leigh.id, podId: b.pods.Alisa.id } });
      const r = await owners(V11);
      expect(r.status).toBe(200);
      expect(r.body.owners.map((o: Row) => `${o.email}:${o.pods.join('+')}`).sort()).toEqual(['alisa@cadence.local:ALISA', 'andrew@cadence.local:ANDREW', 'karson@cadence.local:ALISA', 'leigh@cadence.local:ALISA+LEIGH']);
      // U16: each owner also carries the other addresses Cadence accepts for them.
      expect(Object.keys(r.body.owners[0])).toEqual(['email', 'name', 'pods', 'aliases']);
      expect((await owners({ key: 'wrong' })).status).toBe(401);
    });

    it('B061: a claim, an assignment and a release reach Bellwether\'s read of changes, with the new owner; a leaver owns nothing', async () => {
      const c = bwContact();
      const pushed = await push(envelope([c]));
      const id = pushed.body.results[0].cadenceContactId;
      // Unclaimed (U01: a push no longer makes one, so it is let go here).
      await prisma.sandboxContact.update({ where: { id }, data: { ownerId: null, claimedAt: null, podId: b.pods.Alisa.id, statusChangedAt: new Date('2026-11-01T00:00:00Z') } });
      const since = '2026-11-02T00:00:00Z';
      expect((await status({ changedSince: since })).body.results).toHaveLength(0);
      expect((await claimContact(id, { id: b.users.alisa.id, podIds: [b.pods.Alisa.id], role: 'SENIOR_FO' }, userActor(b.users.alisa))).ok).toBe(true);
      const claimed = (await status({ changedSince: since })).body.results;
      expect(claimed).toEqual([expect.objectContaining({ bellwetherContactId: c.bellwetherContactId, ownerEmail: 'alisa@cadence.local' })]);
      const t1 = claimed[0].statusChangedAt;
      expect((await assignContact(id, b.users.karson.id, userActor(b.users.alisa), null, alisaGuard())).ok).toBe(true);
      expect(await statusOf(c.bellwetherContactId)).toEqual(expect.objectContaining({ ownerEmail: 'karson@cadence.local' }));
      expect((await assignContact(id, null, userActor(b.users.ria), null, admin())).ok).toBe(true);
      const released = (await status({ changedSince: t1 })).body.results;
      expect(released).toEqual([expect.objectContaining({ ownerEmail: null })]);
      await assignContact(id, b.users.alisa.id, userActor(b.users.ria), null, admin());
      await prisma.user.update({ where: { id: b.users.alisa.id }, data: { active: false } });
      expect(await statusOf(c.bellwetherContactId)).toEqual(expect.objectContaining({ ownerEmail: null, ownerName: null }));
    });

    it('B062: every change time and serverTime come from the database\'s clock, never an app server\'s or a push that began earlier', async () => {
      const raw = JSON.stringify(envelope([bwContact()]));
      const env = validateEnvelope(JSON.parse(raw), { idempotencyKey: randomUUID(), requireKey: true }) as Envelope;
      const r = await pushWithIdempotency(env, raw, randomUUID(), new Date('2020-01-01T00:00:00Z'));
      const id = (r as { body: { results: Row[] } }).body.results[0].cadenceContactId;
      const db = await databaseNow();
      const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id } });
      expect(Math.abs(row.statusChangedAt.getTime() - db.getTime())).toBeLessThan(60_000);
      const s = await status({ bellwetherContactIds: ['x'] });
      expect(Math.abs(Date.parse(s.body.serverTime) - db.getTime())).toBeLessThan(60_000);
    });

    it('B086: a removed contact says who removed it, when and why; retention says it was retention', async () => {
      const c = bwContact();
      const id = (await push(envelope([c]))).body.results[0].cadenceContactId;
      expect((await removeContact(id, userActor(b.users.alisa), new Date(), { guard: alisaGuard(), reason: 'Retired' })).ok).toBe(true);
      expect(await statusOf(c.bellwetherContactId, '1.1')).toEqual(expect.objectContaining({ status: 'removed', removedBy: b.users.alisa.name, removedReason: 'Retired', removedAt: expect.stringMatching(/Z$/) }));
      const r = bwContact();
      const rid = (await push(envelope([r]))).body.results[0].cadenceContactId;
      await removeContact(rid, { type: 'SYSTEM', label: 'Cadence' }, new Date(), { reason: 'No activity for a long time (retention).' });
      expect(await statusOf(r.bellwetherContactId, '1.1')).toEqual(expect.objectContaining({ removedBy: null, removedReason: 'No activity for a long time (retention).' }));
    });

    it('N039: an erased contact reads opted_out with erasedAt; contacts erased before the release get it from their audit row', async () => {
      const c = bwContact();
      const id = (await push(envelope([c]))).body.results[0].cadenceContactId;
      expect((await eraseContact(id, userActor(b.users.ria), new Date(), admin())).ok).toBe(true);
      expect(await statusOf(c.bellwetherContactId, '1.1')).toEqual(expect.objectContaining({ status: 'opted_out', erasedAt: expect.stringMatching(/Z$/), emailBounced: null }));
      // The release's backfill: an erasure from before it.
      const old = bwContact();
      const oldId = (await push(envelope([old]))).body.results[0].cadenceContactId;
      await prisma.auditLog.create({ data: { entityType: 'sandbox_contact', entityId: oldId, action: 'erased', actorType: 'USER', createdAt: new Date('2026-11-04T09:00:00Z') } });
      const sql = fs.readFileSync(path.join(process.cwd(), 'prisma', 'migrations', '20261106100000_contract_v1_1', 'migration.sql'), 'utf8');
      await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('DO $$')));
      await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('DO $$')));
      expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: oldId } })).erasedAt).toEqual(new Date('2026-11-04T09:00:00Z'));
      expect(await prisma.auditLog.count({ where: { action: 'erased_at_backfill' } })).toBe(1);
    });

    it('N040: a bounce reaches Bellwether with the address and when, at its next read of changes', async () => {
      const c = bwContact();
      const id = (await push(envelope([c]))).body.results[0].cadenceContactId;
      await prisma.sandboxContact.update({ where: { id }, data: { statusChangedAt: new Date('2026-11-01T00:00:00Z') } });
      await prisma.sandboxEmail.create({ data: { sandboxContactId: id, kind: 'BOUNCE', internetMessageId: '<n040@example.test>', at: new Date('2026-11-05T09:00:00Z'), subject: 'Undeliverable' } });
      await bounceDetected({ sandboxContactId: id }, { actor: { type: 'SYSTEM', label: 'Cadence' } });
      const changed = (await status({ changedSince: '2026-11-02T00:00:00Z' }, V11)).body.results;
      expect(changed).toEqual([expect.objectContaining({ bellwetherContactId: c.bellwetherContactId, emailBounced: c.email, emailBouncedAt: '2026-11-05T09:00:00Z' })]);
    });

    it('N040: a possible bounce a rep confirmed reaches Bellwether with when it was confirmed, never a null time', async () => {
      const c = bwContact();
      const id = (await push(envelope([c]))).body.results[0].cadenceContactId;
      await prisma.sandboxContact.update({ where: { id }, data: { statusChangedAt: new Date('2026-11-01T00:00:00Z'), badEmail: true } });
      await prisma.auditLog.create({ data: { entityType: 'sandbox_contact', entityId: id, action: 'possible_bounce_confirmed', actorType: 'USER', createdAt: new Date('2026-11-05T10:30:00Z') } });
      const rows = (await status({ bellwetherContactIds: [c.bellwetherContactId] }, V11)).body.results;
      expect(rows).toEqual([expect.objectContaining({ emailBounced: c.email, emailBouncedAt: '2026-11-05T10:30:00Z' })]);
    });

    it('contract 1.1 lastOutcome: the latest post-call outcome reaches Bellwether at its next read of changes', async () => {
      const c = bwContact({ phone: '+1 312 555 0161', phoneType: 'direct' });
      const id = (await push(envelope([c]))).body.results[0].cadenceContactId;
      await prisma.sandboxContact.update({ where: { id }, data: { statusChangedAt: new Date('2026-11-01T00:00:00Z') } });
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: id });
      const r = await submitCallForm(call.id, { outcome: 'not_interested', rating: 2, notes: 'Happy with their current adviser', nextStep: 'none' }, { id: b.users.alisa.id, name: b.users.alisa.name, timezone: 'Europe/London', role: 'SENIOR_FO', podIds: [b.pods.Alisa.id] });
      expect(r).toEqual(expect.objectContaining({ ok: true }));
      expect((await status({ changedSince: '2026-11-02T00:00:00Z' }, V11)).body.results).toEqual([expect.objectContaining({ lastOutcome: 'not_interested', lastOutcomeAt: expect.stringMatching(/Z$/), callCount: 1 })]);
    });

    it('D4: a lift reaches Bellwether as optOutLiftedAt once the contact no longer reads opted_out, a moved person\'s refusal included', async () => {
      const c = bwContact();
      const id = (await push(envelope([c]))).body.results[0].cadenceContactId;
      await optOutContact(id, { source: 'call_form', actor: userActor(b.users.alisa) });
      expect(await statusOf(c.bellwetherContactId, '1.1')).toEqual(expect.objectContaining({ status: 'opted_out', optOutLiftedAt: null }));
      expect((await liftOptOut(coldRef(id), { actor: userActor(b.users.ria), guard: admin() })).ok).toBe(true);
      expect(await statusOf(c.bellwetherContactId, '1.1')).toEqual(expect.objectContaining({ status: 'in_sandbox', optOutLiftedAt: expect.stringMatching(/Z$/) }));
      // A push refused because the person is in the CRM, then the CRM person opted out by a call and lifted.
      const crm = bwContact({ email: person(4).email });
      await push(envelope([crm]));
      await optOutPerson(person(4).id, { source: 'call_form', actor: userActor(b.users.alisa) });
      expect(await statusOf(crm.bellwetherContactId, '1.1')).toEqual(expect.objectContaining({ status: 'opted_out', optOutLiftedAt: null }));
      await liftOptOut(personRef(person(4).id), { actor: userActor(b.users.ria), guard: admin() });
      expect(await statusOf(crm.bellwetherContactId, '1.1')).toEqual(expect.objectContaining({ status: 'already_in_crm', optOutLiftedAt: expect.stringMatching(/Z$/) }));
    });
  });

  describe('section 14 and Bellwether\'s fixture', () => {
    const section = (file: string) => {
      const text = fs.readFileSync(file, 'utf8');
      const start = text.indexOf('## Shared contract with Bellwether');
      return text.slice(start, text.indexOf('\n## ', start + 1) + 1);
    };
    const ownPlan = path.join(process.cwd(), 'docs', 'outreach-sandbox-plan.md');
    const blocks = () => [...section(ownPlan).matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));

    it('section 14\'s v1.1 examples have exactly the fields Cadence answers with', async () => {
      const [pingEx, , push11Ex, , status11Ex, suppressReqEx, suppressResEx, ownersEx] = blocks();
      expect(Object.keys((await ping()).body).sort()).toEqual(Object.keys(pingEx).sort());
      const c = bwContact();
      const pushed = await push(envelope([c]), V11);
      expect(Object.keys(pushed.body.results[0]).sort()).toEqual(Object.keys(push11Ex.results[0]).sort());
      for (const ex of status11Ex.results) expect(Object.keys(await statusOf(c.bellwetherContactId, '1.1')).sort()).toEqual(Object.keys(ex).sort());
      expect(Object.keys(suppressReqEx).sort()).toEqual(['actor', 'contacts', 'note', 'reason']);
      expect(Object.keys(suppressResEx.results[0]).sort()).toEqual(['bellwetherContactId', 'cadenceContactId', 'crmPersonId', 'result']);
      expect(Object.keys((await owners(V11)).body.owners[0])).toEqual(Object.keys(ownersEx.owners[0]));
    });

    it('both plans carry section 14 word for word, and Bellwether\'s fixture is generated from it', () => {
      const bellwether = path.join(process.cwd(), '..', 'Scrapper');
      if (!fs.existsSync(bellwether)) return;
      expect(section(path.join(bellwether, 'docs', 'outreach-sandbox-plan.md'))).toBe(section(ownPlan));
      const fx = JSON.parse(fs.readFileSync(path.join(bellwether, 'scripts', 'cadence_contract_fixture.json'), 'utf8'));
      const [pingEx, pushEx, push11Ex, statusEx, status11Ex, suppressReqEx, suppressResEx, ownersEx] = blocks();
      expect([fx.ping, fx.push_response, fx.v1_1.push_response, fx.status_response, fx.v1_1.status_response, fx.v1_1.suppress_request, fx.v1_1.suppress_response, fx.v1_1.owners_response]).toEqual([pingEx, pushEx, push11Ex, statusEx, status11Ex, suppressReqEx, suppressResEx, ownersEx]);
      expect(fx.v1_1.ping).toEqual(pingEx);
    });
  });
});

async function counts() {
  const [contacts, notes, refusals, audits, people] = await Promise.all([prisma.sandboxContact.count(), prisma.sandboxNote.count(), prisma.bellwetherRefusal.count(), prisma.auditLog.count(), prisma.personCache.count()]);
  return { contacts, notes, refusals, audits, people };
}
