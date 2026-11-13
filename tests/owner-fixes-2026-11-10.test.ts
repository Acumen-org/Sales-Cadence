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
  it('a colleague who called Alisa\'s contact gives it to themselves: they own it with the next step', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: '2099-01-05', audience: 'SANDBOX' } });
    const call = await logManualCall({ userId: b.users.karson.id, sandboxContactId: c.id });
    const karson = as(b.users.karson, [b.pods.Alisa.id]);

    // The form offers the pod's reps, the owner marked.
    const ctx = await callFormContext(call.id, karson);
    expect(ctx.ok && ctx.context.owner).toEqual(expect.objectContaining({ currentId: b.users.alisa.id, choices: expect.arrayContaining([expect.objectContaining({ id: b.users.karson.id }), expect.objectContaining({ id: b.users.alisa.id })]) }));
    // Someone from another pod is refused.
    const date = '2099-01-06';
    expect(await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: date, newOwnerId: b.users.daniel.id }, karson)).toEqual(expect.objectContaining({ ok: false, field: 'newOwnerId' }));

    const r = await submitCallForm(call.id, { outcome: 'no_answer', nextStep: 'call_again', nextStepDate: date, newOwnerId: b.users.karson.id }, karson);
    expect(r).toEqual(expect.objectContaining({ ok: true, reminder: expect.stringContaining('yours now') }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).ownerId).toBe(b.users.karson.id);
    // The form's next step replaced Alisa's, and it is Karson's: no suggestion went to Alisa.
    expect(await prisma.nextAction.findMany({ where: { sandboxContactId: c.id, state: 'OPEN' } })).toEqual([expect.objectContaining({ foUserId: b.users.karson.id, dueDate: date })]);
    expect(await prisma.notification.count({ where: { kind: 'next_step_suggestion' } })).toBe(0);
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
