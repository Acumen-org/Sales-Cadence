import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import { getMockTwentyClient, MockTwentyClient } from '@/lib/twenty/mock-client';
import { sharedMock } from '@/lib/twenty/mock-store';
import { markPersonDeleted } from '@/lib/person-cache';
import { preflightMove, processMoveItem, queueMove, runMoveQueue } from '@/lib/sandbox/move';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * "The CRM person to attach to no longer exists": the dialog offered a person from Cadence's copy
 * of Twenty without asking Twenty, the queue took the dialog's choice on trust, the web request and
 * the worker could both work one item, and each process had its own fake Twenty.
 */

const actorOf = async (id: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { pods: true } });
  return { actor: toActor({ id: u.id, role: u.role, podIds: u.pods.map((p) => p.podId) }), audit: userActor(u) };
};

/** Twenty loses the person (trashed, merged, or removed by the sandbox cleanup); Cadence's copy may not know yet. */
const goneFromTwenty = (id: string) => { const p = getMockTwentyClient().people.find((x) => x.id === id)!; p.deletedAt = new Date().toISOString(); };

describe('Move to CRM: attach to a person already in Twenty', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('does not offer a person Twenty no longer has, and moves the contact as a new person', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const stale = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null } });
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: stale.email });
    goneFromTwenty(stale.id);

    const pre = await preflightMove([contact.id], actor);
    expect(pre.items[0].state).toBe('ready');
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: stale.id } })).deletedAt).not.toBeNull();

    // The dialog that was opened before Twenty lost the person still asks to attach.
    const q = await queueMove([{ contactId: contact.id, mode: 'attach', attachPersonId: stale.id }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    expect(await runMoveQueue()).toEqual({ done: 1, failed: 0, dryRun: 0 });
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    expect(item).toEqual(expect.objectContaining({ state: 'DONE', mode: 'create', error: null }));
    expect(item.twentyPersonId).not.toBe(stale.id);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id } })).twentyPersonId).toBe(item.twentyPersonId);
  });

  it('a person removed after the dialog checked: the queue follows its own check, not the dialog', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const person = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null } });
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: person.email });
    const pre = await preflightMove([contact.id], actor);
    expect(pre.items[0]).toEqual(expect.objectContaining({ state: 'attach', crmPerson: expect.objectContaining({ id: person.id }) }));

    // The sandbox CRM cleanup removes the person, in Twenty and in the copy.
    goneFromTwenty(person.id);
    await markPersonDeleted(person.id);

    const q = await queueMove([{ contactId: contact.id, mode: 'attach', attachPersonId: person.id }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    expect(item).toEqual(expect.objectContaining({ mode: 'create', attachPersonId: null }));
    expect(await processMoveItem(item.id)).toBe('DONE');
  });

  it('a person removed after the move was queued: the worker moves the contact as a new person', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const person = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null } });
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: person.email });
    const q = await queueMove([{ contactId: contact.id, mode: 'attach' }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    goneFromTwenty(person.id);

    expect(await runMoveQueue()).toEqual({ done: 1, failed: 0, dryRun: 0 });
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    expect(item).toEqual(expect.objectContaining({ state: 'DONE', mode: 'create' }));
    expect(getMockTwentyClient().writes.filter((w) => w.op === 'createPerson')).toHaveLength(1);
  });

  it('says what the contact needs when the person is gone and the contact is not ready to be created', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const person = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null } });
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: person.email, companyName: null, companyDomain: null, companyWebsite: null });
    const q = await queueMove([{ contactId: contact.id, mode: 'attach' }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    goneFromTwenty(person.id);

    expect(await runMoveQueue()).toEqual({ done: 0, failed: 1, dryRun: 0 });
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    expect(item.error).toMatch(/^The CRM person to attach to is no longer in Twenty, and Cadence cannot create them until the contact has /);
  });

  it('the web request and the worker never work the same item', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const q = await queueMove([{ contactId: contact.id, mode: 'create' }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });

    const states = await Promise.all([processMoveItem(item.id), processMoveItem(item.id)]);
    expect(states.sort()).toEqual(['DONE', 'RUNNING']);
    expect(getMockTwentyClient().writes.filter((w) => w.op === 'createPerson')).toHaveLength(1);
    expect(await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(expect.objectContaining({ state: 'DONE', attempts: 1 }));
  });

  it('the built-in fake Twenty is one workspace for the web server and the worker', async () => {
    const key = 'mockTwenty.test-shared';
    const web = sharedMock(new MockTwentyClient(), key);
    const worker = sharedMock(new MockTwentyClient(), key);
    const created = await web.createPerson({ firstName: 'Owen', lastName: 'Quiet', email: 'owen@quiet-lake.com', additionalEmails: [], phone: null, additionalPhone: null, linkedinUrl: null, jobTitle: null, city: null, companyId: null, assignedToMemberId: null, podOwner: null, leadSource: [], leadSourceNotes: null, productInterest: [], tags: [], contactType: [], listCategory: null, pipelineStage: null, cadenceSandboxId: null });
    expect((await worker.getPerson(created.id))?.email).toBe('owen@quiet-lake.com');
    await worker.deletePerson(created.id);
    expect((await web.getPerson(created.id))?.deletedAt).not.toBeNull();
  });
});
