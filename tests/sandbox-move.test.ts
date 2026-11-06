import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { preflightMove, processMoveItem, queueMove, runMoveQueue, undoMoveItem } from '@/lib/sandbox/move';
import { statusByIds } from '@/lib/sandbox/status';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

const actorOf = async (id: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { pods: true } });
  return { actor: toActor({ id: u.id, role: u.role, podIds: u.pods.map((p) => p.podId) }), audit: userActor(u) };
};

describe('Move to CRM (plan section 8)', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });
  afterEach(() => { delete process.env.CADENCE_DRY_RUN; process.env.CADENCE_DRY_RUN = 'false'; resetEnvCache(); });

  it('refuses more than 50 contacts in one move, and queues 50', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const contacts = [];
    for (let i = 0; i < 51; i++) contacts.push(await readyContact(b.users.alisa.id, b.pods.Alisa.id));
    const over = await preflightMove(contacts.map((c) => c.id), actor);
    expect(over.refused).toBe('You selected 51 contacts. Move at most 50 at a time.');
    expect(await queueMove(contacts.map((c) => ({ contactId: c.id, mode: 'create' as const, noConversation: true })), actor, audit)).toEqual({ ok: false, error: 'You selected 51 contacts. Move at most 50 at a time.' });
    const ok = await queueMove(contacts.slice(0, 50).map((c) => ({ contactId: c.id, mode: 'create' as const, noConversation: true })), actor, audit);
    expect(ok).toEqual(expect.objectContaining({ ok: true, queued: 50 }));
  }, 120_000);

  it('creates the firm and the person with the usual CRM values, writes the history as notes and hands over the rows', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { designations: ['CFP'], sourceNote: 'SEC IAPD' });
    await prisma.sandboxNote.create({ data: { sandboxContactId: contact.id, body: 'Prefers mornings', authorName: 'Alisa' } });
    const touch = await prisma.touch.create({ data: { sandboxContactId: contact.id, channel: 'EMAIL', direction: 'OUTBOUND', occurredAt: new Date(), summary: 'Email sent: Hello', externalId: `graph:test:${contact.id}` } });
    const pre = await preflightMove([contact.id], actor);
    expect(pre.items[0]).toEqual(expect.objectContaining({ group: 'no_conversation', firm: { action: 'create', name: 'Rivera Wealth Partners' } }));
    const q = await queueMove([{ contactId: contact.id, mode: 'create', noConversation: true }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    expect(await runMoveQueue()).toEqual({ done: 1, failed: 0, dryRun: 0 });
    const mock = getMockTwentyClient();
    const createdPerson = mock.writes.find((w) => w.op === 'createPerson');
    expect(createdPerson && 'input' in createdPerson ? createdPerson.input : null).toEqual(expect.objectContaining({
      firstName: 'Sam', email: contact.email, phone: contact.phone, assignedToMemberId: 'wm-alisa', podOwner: 'ALISA', leadSource: ['BELLWETHER'],
      contactType: ['PROSPECT'], listCategory: 'COLD_BD', pipelineStage: 'PROSPECT', city: 'Chicago, Illinois', productInterest: ['PHH'], cadenceSandboxId: contact.id,
    }));
    expect(mock.writes.filter((w) => w.op === 'createCompany')).toHaveLength(1);
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    expect(item).toEqual(expect.objectContaining({ state: 'DONE', companyAction: 'created' }));
    const notes = mock.notes.filter((n) => n.personIds.includes(item.twentyPersonId!));
    expect(notes.map((n) => n.title)).toEqual(expect.arrayContaining([expect.stringMatching(/^\[Cadence\] Note .* by Alisa$/), '[Cadence] Cold outreach history']));
    expect(await prisma.personCache.findUnique({ where: { id: item.twentyPersonId! } })).not.toBeNull();
    expect((await prisma.touch.findUniqueOrThrow({ where: { id: touch.id } })).personId).toBe(item.twentyPersonId);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id } })).toEqual(expect.objectContaining({ status: 'MOVED', twentyPersonId: item.twentyPersonId }));
    expect((await statusByIds([contact.bellwetherContactId!]))[0]).toEqual(expect.objectContaining({ status: 'moved_to_crm', crmPersonId: item.twentyPersonId }));
  });

  it('links the firm Twenty already has by domain', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const company = await prisma.companyCache.findFirstOrThrow({ where: { domain: { not: null } } });
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { companyName: company.name, companyDomain: company.domain, companyWebsite: null });
    const q = await queueMove([{ contactId: contact.id, mode: 'create', noConversation: true }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    await runMoveQueue();
    expect(await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } })).toEqual(expect.objectContaining({ state: 'DONE', companyAction: 'linked', twentyCompanyId: company.id }));
  });

  it('leaves out a contact that is not ready, with what it needs', async () => {
    const { actor } = await actorOf(b.users.alisa.id);
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: null, phone: null, companyName: null });
    const pre = await preflightMove([contact.id], actor);
    expect(pre.items[0].group).toBe('needs');
    expect(pre.items[0].missing.map((m) => m.key)).toEqual(['companyName', 'email']);
  });

  it('writes nothing in dry run and keeps the contact in the sandbox', async () => {
    process.env.CADENCE_DRY_RUN = 'true';
    resetEnvCache();
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const q = await queueMove([{ contactId: contact.id, mode: 'create', noConversation: true }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    await runMoveQueue();
    expect((await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } })).state).toBe('DRY_RUN');
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id } })).status).toBe('ACTIVE');
    expect(getMockTwentyClient().writes.filter((w) => w.op === 'createPerson')).toHaveLength(0);
  });

  it('undoes a move within the year, and refuses after it', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const q = await queueMove([{ contactId: contact.id, mode: 'create', noConversation: true }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    await runMoveQueue();
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    const elevenMonths = new Date(item.doneAt!.getTime() + 330 * 86_400_000);
    const undone = await undoMoveItem(item.id, actor, audit, elevenMonths);
    expect(undone.ok).toBe(true);
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id } })).toEqual(expect.objectContaining({ status: 'ACTIVE', twentyPersonId: null }));
    expect(getMockTwentyClient().people.find((p) => p.id === item.twentyPersonId)?.deletedAt).toBeTruthy();
    expect(getMockTwentyClient().notes.filter((n) => n.personIds.includes(item.twentyPersonId!))).toHaveLength(0);
    expect((await statusByIds([contact.bellwetherContactId!]))[0].status).toBe('in_sandbox');

    const again = await queueMove([{ contactId: contact.id, mode: 'create', noConversation: true }], actor, audit);
    if (!again.ok) throw new Error(again.error);
    await runMoveQueue();
    const second = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: again.moveId } });
    const afterAYear = new Date(second.doneAt!.getTime() + 366 * 86_400_000);
    const refused = await undoMoveItem(second.id, actor, audit, afterAYear);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toMatch(/can no longer be undone: its undo window closed on/);
  });

  it('keeps the move when someone changed the person in Twenty', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const q = await queueMove([{ contactId: contact.id, mode: 'create', noConversation: true }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    await runMoveQueue();
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    getMockTwentyClient().updatePerson(item.twentyPersonId!, { jobTitle: 'Changed in Twenty', updatedAt: new Date(Date.now() + 60_000).toISOString() });
    const r = await undoMoveItem(item.id, actor, audit);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Someone changed .* in the CRM/);
  });

  it('attaches the history to a person already in Twenty instead of creating one', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const existing = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null } } });
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: existing.email });
    const pre = await preflightMove([contact.id], actor);
    expect(pre.items[0]).toEqual(expect.objectContaining({ group: 'in_crm', crmPerson: expect.objectContaining({ id: existing.id }) }));
    const q = await queueMove([{ contactId: contact.id, mode: 'attach' }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    await processMoveItem((await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } })).id);
    expect(getMockTwentyClient().writes.filter((w) => w.op === 'createPerson')).toHaveLength(0);
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id } })).twentyPersonId).toBe(existing.id);
  });
});
