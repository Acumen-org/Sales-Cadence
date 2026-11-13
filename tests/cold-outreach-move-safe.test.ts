import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { TwentyApiError } from '@/lib/twenty/graphql-client';
import { AUTO_RETRIES, autoRetryDelayMs, failureWords, queueMove, requeueTransientFailures, runMoveQueue } from '@/lib/sandbox/move';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * 13 Nov 2026: a move to the CRM failed (Andrew Parey) and the owner asked that a move never fail.
 * Every CRM error read "The CRM did not answer" (the error's class name matched), a value the CRM
 * would not take failed the move on every retry, a person the CRM gained after the dialog failed it
 * permanently, and nothing tried again until someone pressed Retry.
 */
const actorOf = async (id: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { pods: true } });
  return { actor: toActor({ id: u.id, role: u.role, podIds: u.pods.map((p) => p.podId) }), audit: userActor(u) };
};
const mock = () => getMockTwentyClient();
const refused = (message: string) => new TwentyApiError(`CRM GraphQL error: ${message}`, 200, [{ message }]);
let b: Basics;

async function queue(contactId: string) {
  const { actor, audit } = await actorOf(b.users.alisa.id);
  const q = await queueMove([{ contactId, mode: 'create', noConversation: true }], actor, audit, { label: 'Intro call', action: 'CALL', dueDate: '2099-11-20' });
  if (!q.ok) throw new Error(q.error);
  return q.moveId;
}
const itemOf = (moveId: string) => prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId } });

describe('Move to CRM never fails on what the CRM will not take', () => {
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('says what the CRM said: a refusal is not "did not answer", and an outage is', () => {
    expect(failureWords(refused('Invalid phone number')).text).toBe('The CRM refused it: Invalid phone number. Cadence tries again by itself; tell an admin if it stays.');
    expect(failureWords(new TwentyApiError('The CRM\'s graphql responded 503: busy', 503))).toEqual({ text: 'The CRM did not answer. Cadence tries again by itself in a few minutes.', failure: 'transient' });
    expect(failureWords(new TwentyApiError('The CRM\'s graphql responded 401: no', 401)).text).toMatch(/refused Cadence's key/);
  });

  it('a value the CRM refuses is left out and kept in the notes; the person is made and the move is done', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { firstName: 'Andrew', lastName: 'Parey' });
    const moveId = await queue(c.id);
    const create = vi.spyOn(mock(), 'createPerson');
    create.mockRejectedValueOnce(refused('Invalid phone number'));
    await runMoveQueue();
    const item = await itemOf(moveId);
    expect(item).toEqual(expect.objectContaining({ state: 'DONE', error: null }));
    expect(create).toHaveBeenCalledTimes(2);
    const second = create.mock.calls[1][0];
    expect(second.phone).toBeNull();
    expect(second.leadSourceNotes).toContain(`Kept here, as the CRM did not take them: Phone ${c.phone}`);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('MOVED');
    expect(await prisma.auditLog.findFirst({ where: { entityId: c.id, action: 'move_fields_kept_in_notes' } })).not.toBeNull();
    create.mockRestore();
  });

  it('an email held by another CRM record (in its trash) goes on as an other email', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const moveId = await queue(c.id);
    const create = vi.spyOn(mock(), 'createPerson');
    create.mockRejectedValueOnce(refused('A duplicate entry was detected'));
    await runMoveQueue();
    expect((await itemOf(moveId)).state).toBe('DONE');
    expect(create.mock.calls[1][0]).toEqual(expect.objectContaining({ email: null, additionalEmails: [c.email] }));
    create.mockRestore();
  });

  it('a person the CRM gained after the dialog gets the history: an attach, never a second person and never a failure', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const moveId = await queue(c.id);
    // Someone adds them in the CRM while the move waits.
    const theirs = await mock().createPerson({ firstName: c.firstName, lastName: c.lastName, email: c.email, additionalEmails: [], phone: null, additionalPhone: null, linkedinUrl: null, jobTitle: null, city: null, companyId: null, assignedToMemberId: null, podOwner: null, leadSource: [], leadSourceNotes: null, productInterest: [], tags: [], contactType: [], listCategory: null, pipelineStage: null, cadenceSandboxId: null });
    const p = mock().people.find((x) => x.id === theirs.id)!;
    p.createdBySource = 'MANUAL';
    const before = mock().writes.filter((w) => w.op === 'createPerson').length;
    await runMoveQueue();
    const item = await itemOf(moveId);
    expect(item).toEqual(expect.objectContaining({ state: 'DONE', mode: 'attach', twentyPersonId: theirs.id }));
    expect(mock().writes.filter((w) => w.op === 'createPerson').length).toBe(before);
  });

  it('a firm the CRM refuses is made with its name alone, and with no firm at all if even that is refused', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { companyName: `Nowhere Capital ${Date.now()}`, companyDomain: `nowhere-${Date.now()}.com` });
    const moveId = await queue(c.id);
    const firm = vi.spyOn(mock(), 'createCompany');
    firm.mockRejectedValueOnce(refused('A duplicate entry was detected'));
    await runMoveQueue();
    expect((await itemOf(moveId)).state).toBe('DONE');
    expect(firm.mock.calls[1][0]).toEqual(expect.objectContaining({ name: c.companyName, domain: null }));
    firm.mockRestore();

    const d = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { companyName: `Elsewhere Capital ${Date.now()}`, companyDomain: `elsewhere-${Date.now()}.com` });
    const second = await queue(d.id);
    const firm2 = vi.spyOn(mock(), 'createCompany').mockRejectedValue(refused('Invalid value'));
    const create = vi.spyOn(mock(), 'createPerson');
    await runMoveQueue();
    expect(await itemOf(second)).toEqual(expect.objectContaining({ state: 'DONE', companyAction: 'none', twentyCompanyId: null }));
    expect(create.mock.calls[0][0].leadSourceNotes).toContain(`Firm: ${d.companyName}`);
    firm2.mockRestore();
    create.mockRestore();
  });

  it('a CRM outage is tried again by the worker, after a wait, until it works; then it is done', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const moveId = await queue(c.id);
    mock().failNext = new TwentyApiError('The CRM is unreachable at http://crm/graphql: ECONNRESET');
    await runMoveQueue({ autoRetry: true });
    let item = await itemOf(moveId);
    expect(item).toEqual(expect.objectContaining({ state: 'FAILED', failure: 'transient', attempts: 1 }));
    // Not before its wait.
    expect(await requeueTransientFailures(new Date())).toBe(0);
    const later = new Date(Date.now() + autoRetryDelayMs(1) + 1000);
    await runMoveQueue({ autoRetry: true, now: later });
    item = await itemOf(moveId);
    expect(item.state).toBe('DONE');
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('MOVED');
  });

  it('stops trying by itself after a few tries, and never retries a permanent failure', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const moveId = await queue(c.id);
    await prisma.sandboxMoveItem.updateMany({ where: { moveId }, data: { state: 'FAILED', failure: 'transient', attempts: AUTO_RETRIES, claimedAt: new Date(0) } });
    expect(await requeueTransientFailures()).toBe(0);
    await prisma.sandboxMoveItem.updateMany({ where: { moveId }, data: { failure: 'permanent', attempts: 1 } });
    expect(await requeueTransientFailures()).toBe(0);
  });
});
