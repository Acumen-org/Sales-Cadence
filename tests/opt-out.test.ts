import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { logManualCall, submitCallForm } from '@/lib/calls/form';
import { optOutSandboxContact, suppressValue } from '@/lib/sandbox/opt-out';
import { statusByIds, statusChangedSince } from '@/lib/sandbox/status';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { bwContact, disableBellwether, enableBellwether, envelope, push } from './helpers/sandbox';

/** Decision 23: a contact opted out in Cadence shows as opted out in Bellwether, whichever way it was opted out. */
describe('opt-out reaches Bellwether as opted_out', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    enableBellwether();
  });
  afterAll(() => disableBellwether());

  async function pushed() {
    const c = bwContact({ phone: '+1 312 555 0177', phoneType: 'direct' });
    const r = await push(envelope([c]));
    return { bwId: c.bellwetherContactId as string, email: c.email as string, id: r.body.results[0].cadenceContactId as string };
  }

  it('the call form\'s "Asked not to be contacted" sets opted_out with statusChangedAt, by id and through changedSince', async () => {
    const { bwId, id } = await pushed();
    const before = new Date(Date.now() - 1000);
    const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: id });
    const r = await submitCallForm(call.id, { outcome: 'do_not_contact', rating: 2, notes: 'Asked us to stop', nextStep: 'none' }, { id: b.users.alisa.id, name: b.users.alisa.name, timezone: 'Europe/London' });
    expect(r.ok).toBe(true);
    const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('OPTED_OUT');
    expect(row.statusChangedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    const [byId] = await statusByIds([bwId]);
    expect(byId).toEqual(expect.objectContaining({ status: 'opted_out', statusChangedAt: expect.any(String) }));
    const since = await statusChangedSince(before, null, 500);
    expect(since.results.find((x) => x.bellwetherContactId === bwId)?.status).toBe('opted_out');
    // A later push of the same person is refused.
    const again = await push(envelope([bwContact({ email: row.email })]));
    expect(again.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'suppressed' }));
  });

  it('the contact page\'s Opt out sets opted_out and ends the contact\'s sequences', async () => {
    const { bwId, id } = await pushed();
    const enrollment = await prisma.enrollment.create({ data: { sandboxContactId: id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-03', status: 'ACTIVE' } });
    await optOutSandboxContact(id, { source: 'contact_page', actor: userActor(b.users.alisa) });
    expect((await statusByIds([bwId]))[0].status).toBe('opted_out');
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).toEqual(expect.objectContaining({ status: 'EXITED', exitReason: 'opted_out' }));
  });

  it('an entry on the suppression list opts out the sandbox contact it matches', async () => {
    const { bwId, email } = await pushed();
    const r = await suppressValue({ kind: 'email', value: email }, { actor: userActor(b.users.ria) });
    expect(r).toEqual({ added: true, optedOut: 1 });
    expect((await statusByIds([bwId]))[0].status).toBe('opted_out');
  });

  it('a contact moved to the CRM and then opted out reads opted_out too', async () => {
    const { bwId, id } = await pushed();
    await prisma.sandboxContact.update({ where: { id }, data: { status: 'MOVED', twentyPersonId: 'person-03', movedAt: new Date() } });
    await optOutSandboxContact(id, { source: 'call_form', actor: userActor(b.users.alisa) });
    expect((await statusByIds([bwId]))[0].status).toBe('opted_out');
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-03' } })).optedOut).toBe(true);
  });
});
