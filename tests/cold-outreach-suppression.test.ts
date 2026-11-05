import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import { upsertPersonCache } from '@/lib/person-cache';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { createContact, eraseContact } from '@/lib/sandbox/contacts';
import { optOutPerson, optOutSandboxContact, suppressValue } from '@/lib/sandbox/opt-out';
import { crmMatch } from '@/lib/sandbox/dedupe';
import { checkSandboxAgainstCrm } from '@/lib/sandbox/crm-check';
import { findSuppressed, suppressionHash } from '@/lib/sandbox/suppression';
import { contactability } from '@/lib/outreach/contactability';
import { liftOptOut } from '@/lib/outreach/transitions';
import { coldRef, personRef } from '@/lib/subject';
import { logManualCall, submitCallForm } from '@/lib/calls/form';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { bwContact, disableBellwether, enableBellwether, envelope, push, readyContact } from './helpers/sandbox';

/**
 * Stage S2: suppression follows the person (PLAN 8.3), every opt-out of a CRM person reaches the CRM
 * (D6), and a form opt-out can be lifted (D4).
 */
describe('suppression follows the person', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    enableBellwether();
  });
  afterAll(() => disableBellwether());
  const by = () => ({ id: b.users.alisa.id, podIds: [b.pods.Alisa.id], ownsContacts: true });
  const actor = () => userActor(b.users.alisa);

  it('B001: a number someone asked us never to call stays blocked however it is typed, on push, manual add and the Call button', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550177', phoneType: 'direct' });
    await optOutSandboxContact(c.id, { source: 'contact_page', actor: actor() });
    const again = await push(envelope([bwContact({ phone: '+1 312 555 0177', phoneType: 'office' })]));
    expect(again.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'suppressed' }));
    const added = await createContact({ firstName: 'Other', lastName: 'Name', phone: '312 555 0177', phoneType: 'unknown' }, by(), actor());
    expect(added).toEqual({ ok: false, error: 'This person is on the suppression list and cannot be contacted.' });
    // A CRM person on that number: the Call button refuses that exact number.
    await prisma.personCache.update({ where: { id: 'person-03' }, data: { phoneE164: '+13125550177' } });
    expect(await contactability(personRef('person-03'), { act: 'call', number: '+13125550177' })).toEqual(expect.objectContaining({ ok: false, block: 'suppressed' }));
  });

  it('B001: an opt-out hashes every phone, a shared line for that one person only', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550100', phoneType: 'office', additionalPhones: [{ number: '+13125550101', type: 'mobile' }] });
    await optOutSandboxContact(c.id, { source: 'contact_page', actor: actor() });
    expect(await findSuppressed([{ kind: 'phone', value: '+13125550101' }])).not.toBeNull();
    expect(await findSuppressed([{ kind: 'phone_subject', value: '+13125550100', subjectId: c.id }])).not.toBeNull();
    // A colleague on the same office line is not blocked by it.
    const colleague = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550100', phoneType: 'office' });
    expect((await contactability(coldRef(colleague.id), { act: 'call', number: '+13125550100', now: new Date('2026-11-04T18:00:00Z') })).ok).toBe(true);
  });

  it('B002: the same person under a new Bellwether record, the same CRD at another firm, or an old unhashed opt-out is refused', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { individualCrd: '7712001' });
    await optOutSandboxContact(c.id, { source: 'contact_page', actor: actor() });
    const crd = await push(envelope([bwContact({ individualCrd: '7712001' }, { name: 'Another Firm LLC', website: 'https://another.example' })]));
    expect(crd.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'suppressed', detail: 'This contact\'s individual CRD is on Cadence\'s suppression list.' }));
    // An opt-out from before the wider keys, never hashed: the opted-out row itself counts.
    const old = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { status: 'OPTED_OUT', optedOutAt: new Date(), email: 'old.optout@rivera-wealth.com' });
    const twin = await push(envelope([bwContact({ email: 'Old.Optout@rivera-wealth.com' })]));
    expect(twin.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'suppressed' }));
    expect(await createContact({ firstName: 'Old', lastName: 'Optout', email: 'old.optout@rivera-wealth.com' }, by(), actor())).toEqual({ ok: false, error: 'This person asked not to be contacted on another record, so they cannot be added.' });
    expect(old.status).toBe('OPTED_OUT');
  });

  it('B010: a person who arrives in the CRM copy with a suppressed email (any capitals) is opted out, in the CRM too', async () => {
    await suppressValue({ kind: 'email', value: 'new.person@example.org' }, { actor: actor() });
    const mock = getMockTwentyClient();
    const person = { ...mock.people[0], id: 'person-new', email: 'New.Person@Example.org', additionalEmails: [], deletedAt: null };
    mock.people.push(person);
    await upsertPersonCache(person);
    expect(await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-new' } })).toEqual(expect.objectContaining({ optedOut: true, optOutSource: 'suppression_list', dnd: true }));
    expect(mock.writes).toContainEqual(expect.objectContaining({ op: 'setPersonDnd', id: 'person-new' }));
  });

  it('B007, D6: opting out a CRM person cancels their next action in Cadence and in the CRM, ends their sequences, and sets Do not contact there, logged', async () => {
    const personId = 'person-02';
    await prisma.nextAction.create({ data: { personId, foUserId: b.users.alisa.id, label: 'Call', action: 'CALL', dueDate: '2099-01-05', crmPending: false, audience: 'CRM' } });
    await prisma.personCache.update({ where: { id: personId }, data: { nextAction: 'Call', nextActionDueDate: '2099-01-05' } });
    const enrollment = await prisma.enrollment.create({ data: { personId, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2099-01-01', status: 'ACTIVE', audience: 'CRM' } });
    await optOutPerson(personId, { source: 'person_page', actor: actor() });
    expect(await prisma.nextAction.count({ where: { personId, state: 'OPEN' } })).toBe(0);
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('EXITED');
    const crm = getMockTwentyClient().people.find((p) => p.id === personId)!;
    expect(crm).toEqual(expect.objectContaining({ dnd: true, nextAction: null }));
    expect(await prisma.twentyWrite.findFirst({ where: { operation: 'setPersonDnd', twentyId: personId, status: 'OK' } })).not.toBeNull();
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: personId } })).dnd).toBe(true);
  });

  it('D6: the form\'s "Asked not to be contacted" on a CRM person sets Do not contact in the CRM and says so', async () => {
    const call = await logManualCall({ userId: b.users.alisa.id, personId: 'person-01' });
    const r = await submitCallForm(call.id, { outcome: 'do_not_contact', rating: 2, notes: 'Asked us to stop', nextStep: 'none' }, { id: b.users.alisa.id, name: 'Alisa', timezone: 'Europe/London' });
    expect(r).toEqual(expect.objectContaining({ ok: true, reminder: 'Do not contact is set on this person in the CRM too.' }));
    expect(getMockTwentyClient().people.find((p) => p.id === 'person-01')?.dnd).toBe(true);
  });

  it('N011: opting out a CRM person flips only refusals that matched their own details, and keeps their phone to them', async () => {
    const personId = 'person-03';
    const person = await prisma.personCache.findUniqueOrThrow({ where: { id: personId } });
    await prisma.bellwetherRefusal.createMany({ data: [
      { bellwetherContactId: 'bw:own', status: 'already_in_crm', crmPersonId: personId, matchedOn: 'email' },
      { bellwetherContactId: 'bw:colleague', status: 'already_in_crm', crmPersonId: personId, matchedOn: 'phone_shared' },
    ] });
    await optOutPerson(personId, { source: 'person_page', actor: actor() });
    const refusals = await prisma.bellwetherRefusal.findMany({ orderBy: { bellwetherContactId: 'asc' } });
    expect(refusals.map((r) => [r.bellwetherContactId, r.status])).toEqual([['bw:colleague', 'already_in_crm'], ['bw:own', 'opted_out']]);
    expect(await findSuppressed([{ kind: 'phone', value: person.phoneE164! }])).toBeNull();
    expect(await findSuppressed([{ kind: 'phone_subject', value: person.phoneE164!, subjectId: personId }])).not.toBeNull();
  });

  it('N011: a push refused for being in the CRM records what it matched on', async () => {
    const person = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-04' } });
    const c = bwContact({ email: person.email });
    await push(envelope([c]));
    expect(await prisma.bellwetherRefusal.findUniqueOrThrow({ where: { bellwetherContactId: c.bellwetherContactId as string } })).toEqual(expect.objectContaining({ status: 'already_in_crm', matchedOn: 'email', crmPersonId: 'person-04' }));
  });

  it('N003: a contact whose name and firm are Do not contact in the CRM is refused on add and push, and never contacted', async () => {
    // person-07 is Sofia Lindqvist, Do not contact in the CRM.
    const sofia = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-07' } });
    const added = await createContact({ firstName: 'Sofia', lastName: 'LINDQVIST', companyName: sofia.companyName, email: 'sofia.private@example.org' }, by(), actor());
    expect(added).toEqual({ ok: false, error: 'Sofia Lindqvist is marked Do not contact in the CRM.' });
    const r = await push(envelope([bwContact({ firstName: 'Sofia', lastName: 'Lindqvist' }, { name: sofia.companyName! })]));
    expect(r.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'suppressed', detail: 'Sofia Lindqvist is marked Do not contact in the CRM.', crmPersonId: null }));
    expect(await prisma.bellwetherRefusal.findUniqueOrThrow({ where: { bellwetherContactId: r.body.results[0].bellwetherContactId } })).toEqual(expect.objectContaining({ status: 'opted_out', matchedOn: 'name_firm', crmPersonId: 'person-07' }));
    const existing = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Sofia', lastName: 'Lindqvist', companyName: sofia.companyName });
    expect(await contactability(coldRef(existing.id), { act: 'next_step', channel: 'EMAIL' })).toEqual(expect.objectContaining({ ok: false, block: 'do_not_contact' }));
  });

  it('B073: a CRM person known by an additional email with capitals is found', async () => {
    await prisma.personCache.update({ where: { id: 'person-05' }, data: { additionalEmails: ['Second.Address@Elsewhere.com'], additionalEmailsNorm: ['second.address@elsewhere.com'] } });
    const hit = await crmMatch({ bellwetherContactId: null, firstName: 'X', lastName: 'Y', email: 'second.address@elsewhere.com', additionalEmails: [], phone: null, phoneType: 'unknown', additionalPhones: [], linkedinUrl: null, individualCrd: null, companyName: null, companyDomain: null, companyCrd: null, companyPhone: null });
    expect(hit?.person.id).toBe('person-05');
  });

  it('B156: the nightly check reads past a person the CRM\'s mail sync created to the real one behind it', async () => {
    const real = await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-06' } });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: 'shared.lead@auto.example', linkedinUrl: 'linkedin.com/in/jonah-adeyemi' });
    await prisma.personCache.create({ data: { id: 'auto-1', firstName: 'Shared', lastName: 'Lead', email: 'shared.lead@auto.example', emailNorm: 'shared.lead@auto.example', createdBySource: 'EMAIL' } });
    await prisma.personCache.update({ where: { id: real.id }, data: { linkedinUrl: 'https://www.linkedin.com/in/jonah-adeyemi' } });
    await checkSandboxAgainstCrm({ client: null });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).crmMatchPersonId).toBe(real.id);
  });

  it('N025: opting out one record of a person opts out their other live records', async () => {
    const one = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: 'twice@rivera-wealth.com' });
    const two = await readyContact(b.users.karson.id, b.pods.Alisa.id, { email: 'twice@rivera-wealth.com' });
    const shared = await readyContact(b.users.karson.id, b.pods.Alisa.id, { email: 'info@rivera-wealth.com' });
    await prisma.sandboxContact.update({ where: { id: one.id }, data: { additionalEmails: ['info@rivera-wealth.com'] } });
    await optOutSandboxContact(one.id, { source: 'contact_page', actor: actor() });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: two.id } })).status).toBe('OPTED_OUT');
    // A shared inbox is not a person: its contact stays live.
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: shared.id } })).status).toBe('ACTIVE');
  });

  it('N025: a manual add takes the push lock, so two adds of the same person at once make one contact', async () => {
    const input = { firstName: 'Race', lastName: 'Twin', email: 'race.twin@example.org', companyName: 'Racers' };
    const [x, y] = await Promise.all([createContact(input, by(), actor()), createContact(input, by(), actor())]);
    expect([x.ok, y.ok].sort()).toEqual([false, true]);
    expect(await prisma.sandboxContact.count({ where: { email: 'race.twin@example.org' } })).toBe(1);
  });

  it('B139: the same name at the same firm is refused once, naming the other contact, and can be added anyway', async () => {
    await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Pat', lastName: 'Lee', companyName: 'Rivera Wealth Partners', email: null, phone: null });
    const first = await createContact({ firstName: 'pat', lastName: 'lee', companyName: 'Rivera Wealth Partners' }, by(), actor());
    expect(first).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('Pat Lee at the same firm is already in Cold outreach') }));
    expect((await createContact({ firstName: 'pat', lastName: 'lee', companyName: 'Rivera Wealth Partners' }, by(), actor(), null, { addAnyway: true })).ok).toBe(true);
  });

  it('erase hashes a direct line for anyone and an office line for that person only', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550190', phoneType: 'office', additionalPhones: [{ number: '+13125550191', type: 'mobile' }] });
    const r = await eraseContact(c.id, userActor(b.users.ria), new Date(), toActor({ id: b.users.ria.id, role: 'ADMIN', podIds: [] }));
    expect(r.ok).toBe(true);
    expect(await prisma.suppression.findFirst({ where: { kind: 'phone', valueHash: suppressionHash('phone', '+13125550190') } })).toBeNull();
    expect(await prisma.suppression.findFirst({ where: { kind: 'phone_subject', valueHash: suppressionHash('phone_subject', '+13125550190'), subjectId: c.id } })).not.toBeNull();
    expect(await prisma.suppression.findFirst({ where: { kind: 'phone', valueHash: suppressionHash('phone', '+13125550191') } })).not.toBeNull();
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ status: 'OPTED_OUT', firstName: '', phone: null, piiClearedAt: expect.any(Date) }));
  });

  describe('D4: lifting a form opt-out', () => {
    it('an admin lifts a form opt-out: active again, only its own suppressions go, nothing restarts', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
      await submitCallForm(call.id, { outcome: 'do_not_contact', rating: 2, notes: 'Stop', nextStep: 'none' }, { id: b.users.alisa.id, name: 'Alisa', timezone: 'Europe/London' });
      // An entry an admin put on the list for the same email stays.
      await prisma.suppression.updateMany({ where: { kind: 'linkedin' }, data: { source: 'suppression_list' } });
      const before = await prisma.suppression.count();
      const ria = toActor({ id: b.users.ria.id, role: 'ADMIN', podIds: [] });
      expect(await liftOptOut(coldRef(c.id), { actor: userActor(b.users.ria), guard: ria })).toEqual({ ok: true, changed: true });
      const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
      expect(row).toEqual(expect.objectContaining({ status: 'ACTIVE', optedOutAt: null, optOutLiftedAt: expect.any(Date) }));
      expect(await prisma.suppression.count()).toBeLessThan(before);
      expect(await prisma.suppression.count({ where: { sandboxContactId: c.id, source: 'call_form' } })).toBe(0);
      expect(await prisma.nextAction.count({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { entityId: c.id, action: 'opt_out_lifted', actorId: b.users.ria.id } })).toBe(1);
    });

    it('an opt-out from the contact page is never lifted; Biz Ops lifts only when closing the ticket', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      await optOutSandboxContact(c.id, { source: 'contact_page', actor: actor() });
      const ria = toActor({ id: b.users.ria.id, role: 'ADMIN', podIds: [] });
      expect(await liftOptOut(coldRef(c.id), { actor: userActor(b.users.ria), guard: ria })).toEqual(expect.objectContaining({ ok: false, code: 'not_liftable' }));
      const formOne = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      await optOutSandboxContact(formOne.id, { source: 'call_form', actor: actor() });
      const bea = await prisma.user.create({ data: { email: 'bea@cadence.local', name: 'Bea Ops', role: 'BIZ_OPS', passwordHash: 'x' } });
      const g = toActor({ id: bea.id, role: 'BIZ_OPS', podIds: [] });
      expect((await liftOptOut(coldRef(formOne.id), { actor: userActor(bea), guard: g })).ok).toBe(false);
      expect(await liftOptOut(coldRef(formOne.id), { actor: userActor(bea), guard: g, viaTicket: true })).toEqual({ ok: true, changed: true });
    });

    it('lifting a CRM person\'s form opt-out clears the Do not contact Cadence set in the CRM', async () => {
      await optOutPerson('person-01', { source: 'call_form', actor: actor() });
      expect(getMockTwentyClient().people.find((p) => p.id === 'person-01')?.dnd).toBe(true);
      const ria = toActor({ id: b.users.ria.id, role: 'ADMIN', podIds: [] });
      expect((await liftOptOut(personRef('person-01'), { actor: userActor(b.users.ria), guard: ria })).ok).toBe(true);
      expect(getMockTwentyClient().people.find((p) => p.id === 'person-01')?.dnd).toBe(false);
      expect(await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-01' } })).toEqual(expect.objectContaining({ optedOut: false, dnd: false, optOutLiftedAt: expect.any(Date) }));
    });
  });
});
