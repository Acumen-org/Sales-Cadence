import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import { addDays, todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { activateCampaign } from '@/lib/engine/campaigns';
import { completeTask } from '@/lib/engine/tasks';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { coldDraft, noonOf, publishColdCampaign, sessionOf } from './helpers/cold-campaign';
import { preflightMove, processMoveItem, queueMove } from '@/lib/sandbox/move';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

const actorOf = async (id: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { pods: true } });
  return { actor: toActor({ id: u.id, role: u.role, podIds: u.pods.map((p) => p.podId) }), audit: userActor(u) };
};

/** A sandbox contact in a cold campaign published in the studio (S7: no approval) and started, with its first step generated. */
async function enrolled(b: Basics, over: Parameters<typeof readyContact>[2] = {}) {
  const { actor, audit } = await actorOf(b.users.alisa.id);
  const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id, over);
  const draft = coldDraft(b.pods.Alisa.id, [contact.id], [b.users.alisa.id]);
  const { campaign } = await publishColdCampaign(await sessionOf(b.users.alisa.id), draft);
  await activateCampaign(campaign.id, { actor: audit, now: noonOf(draft.startDate) });
  const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { sandboxContactId: contact.id }, include: { tasks: true } });
  return { contact, campaignId: campaign.id, enrollment, actor, audit };
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
    // Day 1 holds two modules (email, call): the step is done when both are.
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

  it('ends the running campaign on Move, and the next step becomes the person\'s next action', async () => {
    const { contact, enrollment, actor, audit } = await enrolled(b);
    await prisma.nextAction.create({ data: { sandboxContactId: contact.id, foUserId: b.users.alisa.id, label: 'Old sandbox step', action: 'EMAIL', dueDate: todayIn(workspaceTimezone()), crmPending: false } });
    expect((await preflightMove([contact.id], actor)).items[0].ownStep).toEqual(expect.objectContaining({ label: 'Old sandbox step', action: 'EMAIL' }));
    const due = addDays(todayIn(workspaceTimezone()), 2);
    const q = await queueMove([{ contactId: contact.id, mode: 'create', noConversation: true }], actor, audit, { label: 'Follow up on the intro call', action: 'CALL', dueDate: due });
    if (!q.ok) throw new Error(q.error);
    const item = await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } });
    expect(await processMoveItem(item.id)).toBe('DONE');
    const personId = (await prisma.sandboxMoveItem.findUniqueOrThrow({ where: { id: item.id } })).twentyPersonId;

    const ended = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id }, include: { tasks: true } });
    expect(ended).toEqual(expect.objectContaining({ status: 'EXITED', exitReason: 'moved_to_crm', personId }));
    expect(ended.tasks.every((t) => t.state === 'CANCELLED')).toBe(true);
    expect(getMockTwentyClient().writes.filter((w) => w.op === 'createTask')).toEqual([]);

    // B034: the contact keeps its own step: the cold one closes, a CRM one opens on the person, for
    // the owner, waiting for Twenty. The dialog's step was only for contacts without one.
    const open = await prisma.nextAction.findMany({ where: { personId, state: 'OPEN' } });
    expect(open).toEqual([expect.objectContaining({ label: 'Old sandbox step', action: 'EMAIL', foUserId: b.users.alisa.id, audience: 'CRM' })]);
    expect(getMockTwentyClient().writes).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'setPersonNextAction', id: personId, patch: expect.objectContaining({ nextAction: 'Old sandbox step' }) })]));
    expect(await prisma.nextAction.findMany({ where: { sandboxContactId: contact.id, personId: null } })).toEqual([expect.objectContaining({ label: 'Old sandbox step', state: 'CANCELLED' })]);
  });

  it('leaves the next action of a person already in Twenty in place', async () => {
    const person = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null }, deletedAt: null } });
    const theirs = await prisma.nextAction.create({ data: { personId: person.id, foUserId: b.users.leigh.id, label: 'Their own step', action: 'EMAIL', dueDate: todayIn(workspaceTimezone()) } });
    const { contact, actor, audit } = await enrolled(b, { email: person.email });
    const q = await queueMove([{ contactId: contact.id, mode: 'attach' }], actor, audit, { label: 'Follow up on the intro call', action: 'CALL', dueDate: todayIn(workspaceTimezone()) });
    if (!q.ok) throw new Error(q.error);
    expect(await processMoveItem((await prisma.sandboxMoveItem.findFirstOrThrow({ where: { moveId: q.moveId } })).id)).toBe('DONE');
    expect(await prisma.nextAction.findMany({ where: { personId: person.id, state: 'OPEN' } })).toEqual([expect.objectContaining({ id: theirs.id, label: 'Their own step' })]);
    // B034: nothing was written on the contact at queue time, and the move left the person's own step alone (B097).
    expect(await prisma.nextAction.findFirst({ where: { sandboxContactId: contact.id } })).toBeNull();
  });
});
