import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { FakeTwilio } from '@/lib/calls/fake-twilio';
import { importTwilioCalls } from '@/lib/calls/import';
import { pendingForms } from '@/lib/calls/form';
import { matchRep } from '@/lib/calls/match';
import { MOCK_PEOPLE } from '@/lib/twenty/fixtures';
import { toE164 } from '@/lib/sandbox/normalize';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

const ALISA_LINE = '+13125550100';
const minutes = (n: number, from: Date) => new Date(from.getTime() + n * 60_000);

/** twilioImport (plan 9.3) against the in-memory Twilio: read only, matched, one row per conversation. */
describe('the Twilio import', () => {
  let b: Basics;
  let fake: FakeTwilio;
  let t0: Date;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    fake = new FakeTwilio();
    await prisma.user.update({ where: { id: b.users.alisa.id }, data: { callerNumber: ALISA_LINE } });
    t0 = new Date('2026-11-03T15:00:00Z');
    // The first run starts the clock: calls before it are logged without asking for a form.
    await importTwilioCalls({ reader: fake, now: t0 });
  });

  it('matches the rep by the caller number assigned to them, the sandbox contact by its number, and opens the form', async () => {
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550199', phoneType: 'direct' });
    const call = fake.addCall({ from: ALISA_LINE, to: '+1 (312) 555-0199', direction: 'outbound-api', startTime: minutes(1, t0).toISOString(), endTime: minutes(3, t0).toISOString(), durationSec: 95 });
    fake.addRecording(call.sid, 92);
    const stats = await importTwilioCalls({ reader: fake, now: minutes(4, t0) });
    expect(stats).toEqual(expect.objectContaining({ ran: true, created: 1, forms: 1, recordings: 1 }));
    const row = await prisma.callLog.findUniqueOrThrow({ where: { twilioCallSid: call.sid } });
    expect(row).toEqual(expect.objectContaining({ userId: b.users.alisa.id, repMatchedBy: 'caller_number', sandboxContactId: contact.id, matchedBy: 'number', status: 'COMPLETED', talkSec: 95, toNumber: '+13125550199', recordingSec: 92 }));
    expect(row.formDueAt).not.toBeNull();
    expect((await pendingForms(b.users.alisa.id)).map((c) => c.id)).toEqual([row.id]);
    expect(await prisma.touch.findUnique({ where: { externalId: `twilio:${call.sid}` } })).toEqual(expect.objectContaining({ sandboxContactId: contact.id, channel: 'CALL' }));
    // A second run reads the same call again (the overlap) and stores nothing twice.
    await importTwilioCalls({ reader: fake, now: minutes(6, t0) });
    expect(await prisma.callLog.count()).toBe(1);
  });

  it('folds the dialpad\'s browser leg into the call, matching the rep by the tw_ handle and the CRM person by number', async () => {
    const person = MOCK_PEOPLE[4];
    const parent = fake.addCall({ from: 'client:tw_karson', to: person.phone!, direction: 'inbound', startTime: minutes(1, t0).toISOString(), endTime: minutes(5, t0).toISOString(), durationSec: 240 });
    const leg = fake.addCall({ from: '+13125550111', to: person.phone!, direction: 'outbound-dial', parentCallSid: parent.sid, startTime: minutes(1, t0).toISOString(), endTime: minutes(5, t0).toISOString(), durationSec: 230 });
    await importTwilioCalls({ reader: fake, now: minutes(6, t0) });
    const rows = await prisma.callLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ twilioCallSid: leg.sid, parentCallSid: parent.sid, repIdentity: 'tw_karson', userId: b.users.karson.id, repMatchedBy: 'alias', personId: person.id, matchedBy: 'number', toNumber: toE164(person.phone) }));
  });

  it('links the call to the task its Call button was pressed for', async () => {
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550188', phoneType: 'mobile' });
    const intent = await prisma.callIntent.create({ data: { userId: b.users.alisa.id, toNumber: '+13125550188', sandboxContactId: contact.id, createdAt: minutes(0, t0) } });
    fake.addCall({ from: ALISA_LINE, to: '+13125550188', startTime: minutes(1, t0).toISOString(), endTime: minutes(2, t0).toISOString(), durationSec: 40 });
    await importTwilioCalls({ reader: fake, now: minutes(3, t0) });
    const row = await prisma.callLog.findFirstOrThrow();
    expect(row).toEqual(expect.objectContaining({ matchedBy: 'dialed', sandboxContactId: contact.id }));
    expect((await prisma.callIntent.findUniqueOrThrow({ where: { id: intent.id } })).callId).toBe(row.id);
  });

  it('leaves a call nobody can be matched to unmatched, without a form', async () => {
    fake.addCall({ from: '+14155550123', to: '+16175550111', startTime: minutes(1, t0).toISOString(), endTime: minutes(2, t0).toISOString() });
    await importTwilioCalls({ reader: fake, now: minutes(3, t0) });
    expect(await prisma.callLog.findFirstOrThrow()).toEqual(expect.objectContaining({ userId: null, repMatchedBy: 'none', matchedBy: 'none', formDueAt: null }));
  });

  it('moves a call\'s status forward only, and opens the form when the call ends', async () => {
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550166', phoneType: 'direct' });
    const call = fake.addCall({ from: ALISA_LINE, to: '+13125550166', status: 'in-progress', startTime: minutes(1, t0).toISOString(), endTime: null, durationSec: null });
    await importTwilioCalls({ reader: fake, now: minutes(2, t0) });
    expect(await prisma.callLog.findFirstOrThrow()).toEqual(expect.objectContaining({ status: 'IN_PROGRESS', formDueAt: null, sandboxContactId: contact.id }));
    fake.updateCall(call.sid, { status: 'completed', endTime: minutes(4, t0).toISOString(), durationSec: 170 });
    await importTwilioCalls({ reader: fake, now: minutes(5, t0) });
    const done = await prisma.callLog.findFirstOrThrow();
    expect(done.status).toBe('COMPLETED');
    expect(done.formDueAt).not.toBeNull();
  });

  it('asks for no form for calls made before the import was switched on', async () => {
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550155', phoneType: 'direct' });
    fake.addCall({ from: ALISA_LINE, to: '+13125550155', startTime: minutes(-5, t0).toISOString(), endTime: minutes(-4, t0).toISOString() });
    await importTwilioCalls({ reader: fake, now: minutes(1, t0) });
    expect(await prisma.callLog.findFirstOrThrow()).toEqual(expect.objectContaining({ sandboxContactId: contact.id, userId: b.users.alisa.id, formDueAt: null }));
  });

  it('matches the rep by number first, then by handle', () => {
    const users = [{ id: 'a', callerNumber: ALISA_LINE, aliases: ['tw_alisa'] }, { id: 'k', callerNumber: null, aliases: ['tw_karson'] }];
    expect(matchRep({ direction: 'OUTBOUND', fromNumber: ALISA_LINE, toNumber: '+1', repIdentity: 'tw_karson' }, users)).toEqual({ userId: 'a', by: 'caller_number' });
    expect(matchRep({ direction: 'INBOUND', fromNumber: '+1', toNumber: ALISA_LINE, repIdentity: null }, users)).toEqual({ userId: 'a', by: 'caller_number' });
    expect(matchRep({ direction: 'OUTBOUND', fromNumber: '+19995550000', toNumber: '+1', repIdentity: 'TW_Karson' }, users)).toEqual({ userId: 'k', by: 'alias' });
  });
});
