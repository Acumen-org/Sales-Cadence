import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { logManualCall, submitCallForm } from '@/lib/calls/form';
import { callFormContext } from '@/lib/calls/form-context';
import { callGate } from '@/lib/calls/gate';
import { listMoves } from '@/lib/sandbox/moves-query';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/** The owner's changes of 10 Nov 2026: no calling hours, the owner from the form, Cold outreach by pod. */
let b: Basics;
beforeEach(async () => { await resetDb(); b = await seedBasics(); });
const as = (u: Basics['users']['alisa'], podIds: string[]) => ({ id: u.id, name: u.name, timezone: 'Europe/London', role: u.role, podIds });

// Calling hours are back (owner, 13 Nov 2026; audit M02): this test's old expectation, open at any hour, was reversed.
describe('calling hours (owner, 13 Nov 2026)', () => {
  it('Call is open from 8am to 9pm of the contact\'s day, and closed outside it', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { state: 'IL' });
    const rep = { id: b.users.alisa.id, timezone: 'Europe/London' };
    expect(await callGate(rep, c, new Date('2026-11-10T18:00:00Z'))).toEqual({ blocked: null, warning: expect.stringContaining('Recording notice') });
    expect((await callGate(rep, c, new Date('2026-11-11T04:00:00Z'))).blocked).toEqual(expect.stringContaining('8am to 9pm'));
  });
});

describe('the post-call form gives the contact to someone in its pod', () => {
  // V01 (audit, 13 Nov 2026): the form's owner change passes the same check as Assign. This test used to
  // let a Junior FO take a colleague's contact; that expectation was the finding, so it was reversed.
  it('V01: a Junior FO who called a colleague\'s contact cannot take it; its owner can give it to them', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2099-01-05', audience: 'SANDBOX' } });
    const call = await logManualCall({ userId: b.users.karson.id, sandboxContactId: c.id });
    const karson = as(b.users.karson, [b.pods.Alisa.id]);
    const date = '2099-01-06';

    // Karson is offered nobody but the owner, and a handover he sends anyway is refused before anything is saved.
    const ctx = await callFormContext(call.id, karson);
    expect(ctx.ok && ctx.context.owner?.choices.map((u) => u.id)).toEqual([b.users.alisa.id]);
    expect(await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: date, newOwnerId: b.users.karson.id }, karson)).toEqual(expect.objectContaining({ ok: false, field: 'newOwnerId' }));
    expect(await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: date, newOwnerId: b.users.daniel.id }, karson)).toEqual(expect.objectContaining({ ok: false, field: 'newOwnerId' }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).ownerId).toBe(b.users.alisa.id);

    // Alisa, the owner, gives it to Karson from her own call's form: he owns it with the next step.
    const own = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
    const alisa = as(b.users.alisa, [b.pods.Alisa.id]);
    const ctx2 = await callFormContext(own.id, alisa);
    expect(ctx2.ok && ctx2.context.owner?.choices.map((u) => u.id)).toEqual(expect.arrayContaining([b.users.karson.id, b.users.alisa.id]));
    const r = await submitCallForm(own.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: date, newOwnerId: b.users.karson.id }, alisa);
    expect(r).toEqual(expect.objectContaining({ ok: true, reminder: expect.stringContaining("'s now") }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).ownerId).toBe(b.users.karson.id);
    expect(await prisma.nextAction.findMany({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toEqual([expect.objectContaining({ dueDate: date })]);
  });

  it('without a new owner, a colleague\'s next step still goes to the owner as a suggestion', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2099-01-05', audience: 'SANDBOX' } });
    const call = await logManualCall({ userId: b.users.karson.id, sandboxContactId: c.id });
    const r = await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: '2099-01-06' }, as(b.users.karson, [b.pods.Alisa.id]));
    expect(r.ok).toBe(true);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).ownerId).toBe(b.users.alisa.id);
    expect(await prisma.notification.count({ where: { kind: 'next_step_suggestion', userId: b.users.alisa.id } })).toBe(1);
  });
});

describe('Moves to CRM by pod', () => {
  it('lists the moves of a pod\'s contacts only', async () => {
    const mine = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const theirs = await readyContact(b.users.leigh.id, b.pods.Leigh.id);
    const move = (contactId: string, by: string) => prisma.sandboxMove.create({ data: { createdById: by, count: 1, state: 'DONE', items: { create: [{ sandboxContactId: contactId, state: 'DONE', mode: 'create', snapshot: {} }] } } });
    const a = await move(mine.id, b.users.alisa.id);
    const l = await move(theirs.id, b.users.leigh.id);
    expect((await listMoves({ podId: b.pods.Alisa.id })).map((m) => m.id)).toEqual([a.id]);
    expect((await listMoves({})).map((m) => m.id).sort()).toEqual([a.id, l.id].sort());
  });
});
