import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { logManualCall, submitCallForm } from '@/lib/calls/form';
import { recordCallTouch } from '@/lib/calls/call-log';
import { setColdNextStep } from '@/lib/sandbox/work';
import { setNextActions } from '@/lib/next-actions';
import { activateSandboxCampaign } from '@/lib/sandbox/campaigns';
import { outreachMetrics, replyCount, type Period } from '@/lib/outreach/metrics';
import { audienceOf } from '@/lib/outreach/audience';
import { coldRef, contactState, countWhere, loadSubjects, personRef, refKey, refOf, subjectHref, workWhere } from '@/lib/subject';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * Stage S2: audience stamped on every insert (PLAN 8.4, B037), the subject layer (8.13) and the
 * shared metrics module (8.14) that Home (S6) and Reports (S8) call.
 */
describe('outreach metrics and the subject layer', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });
  const alisa = () => ({ id: b.users.alisa.id, name: 'Alisa', timezone: 'Europe/London' });

  it('B037: every insert stamps its audience once: next actions, calls and their pod, forms, touches, enrollments', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await setColdNextStep(c.id, { label: 'Call', action: 'CALL', dueDate: '2099-01-05', foUserId: b.users.alisa.id }, userActor(b.users.alisa));
    await setNextActions(['person-01'], { label: 'Email', action: 'EMAIL', dueDate: '2099-01-05', repeat: 'NONE', foUserId: b.users.alisa.id }, userActor(b.users.alisa), b.users.alisa.id);
    expect((await prisma.nextAction.findFirstOrThrow({ where: { sandboxContactId: c.id } })).audience).toBe('SANDBOX');
    expect((await prisma.nextAction.findFirstOrThrow({ where: { personId: 'person-01' } })).audience).toBe('CRM');
    const cold = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
    expect(cold).toEqual(expect.objectContaining({ audience: 'SANDBOX', podId: b.pods.Alisa.id }));
    await recordCallTouch(cold);
    expect((await prisma.touch.findFirstOrThrow({ where: { sandboxContactId: c.id } })).audience).toBe('SANDBOX');
    await submitCallForm(cold.id, { outcome: 'no_answer', nextStep: 'none' }, alisa());
    expect((await prisma.callForm.findUniqueOrThrow({ where: { callId: cold.id } })).audience).toBe('SANDBOX');
    const crm = await logManualCall({ userId: b.users.alisa.id, personId: 'person-01' });
    expect(crm).toEqual(expect.objectContaining({ audience: 'CRM', podId: b.pods.Alisa.id }));
    const campaign = await prisma.campaign.create({ data: { name: 'Cold Q1', audience: 'SANDBOX', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [(await readyContact(b.users.alisa.id, b.pods.Alisa.id)).id], startDate: '2026-11-02', status: 'SCHEDULED' } });
    await activateSandboxCampaign(campaign.id, { actor: userActor(b.users.alisa) });
    expect((await prisma.enrollment.findFirstOrThrow({ where: { campaignId: campaign.id } })).audience).toBe('SANDBOX');
    expect(audienceOf({ sandboxContactId: 'x' }, 'MOVED')).toBe('CRM');
    expect(audienceOf({})).toBeNull();
  });

  it('counts each audience by its stamp, and a move never changes a past figure', async () => {
    const period: Period = { from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 3600_000) };
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const coldCall = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id, talkSec: 120 });
    await submitCallForm(coldCall.id, { outcome: 'meeting_booked', rating: 5, notes: 'Booked', nextStep: 'none' }, alisa());
    const crmCall = await logManualCall({ userId: b.users.alisa.id, personId: 'person-01', talkSec: 0 });
    await prisma.callLog.update({ where: { id: crmCall.id }, data: { status: 'NO_ANSWER' } });
    await prisma.touch.create({ data: { sandboxContactId: c.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: new Date(), summary: 'Reply: yes', externalId: 'r1', audience: 'SANDBOX' } });
    await prisma.touch.create({ data: { sandboxContactId: c.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: new Date(), summary: 'Auto-reply: away', externalId: 'r2', audience: 'SANDBOX' } });

    const scope = { kind: 'rep' as const, userId: b.users.alisa.id };
    const cold = await outreachMetrics(scope, 'cold', period);
    expect(cold).toEqual(expect.objectContaining({ dials: 1, connects: 1, meetingsBooked: 1, replies: 1, peopleReached: 1 }));
    expect(await outreachMetrics(scope, 'crm', period)).toEqual(expect.objectContaining({ dials: 1, connects: 0, meetingsBooked: 0, replies: 0 }));
    expect((await outreachMetrics({ kind: 'all' }, 'all', period)).dials).toBe(2);
    expect((await outreachMetrics({ kind: 'pod', podId: b.pods.Alisa.id }, 'all', period)).dials).toBe(2);
    expect((await outreachMetrics({ kind: 'pod', podId: b.pods.Leigh.id }, 'all', period)).dials).toBe(0);
    // The contact moves to the CRM: its rows follow the person, its figures stay cold.
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { status: 'MOVED', twentyPersonId: 'person-05' } });
    await prisma.callLog.updateMany({ where: { sandboxContactId: c.id }, data: { personId: 'person-05' } });
    await prisma.touch.updateMany({ where: { sandboxContactId: c.id }, data: { personId: 'person-05' } });
    expect(await outreachMetrics(scope, 'cold', period)).toEqual(cold);
    expect(await replyCount(scope, 'crm', period)).toBe(0);
  });

  it('a discarded call is out of every count (B024)', async () => {
    const period: Period = { from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 3600_000) };
    const call = await logManualCall({ userId: b.users.alisa.id, personId: 'person-01' });
    await prisma.callLog.update({ where: { id: call.id }, data: { discardedAt: new Date() } });
    expect((await outreachMetrics({ kind: 'all' }, 'all', period)).dials).toBe(0);
  });

  it('the subject layer: refs, links, one state per contact, batched loads, and the two report filters', async () => {
    expect(refOf({ personId: 'p1', sandboxContactId: 'c1' })).toEqual(personRef('p1'));
    expect(refOf({ sandboxContactId: 'c1' })).toEqual(coldRef('c1'));
    expect(subjectHref(personRef('p1'))).toBe('/people/p1');
    expect(subjectHref(coldRef('c1'))).not.toMatch(/^\/people\//);
    expect(contactState({ status: 'ACTIVE', ownerId: null })).toBe('unclaimed');
    expect(contactState({ status: 'ACTIVE', ownerId: 'u', ownerActive: false })).toBe('unclaimed');
    expect(contactState({ status: 'ACTIVE', ownerId: 'u', lastOutcome: 'not_interested' })).toBe('closed');
    expect(contactState({ status: 'ACTIVE', ownerId: 'u', hasNextStep: true, lastOutcome: 'not_interested' })).toBe('next_step_set');
    expect(contactState({ status: 'ACTIVE', ownerId: 'u', crmMatchPersonId: 'p' })).toBe('already_in_crm');
    expect(contactState({ status: 'ACTIVE', ownerId: 'u', moving: true })).toBe('moving');
    expect(contactState({ status: 'REMOVED', ownerId: null, optedOutAt: new Date() })).toBe('do_not_contact');
    expect(contactState({ status: 'ACTIVE', ownerId: 'u', detailsComplete: true, positiveOutcome: true })).toBe('ready_to_move');

    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const gone = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { status: 'OPTED_OUT' });
    const loaded = await loadSubjects([coldRef(c.id), personRef('person-07'), personRef('person-01')]);
    expect(loaded.get(refKey(coldRef(c.id)))).toEqual(expect.objectContaining({ kind: 'sandbox', ownerName: b.users.alisa.name, podName: b.pods.Alisa.name, state: 'no_next_step' }));
    expect(loaded.get(refKey(personRef('person-07')))?.state).toBe('do_not_contact');
    expect(loaded.get(refKey(personRef('person-01')))).toEqual(expect.objectContaining({ href: '/people/person-01', ownerName: b.users.alisa.name, state: null }));
    for (const id of [c.id, gone.id]) await prisma.nextAction.create({ data: { sandboxContactId: id, foUserId: b.users.alisa.id, label: 'Call', action: 'CALL', dueDate: '2099-01-05', audience: 'SANDBOX' } });
    expect((await prisma.nextAction.findMany({ where: workWhere('cold') })).map((n) => n.sandboxContactId)).toEqual([c.id]);
    expect(await prisma.nextAction.count({ where: countWhere('cold') })).toBe(2);
  });
});
