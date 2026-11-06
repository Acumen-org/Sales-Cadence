import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { userActor } from '@/lib/audit';
import { toActor } from '@/lib/auth/rbac';
import { todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { activateCampaign } from '@/lib/engine/campaigns';
import { upsertPersonCache } from '@/lib/person-cache';
import { blankPerson, getMockTwentyClient } from '@/lib/twenty/mock-client';
import type { TwentyPerson } from '@/lib/twenty/types';
import { coldAudienceIssues } from '@/lib/sandbox/campaigns';
import { coldDraft, noonOf, publishColdCampaign, sessionOf } from './helpers/cold-campaign';
import { checkSandboxAgainstCrm, CLEARED_ACTION, EXIT_REASON, FLAGGED_ACTION } from '@/lib/sandbox/crm-check';
import { statusByIds } from '@/lib/sandbox/status';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/** The daily check: sandbox contacts Twenty gained after the push. */

let seq = 0;
/** A person someone added to Twenty, cached by Cadence's sync unless `cached` is false. */
async function crmPerson(email: string | null, over: Partial<TwentyPerson> = {}, cached = true): Promise<TwentyPerson> {
  const person: TwentyPerson = { ...blankPerson(`person-check-${++seq}`, new Date().toISOString()), firstName: 'Sam', lastName: 'Rivera', email, createdBySource: 'MANUAL', ...over };
  getMockTwentyClient().people.push(person);
  if (cached) await upsertPersonCache(person);
  return person;
}

describe('Daily check of sandbox contacts against Twenty', () => {
  let b: Basics;
  const actorOf = async (id: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id }, include: { pods: true } });
    return { actor: toActor({ id: u.id, role: u.role, podIds: u.pods.map((p) => p.podId) }), audit: userActor(u) };
  };
  /** A contact in a running sandbox campaign, with an open next action. */
  async function working() {
    const { audit } = await actorOf(b.users.alisa.id);
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    // S7: published in the studio, with no approval, and started on its first day.
    const draft = coldDraft(b.pods.Alisa.id, [contact.id], [b.users.alisa.id]);
    const { campaign } = await publishColdCampaign(await sessionOf(b.users.alisa.id), draft);
    await activateCampaign(campaign.id, { actor: audit, now: noonOf(draft.startDate) });
    await prisma.nextAction.create({ data: { sandboxContactId: contact.id, foUserId: b.users.alisa.id, label: 'Call back', action: 'CALL', dueDate: todayIn(workspaceTimezone()), crmPending: false } });
    return contact;
  }
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('flags a contact someone added to Twenty, stops its outreach, and Bellwether reads already_in_crm', async () => {
    const contact = await working();
    const person = await crmPerson(contact.email);
    expect(await checkSandboxAgainstCrm()).toEqual(expect.objectContaining({ flagged: 1, cleared: 0, asked: true }));

    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id } })).toEqual(expect.objectContaining({ status: 'ACTIVE', crmMatchPersonId: person.id, crmMatchedOn: 'email' }));
    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { sandboxContactId: contact.id }, include: { tasks: true } });
    expect(enrollment).toEqual(expect.objectContaining({ status: 'EXITED', exitReason: EXIT_REASON }));
    expect(enrollment.tasks.every((t) => t.state !== 'PENDING')).toBe(true);
    expect(await prisma.nextAction.count({ where: { sandboxContactId: contact.id, state: 'OPEN' } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: FLAGGED_ACTION, entityId: contact.id } })).toBe(1);

    const [status] = await statusByIds([contact.bellwetherContactId!]);
    expect(status).toEqual(expect.objectContaining({ status: 'already_in_crm', cadenceContactId: contact.id, crmPersonId: person.id }));
    expect(status.crmUrl).toContain(person.id);
    // No sandbox campaign takes it again.
    expect(await coldAudienceIssues([contact.id], { podId: b.pods.Alisa.id, podName: 'Pod Alisa', foIds: [] })).toEqual([expect.objectContaining({ reason: 'Already in the CRM' })]);

    // A second night changes nothing.
    expect(await checkSandboxAgainstCrm()).toEqual(expect.objectContaining({ flagged: 0, cleared: 0 }));
    expect(await prisma.auditLog.count({ where: { action: FLAGGED_ACTION, entityId: contact.id } })).toBe(1);
  });

  it('asks Twenty itself: a person Cadence\'s copy does not have yet is found', async () => {
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const person = await crmPerson(contact.email, {}, false);
    expect(await checkSandboxAgainstCrm()).toEqual(expect.objectContaining({ flagged: 1 }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id } })).crmMatchPersonId).toBe(person.id);
  });

  it('leaves a person Twenty\'s mail sync created to the cleanup, unless the cleanup kept it', async () => {
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const auto = await crmPerson(contact.email, { createdBySource: 'EMAIL' });
    expect(await checkSandboxAgainstCrm()).toEqual(expect.objectContaining({ flagged: 0 }));
    // Someone worked it, so the cleanup kept it and flagged it: it is in the CRM for real.
    await prisma.sandboxContact.update({ where: { id: contact.id }, data: { crmAutoPersonId: auto.id, crmAutoSource: 'EMAIL', crmAutoFlaggedAt: new Date() } });
    expect(await checkSandboxAgainstCrm()).toEqual(expect.objectContaining({ flagged: 1 }));
  });

  it('clears the flag when the person leaves Twenty, without restarting the stopped outreach', async () => {
    const contact = await working();
    const person = await crmPerson(contact.email);
    await checkSandboxAgainstCrm();
    await getMockTwentyClient().deletePerson(person.id);
    expect(await checkSandboxAgainstCrm()).toEqual(expect.objectContaining({ cleared: 1 }));
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: contact.id } })).crmMatchPersonId).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: CLEARED_ACTION, entityId: contact.id } })).toBe(1);
    expect((await prisma.enrollment.findFirstOrThrow({ where: { sandboxContactId: contact.id } })).status).toBe('EXITED');
    expect((await statusByIds([contact.bellwetherContactId!]))[0].status).toBe('in_sandbox');
  });

  it('decides from Cadence\'s copy when Twenty cannot be reached', async () => {
    const contact = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await crmPerson(contact.email);
    getMockTwentyClient().failNext = new Error('Twenty is down');
    expect(await checkSandboxAgainstCrm()).toEqual(expect.objectContaining({ flagged: 1, asked: false }));
  });
});
