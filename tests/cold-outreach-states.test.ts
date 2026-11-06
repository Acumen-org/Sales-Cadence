import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import { eraseContact, removeContact } from '@/lib/sandbox/contacts';
import { optOutSandboxContact } from '@/lib/sandbox/opt-out';
import { statusByIds, statusOfContact } from '@/lib/sandbox/status';
import { setColdNextStep } from '@/lib/sandbox/work';
import { suppressionHash } from '@/lib/sandbox/suppression';
import { logManualCall, submitCallForm } from '@/lib/calls/form';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { bwContact, disableBellwether, enableBellwether, envelope, push, readyContact } from './helpers/sandbox';

/** Stage S2: one state machine for a cold contact (PLAN 8.5), and one scrub for Remove and Erase. */
describe('cold contact states', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    enableBellwether();
  });
  afterAll(() => disableBellwether());
  const actor = () => userActor(b.users.alisa);

  it('B054: Remove clears the contact\'s data everywhere: calls, call intents, form notes, email subjects, next-step labels, touches and audit details', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { additionalPhones: [{ number: '+13125550299', type: 'office' }] });
    await setColdNextStep(c.id, { label: 'Ask Sam about the Harbor deal', action: 'CALL', dueDate: '2099-01-05', foUserId: b.users.alisa.id }, actor());
    const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
    await prisma.callLog.update({ where: { id: call.id }, data: { toNumber: c.phone } });
    // A reached call keeps a dated next step (PLAN 4.6): here the one already set.
    await submitCallForm(call.id, { outcome: 'connected', rating: 4, notes: 'Sam said his wife is ill', nextStep: 'keep' }, { id: b.users.alisa.id, name: 'Alisa', timezone: 'Europe/London' });
    const unmatched = await prisma.callLog.create({ data: { source: 'TWILIO_IMPORT', direction: 'OUTBOUND', toNumber: '+13125550299', matchedBy: 'ambiguous', candidates: [{ kind: 'sandbox', id: c.id, name: 'Sam Rivera' }, { kind: 'person', id: 'person-01', name: 'Nina' }] } });
    await prisma.callIntent.create({ data: { userId: b.users.alisa.id, toNumber: c.phone!, sandboxContactId: c.id } });
    await prisma.sandboxEmail.create({ data: { sandboxContactId: c.id, kind: 'SENT', internetMessageId: 'm1', subject: 'Sam, about your divorce settlement', at: new Date() } });
    await prisma.touch.create({ data: { sandboxContactId: c.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: new Date(), summary: 'Reply: my new number is 555', externalId: 'reply-1', audience: 'SANDBOX' } });

    expect((await removeContact(c.id, actor(), new Date(), { guard: toActor({ id: b.users.alisa.id, role: 'SENIOR_FO', podIds: [b.pods.Alisa.id] }), reason: 'Retired' })).ok).toBe(true);

    expect(await prisma.callLog.findUniqueOrThrow({ where: { id: call.id } })).toEqual(expect.objectContaining({ toNumber: null }));
    expect((await prisma.callLog.findUniqueOrThrow({ where: { id: unmatched.id } }))).toEqual(expect.objectContaining({ toNumber: null, candidates: [{ kind: 'person', id: 'person-01', name: 'Nina' }] }));
    expect(await prisma.callIntent.findMany({ where: { sandboxContactId: c.id }, select: { toNumber: true } })).toEqual([{ toNumber: '' }]);
    expect((await prisma.callForm.findUniqueOrThrow({ where: { callId: call.id } })).notes).toBeNull();
    expect((await prisma.sandboxEmail.findFirstOrThrow({ where: { sandboxContactId: c.id } })).subject).toBeNull();
    expect((await prisma.nextAction.findFirstOrThrow({ where: { sandboxContactId: c.id } })).label).toBe('Call');
    expect((await prisma.touch.findUniqueOrThrow({ where: { externalId: 'reply-1' } })).summary).toBe('Reply');
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'sandbox_contact', entityId: c.id } });
    expect(audits.some((a) => JSON.stringify(a.details ?? {}).includes('Harbor'))).toBe(false);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ status: 'REMOVED', firstName: '', email: null, removedReason: 'Retired', removedById: b.users.alisa.id }));
  });

  it('N027: a removed contact can still be opted out, from the keys it kept; Bellwether then reads opted_out and the person is refused', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await removeContact(c.id, actor());
    const removed = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
    expect(removed.email).toBeNull();
    expect(JSON.stringify(removed.keptKeys)).toContain(suppressionHash('email', c.email!));
    expect(JSON.stringify(removed.keptKeys)).not.toContain(c.email!);
    expect(await prisma.suppression.count()).toBe(0);
    // Any sales user may opt out a tombstone (no claim needed).
    expect((await optOutSandboxContact(c.id, { source: 'contact_page', actor: userActor(b.users.leigh), guard: toActor({ id: b.users.leigh.id, role: 'SENIOR_FO', podIds: [b.pods.Leigh.id] }) })).changed).toBe(true);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('OPTED_OUT');
    expect((await statusByIds([c.bellwetherContactId!]))[0].status).toBe('opted_out');
    const again = await push(envelope([bwContact({ email: c.email })]));
    expect(again.body.results[0]).toEqual(expect.objectContaining({ result: 'rejected', reason: 'suppressed' }));
  });

  it('N027: an admin can erase a removed contact; Bellwether reads opted_out', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await removeContact(c.id, actor());
    const r = await eraseContact(c.id, userActor(b.users.ria), new Date(), toActor({ id: b.users.ria.id, role: 'ADMIN', podIds: [] }));
    expect(r.ok).toBe(true);
    expect((await statusByIds([c.bellwetherContactId!]))[0].status).toBe('opted_out');
    expect(await prisma.suppression.count({ where: { sandboxContactId: c.id, reason: 'erased' } })).toBeGreaterThan(0);
  });

  it('only an admin erases', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    expect(await eraseContact(c.id, actor(), new Date(), toActor({ id: b.users.alisa.id, role: 'SENIOR_FO', podIds: [b.pods.Alisa.id] }))).toEqual({ ok: false, error: 'Only admins can erase a contact.' });
  });

  it('N026: a contact with an opt-out on it reads opted_out whatever else happened to it', () => {
    expect(statusOfContact({ status: 'REMOVED', optedOutAt: new Date(), crmMatchPersonId: null })).toBe('opted_out');
    expect(statusOfContact({ status: 'MOVED', optedOutAt: null, crmMatchPersonId: null })).toBe('moved_to_crm');
    expect(statusOfContact({ status: 'ACTIVE', optedOutAt: null, crmMatchPersonId: 'p' })).toBe('already_in_crm');
  });

  it('each transition ends running enrollments with a labelled reason, cancels the next step and drops the contact from campaigns not started', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const e = await prisma.enrollment.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2099-01-01', status: 'ACTIVE', audience: 'SANDBOX' } });
    const planned = await prisma.campaign.create({ data: { name: 'Q1 cold', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [c.id, 'someone-else'], startDate: '2099-02-01', status: 'SCHEDULED' } });
    await setColdNextStep(c.id, { label: 'Call', action: 'CALL', dueDate: '2099-01-05', foUserId: b.users.alisa.id }, actor());
    await removeContact(c.id, actor());
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: e.id } })).toEqual(expect.objectContaining({ status: 'EXITED', exitReason: 'removed' }));
    expect(await prisma.nextAction.count({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toBe(0);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: planned.id } })).personIds).toEqual(['someone-else']);
    expect(await prisma.auditLog.count({ where: { entityId: c.id, action: 'removed' } })).toBe(1);
  });
});
