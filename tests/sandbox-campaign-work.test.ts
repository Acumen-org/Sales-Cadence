import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import { todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { activateCampaign } from '@/lib/engine/campaigns';
import { completeTask } from '@/lib/engine/tasks';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { createSandboxCampaign } from '@/lib/sandbox/campaigns';
import { processMoveItem, queueMove, undoMoveItem } from '@/lib/sandbox/move';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

const actorOf = async (id: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { pods: true } });
  return { actor: toActor({ id: u.id, role: u.role, podIds: u.pods.map((p) => p.podId) }), audit: userActor(u) };
};

/** A sandbox contact in a sandbox campaign that started today, with its first step generated. */
async function enrolled(b: Basics, over: Parameters<typeof readyContact>[2] = {}) {
  const { actor, audit } = await actorOf(b.users.alisa.id);
  const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, over);
  const created = await createSandboxCampaign({ name: 'Sandbox spring', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: todayIn(workspaceTimezone()), contactIds: [contact.id] }, actor, audit);
  if (!created.ok) throw new Error(created.error);
  // A Senior FO's campaign waits for a leader's approval; approved here.
  await prisma.campaign.update({ where: { id: created.id }, data: { status: 'SCHEDULED', approvedAt: new Date(), approvedById: b.users.leigh.id } });
  await activateCampaign(created.id, { actor: audit });
  const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { sandboxContactId: contact.id }, include: { tasks: true } });
  return { contact, campaignId: created.id, enrollment, actor, audit };
}

describe('Sandbox contacts in campaigns, on the same engine as CRM people', () => {
  let b: Basics;
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('enrolls a sandbox contact and generates its first step, with nothing written to Twenty', async () => {
    const { contact, campaignId, enrollment } = await enrolled(b);
    expect(enrollment).toEqual(expect.objectContaining({ sandboxContactId: contact.id, personId: null, campaignId, foUserId: b.users.alisa.id, status: 'ACTIVE' }));
    expect(enrollment.tasks.length).toBeGreaterThan(0);
    expect(enrollment.tasks.every((t) => t.state === 'PENDING' && t.stepIndex === 0)).toBe(true);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe('ACTIVE');
    expect(getMockTwentyClient().writes).toEqual([]);
  });

  it('completes a sandbox step: a touch on the contact, the next step, still nothing in Twenty', async () => {
    const { contact, enrollment, audit } = await enrolled(b);
    // Day 1 holds two modules (email, LinkedIn connect): the step is done when both are.
    const results = [];
    for (const t of enrollment.tasks) results.push(await completeTask({ taskId: t.id, source: 'MANUAL' }, { actor: audit }));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await prisma.task.findMany({ where: { id: { in: enrollment.tasks.map((t) => t.id) } } })).every((t) => t.state === 'DONE')).toBe(true);
    const touches = await prisma.touch.findMany({ where: { sandboxContactId: contact.id } });
    expect(touches.length).toBeGreaterThan(0);
    expect(touches.every((t) => t.personId === null)).toBe(true);
    const last = results[results.length - 1];
    const advanced = last.ok ? last.advance.outcome : null;
    expect(['generated', 'waiting']).toContain(advanced);
    if (advanced === 'generated') expect((await prisma.task.findMany({ where: { enrollmentId: enrollment.id, state: 'PENDING' } })).every((t) => t.stepIndex === 1)).toBe(true);
    expect(getMockTwentyClient().writes.filter((w) => w.op === 'createNote' || w.op === 'createTask')).toEqual([]);
  });

  it('carries the running campaign over to the CRM person on Move, and Undo brings it back', async () => {
    const { contact, enrollment, actor, audit } = await enrolled(b);
    const open = enrollment.tasks.filter((t) => t.state === 'PENDING').map((t) => t.id);
    const q = await queueMove([{ contactId: contact.id, mode: 'create' }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    expect(await processMoveItem(item.id)).toBe('DONE');
    const done = await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(done.carryOver).toEqual({ carried: [enrollment.id], ended: [] });

    const moved = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id }, include: { tasks: true } });
    expect(moved).toEqual(expect.objectContaining({ personId: done.twentyPersonId, sandboxContactId: contact.id, status: 'ACTIVE', exitReason: null }));
    expect(moved.tasks.filter((t) => open.includes(t.id)).every((t) => t.state === 'PENDING' && t.twentyTaskId)).toBe(true);
    const mirrored = getMockTwentyClient().writes.filter((w) => w.op === 'createTask');
    expect(mirrored).toHaveLength(open.length);

    const undone = await undoMoveItem(item.id, actor, audit);
    expect(undone.ok).toBe(true);
    const back = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id }, include: { tasks: true } });
    expect(back).toEqual(expect.objectContaining({ personId: null, sandboxContactId: contact.id, status: 'ACTIVE' }));
    expect(back.tasks.filter((t) => open.includes(t.id)).every((t) => t.state === 'PENDING' && t.twentyTaskId === null)).toBe(true);
    expect(getMockTwentyClient().writes.filter((w) => w.op === 'deleteTask').map((w) => w.id).sort()).toEqual(mirrored.map((w) => w.id).sort());
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id } })).status).toBe('ACTIVE');
  });

  it('ends the campaign when the person is already in a sequence, and Undo restarts it in the sandbox', async () => {
    const person = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null } });
    await prisma.enrollment.create({ data: { personId: person.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: todayIn(workspaceTimezone()), status: 'ACTIVE' } });
    const { contact, enrollment, actor, audit } = await enrolled(b, { email: person.email });
    const q = await queueMove([{ contactId: contact.id, mode: 'attach' }], actor, audit);
    if (!q.ok) throw new Error(q.error);
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    expect(await processMoveItem(item.id)).toBe('DONE');
    expect((await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: item.id } })).carryOver).toEqual({ carried: [], ended: [{ id: enrollment.id, status: 'ACTIVE' }] });
    const ended = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id }, include: { tasks: true } });
    expect(ended).toEqual(expect.objectContaining({ status: 'EXITED', exitReason: 'moved_to_crm', personId: person.id }));
    expect(ended.tasks.every((t) => t.state === 'CANCELLED')).toBe(true);

    expect((await undoMoveItem(item.id, actor, audit)).ok).toBe(true);
    const back = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id }, include: { tasks: true } });
    expect(back).toEqual(expect.objectContaining({ status: 'ACTIVE', exitReason: null, personId: null }));
    expect(back.tasks.every((t) => t.state === 'PENDING')).toBe(true);
  });
});
