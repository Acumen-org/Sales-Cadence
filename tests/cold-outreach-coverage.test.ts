import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/current-user';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { callGate } from '@/lib/calls/gate';
import { FORM_FIRST } from '@/lib/calls/words';
import { contactability } from '@/lib/outreach/contactability';
import { transferContact } from '@/lib/outreach/ownership';
import { queueMove, runMoveQueue, undoMoveItem } from '@/lib/sandbox/move';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const { addSuppressionAction } = await import('@/lib/actions/sandbox');

/**
 * B191 (W13): the risky cold outreach paths the audit found untested. Most now have a test named
 * after the bug that fixed them (erase B054, retention B214/N032/N075, assign races N076, edit flags
 * B139/N024, search B055/B206/N079, opt-out cancelling next steps B007, attach undo B097, a CRM
 * failure mid-move B036/B105, pod-less contacts B050). These are the ones nothing covered yet.
 */
describe('B191: the risky cold outreach paths, covered', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });
  const actorOf = async (id: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { pods: true } });
    return { actor: toActor({ id: u.id, role: u.role, podIds: u.pods.map((p) => p.podId) }), audit: userActor(u) };
  };

  it('B191: two reps claiming the same unclaimed contact at once: one owns it, the other is told who did', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null, claimedAt: null });
    const alisa = await actorOf(b.users.alisa.id), karson = await actorOf(b.users.karson.id);
    const results = await Promise.all([
      transferContact(c.id, b.users.alisa.id, { actor: alisa.audit, guard: alisa.actor, act: 'claim', expectedOwnerId: null }),
      transferContact(c.id, b.users.karson.id, { actor: karson.audit, guard: karson.actor, act: 'claim', expectedOwnerId: null }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const owner = (await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).ownerId;
    expect([b.users.alisa.id, b.users.karson.id]).toContain(owner);
    const lost = results.find((r) => !r.ok);
    expect(lost).toEqual(expect.objectContaining({ ok: false, reason: expect.stringContaining(owner === b.users.alisa.id ? b.users.alisa.name : b.users.karson.name) }));
    expect(await prisma.auditLog.count({ where: { entityId: c.id, action: 'claimed' } })).toBe(1);
  });

  it('B191: the Call button\'s gate, every branch: a form waiting, Also in CRM, the suppression list, calling hours', async () => {
    const rep = { id: b.users.alisa.id, timezone: 'America/Chicago' };
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const noon = new Date('2026-11-10T18:00:00Z'), night = new Date('2026-11-10T09:00:00Z');
    expect(await callGate(rep, c, noon)).toEqual({ blocked: null, warning: null });
    // Outside the contact's calling hours (Chicago, 03:00): blocked, and says why.
    expect((await callGate(rep, c, night)).blocked).toEqual(expect.any(String));
    // Also in CRM.
    expect(await callGate(rep, { ...c, crmMatchPersonId: 'person-01' }, noon)).toEqual({ blocked: 'This person is in the CRM now, so their outreach has stopped. Move to CRM to work them there.', warning: null });
    // On the suppression list.
    const other = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.suppression.create({ data: { kind: 'email', valueHash: (await import('@/lib/sandbox/suppression')).suppressionHash('email', other.email!), reason: 'opted_out' } });
    expect((await callGate(rep, other, noon)).blocked).toEqual(expect.any(String));
    // A call of the rep's still waiting for its form comes first, whoever they want to call next.
    await prisma.callLog.create({ data: { source: 'MANUAL', direction: 'OUTBOUND', status: 'COMPLETED', userId: rep.id, sandboxContactId: other.id, startedAt: new Date(noon.getTime() - 3600_000), formDueAt: new Date(noon.getTime() - 3600_000) } });
    expect((await callGate(rep, c, noon)).blocked).toEqual(expect.stringContaining(FORM_FIRST));
  });

  it('B191: Undo is refused, with the reason, once the CRM person has activity or a CRM campaign since the move', async () => {
    const { actor, audit } = await actorOf(b.users.alisa.id);
    const move = async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const q = await queueMove([{ contactId: c.id, mode: 'create', noConversation: true }], actor, audit, { label: 'Intro call', action: 'CALL', dueDate: '2026-11-20' });
      if (!q.ok) throw new Error(q.error);
      await runMoveQueue();
      return prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    };
    const worked = await move();
    await prisma.touch.create({ data: { personId: worked.twentyPersonId!, channel: 'CALL', direction: 'OUTBOUND', occurredAt: new Date(), summary: 'Call made (2m 0s)', externalId: 'b191-call', audience: 'CRM' } });
    expect(await undoMoveItem(worked.id, actor, audit)).toEqual({ ok: false, error: expect.stringMatching(/has activity in the CRM since the move \(Call made \(2m 0s\)\), so the move is kept\.$/) });
    const enrolled = await move();
    await prisma.enrollment.create({ data: { personId: enrolled.twentyPersonId!, foUserId: b.users.alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-20', audience: 'CRM' } });
    expect(await undoMoveItem(enrolled.id, actor, audit)).toEqual({ ok: false, error: expect.stringMatching(/has been put in a CRM campaign since the move, so the move is kept\.$/) });
    // Neither was undone: both people are still in the CRM.
    expect((await prisma.sandboxMoveItem.findMany({ where: { id: { in: [worked.id, enrolled.id] } } })).map((i) => i.state)).toEqual(['DONE', 'DONE']);
    expect(getMockTwentyClient().people.some((p) => p.id === worked.twentyPersonId)).toBe(true);
  });

  it('B191: an address typed in capitals on the suppression list still stops the contact who has it', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: 'jane.doe@rivera-wealth.com' });
    const admin = b.users.ria;
    auth.requireUser.mockResolvedValue({ id: admin.id, email: admin.email, name: admin.name, role: admin.role, timezone: admin.timezone, twentyMemberId: admin.twentyMemberId, dailyCap: null, podIds: [], pods: [] });
    const fd = new FormData();
    fd.set('kind', 'email');
    fd.set('value', '  JANE.Doe@Rivera-Wealth.COM ');
    expect(await addSuppressionAction(fd)).toEqual({ ok: true, message: 'Added; 1 contact opted out.' });
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('OPTED_OUT');
    // And a contact pushed later with the same address is stopped at the check.
    const later = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: 'jane.doe@rivera-wealth.com' });
    expect(await contactability({ kind: 'cold', id: later.id }, { act: 'next_step' })).toEqual(expect.objectContaining({ ok: false, block: 'suppressed' }));
  });
});
