import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR, userActor } from '@/lib/audit';
import { enrollPeople } from '@/lib/engine/enrollment';
import { todayIn } from '@/lib/dates';
import { workspaceTimezone } from '@/lib/workspace';
import { processPendingEvents, storeEvents } from '@/lib/linkedin/events';
import { assignFollowUp, completeFollowUp, dueDateFor, workingDaysAfter } from '@/lib/linkedin/follow-ups';
import { openWithdrawTasks } from '@/lib/linkedin/pass';
import { profileKeyOf, splitName } from '@/lib/linkedin/keys';
import { validSignature } from '@/lib/linkedin/webhook';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { firstWorkingDay } from './helpers/cold-campaign';

const DAY = 86_400_000;
const WEEKDAYS = [1, 2, 3, 4, 5];
let b: Basics;
let seq = 0;

type Over = { at?: Date; publicId?: string; name?: string; email?: string | null; account?: string; data?: Record<string, unknown>; profile?: boolean };
function ev(type: string, over: Over = {}) {
  const publicId = over.publicId ?? 'jane-prospect';
  return {
    seq: ++seq, type, at: (over.at ?? new Date()).toISOString(),
    account: { id: over.account ?? 'acc-leader', linkedinName: 'Sam Leader' },
    user: over.email === null ? null : { email: over.email ?? 'alisa@cadence.local', name: 'Alisa' },
    person: { memberUrn: `urn:li:fsd_profile:${publicId}`, publicId: over.profile === false ? null : publicId, profileUrl: over.profile === false ? null : `https://www.linkedin.com/in/${publicId}/`, name: over.name ?? 'Jane Prospect' },
    data: over.data ?? {},
  };
}
async function feed(...events: unknown[]) {
  await storeEvents(events, 'test');
  return processPendingEvents(new Date());
}

/** person-01 in the CRM with a LinkedIn link, owned by Alisa. */
async function crmPerson(publicId = 'jane-prospect') {
  await prisma.personCache.update({ where: { id: 'person-01' }, data: { linkedinUrl: `https://www.linkedin.com/in/${publicId}`, linkedinKey: `linkedin.com/in/${publicId}`, ownerMemberId: b.users.alisa.twentyMemberId, dnd: false, optedOut: false } });
  return 'person-01';
}

async function linkedinCampaign(personId: string) {
  const sequence = await prisma.sequence.create({ data: { name: 'LinkedIn only', steps: [
    { id: 's1', day: 1, actions: [{ id: 'connect', type: 'LINKEDIN_CONNECT', label: 'LinkedIn connect' }] },
    { id: 's2', day: 3, actions: [{ id: 'msg', type: 'LINKEDIN_MESSAGE', label: 'LinkedIn message' }] },
  ] } });
  await enrollPeople({ personIds: [personId], sequenceId: sequence.id, podId: b.pods.Alisa.id, startDate: firstWorkingDay(), assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR }, { skipSync: true });
  return prisma.enrollment.findFirstOrThrow({ where: { personId } });
}

beforeEach(async () => {
  await resetDb(); b = await seedBasics(); seq = 0;
});

describe('LinkedIn keys and dates', () => {
  it('matches a profile by its link or its public id, in lower case', () => {
    expect(profileKeyOf('https://www.linkedin.com/in/Jane-Doe/?trk=x')).toBe('linkedin.com/in/jane-doe');
    expect(profileKeyOf(null, 'Jane-Doe')).toBe('linkedin.com/in/jane-doe');
    expect(profileKeyOf('https://www.linkedin.com/company/acme')).toBeNull();
    expect(splitName('Jane van der Berg')).toEqual({ firstName: 'Jane', lastName: 'van der Berg' });
  });

  it('counts working days: two working days after a Friday is the Tuesday', () => {
    expect(workingDaysAfter('2027-03-05', 2, WEEKDAYS)).toBe('2027-03-09');
    expect(workingDaysAfter('2027-03-06', 0, WEEKDAYS)).toBe('2027-03-08');
    const s = DEFAULT_SETTINGS.linkedin;
    // Accepted Friday afternoon in London: message due Tuesday. Withdrawn: sent again 3 weeks later.
    expect(dueDateFor({ kind: 'MESSAGE', trigger: 'accepted', triggeredAt: new Date('2027-03-05T15:00:00Z') }, null, 'Europe/London', s, WEEKDAYS)).toBe('2027-03-09');
    expect(dueDateFor({ kind: 'RESEND', trigger: 'withdrawn', triggeredAt: new Date('2027-03-05T15:00:00Z') }, null, 'Europe/London', s, WEEKDAYS)).toBe('2027-03-26');
    // Taken on later than it happened: the clock starts then.
    expect(dueDateFor({ kind: 'MESSAGE', trigger: 'accepted', triggeredAt: new Date('2027-03-01T15:00:00Z') }, new Date('2027-03-05T15:00:00Z'), 'Europe/London', s, WEEKDAYS)).toBe('2027-03-09');
  });

  it('accepts only a correctly signed webhook body', () => {
    const body = JSON.stringify(ev('message.sent'));
    const sig = createHmac('sha256', 'secret').update(body).digest('hex');
    expect(validSignature(body, `sha256=${sig}`, 'secret')).toBe(true);
    expect(validSignature(body, `sha256=${sig}`, 'other')).toBe(false);
    expect(validSignature(body + ' ', `sha256=${sig}`, 'secret')).toBe(false);
    expect(validSignature(body, null, 'secret')).toBe(false);
  });
});

describe('LinkedIn events from the Console', () => {
  it('keeps each event once, by its sequence number', async () => {
    const e = ev('message.sent');
    expect((await storeEvents([e, e], 'webhook')).stored).toBe(1);
    expect((await storeEvents([e], 'feed')).duplicates).toBe(1);
    expect((await storeEvents([{ seq: 'x', type: 'nope' }], 'feed')).invalid).toBe(1);
  });

  it('a request seen as sent closes the campaign\'s connect step; a message closes the message step', async () => {
    const personId = await crmPerson();
    const enrollment = await linkedinCampaign(personId);
    const connect = await prisma.task.findFirstOrThrow({ where: { enrollmentId: enrollment.id, action: 'LINKEDIN_CONNECT' } });
    const r = await feed(ev('invitation.sent', { at: new Date(Date.now() + 60_000) }));
    expect(r).toEqual({ invitation_step_closed: 1 });
    const closed = await prisma.task.findUniqueOrThrow({ where: { id: connect.id } });
    expect(closed).toMatchObject({ state: 'DONE', completionSource: 'OBSERVED_MESSAGE', evidenceId: 'linkedin:1' });
    const touch = await prisma.touch.findUniqueOrThrow({ where: { externalId: 'linkedin:1' } });
    expect(touch).toMatchObject({ personId, channel: 'LINKEDIN', direction: 'OUTBOUND', actorUserId: b.users.alisa.id, audience: 'CRM' });
    expect(touch.summary).toContain("Sam Leader's account");
    const link = await prisma.linkedInLink.findFirstOrThrow({ where: { personId } });
    expect(link).toMatchObject({ status: 'PENDING', invitedByUserId: b.users.alisa.id, accountId: 'acc-leader' });
  });

  it('accepted: the owner gets "Message on LinkedIn" two working days later, closed by the message', async () => {
    const personId = await crmPerson();
    const at = new Date();
    await feed(ev('invitation.sent', { at: new Date(at.getTime() - DAY) }), ev('connection.accepted', { at, data: { invitedByUs: true } }));
    const f = await prisma.linkedInFollowUp.findFirstOrThrow({ where: { personId } });
    expect(f).toMatchObject({ kind: 'MESSAGE', trigger: 'accepted', foUserId: b.users.alisa.id, state: 'OPEN', accountId: 'acc-leader' });
    expect(f.dueDate).toBe(dueDateFor(f, null, 'Europe/London', DEFAULT_SETTINGS.linkedin, DEFAULT_SETTINGS.rules.workingDays));
    // Sent by Leigh from another firm account: any teammate, any account, closes it.
    await feed(ev('message.sent', { at: new Date(at.getTime() + 60_000), email: 'leigh@cadence.local', account: 'acc-other' }));
    expect(await prisma.linkedInFollowUp.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ state: 'DONE', evidenceId: 'linkedin:3' });
  });

  it('no message task when they were messaged already after accepting', async () => {
    const personId = await crmPerson();
    const at = Date.now();
    await feed(ev('message.sent', { at: new Date(at + 1000) }));
    await feed(ev('connection.accepted', { at: new Date(at), data: { invitedByUs: true } }));
    expect(await prisma.linkedInFollowUp.count({ where: { personId } })).toBe(0);
  });

  it('someone unknown we reached becomes an unowned cold contact; once they accept they need an owner', async () => {
    await feed(ev('invitation.sent', { publicId: 'new-person', name: 'Nia New' }));
    const c = await prisma.sandboxContact.findFirstOrThrow({ where: { linkedinUrl: 'linkedin.com/in/new-person' } });
    expect(c).toMatchObject({ source: 'LINKEDIN', firstName: 'Nia', lastName: 'New', ownerId: null, podId: b.pods.Alisa.id, status: 'ACTIVE' });
    // No owner yet, and no task: the rule is no owner until they respond.
    expect(await prisma.linkedInFollowUp.count()).toBe(0);
    await feed(ev('connection.accepted', { publicId: 'new-person', data: { invitedByUs: true } }));
    const f = await prisma.linkedInFollowUp.findFirstOrThrow({ where: { sandboxContactId: c.id } });
    expect(f).toMatchObject({ kind: 'MESSAGE', foUserId: null, dueDate: null, audience: 'SANDBOX' });
    // A leader gives it to Karson: Karson owns the contact, and the clock starts now.
    expect(await assignFollowUp(f.id, b.users.karson.id, userActor(b.users.alisa))).toEqual({ ok: true });
    expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ ownerId: b.users.karson.id });
    const assigned = await prisma.linkedInFollowUp.findUniqueOrThrow({ where: { id: f.id } });
    expect(assigned.foUserId).toBe(b.users.karson.id);
    expect(assigned.dueDate).toBe(workingDaysAfter(todayIn('Europe/London'), 2, DEFAULT_SETTINGS.rules.workingDays));
  });

  it('a stranger who writes or asks to connect is not brought in', async () => {
    expect(await feed(ev('message.received', { publicId: 'stranger' }))).toEqual({ not_ours: 1 });
    expect(await feed(ev('connection.accepted', { publicId: 'stranger2', data: { invitedByUs: false } }))).toEqual({ not_ours: 1 });
    expect(await prisma.sandboxContact.count({ where: { source: 'LINKEDIN' } })).toBe(0);
  });

  it('a reply stops the campaign and asks the owner to answer', async () => {
    const personId = await crmPerson();
    const enrollment = await linkedinCampaign(personId);
    expect(await feed(ev('message.received', { at: new Date(Date.now() + 60_000) }))).toEqual({ reply_campaign_stopped: 1 });
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).toMatchObject({ status: 'REPLIED' });
    const reply = await prisma.linkedInFollowUp.findFirstOrThrow({ where: { personId } });
    expect(reply).toMatchObject({ kind: 'MESSAGE', trigger: 'replied', foUserId: b.users.alisa.id });
    // Answered within 2 working days, as an email reply is (owner, 13 Nov 2026).
    expect(reply.dueDate).toBe(workingDaysAfter(todayIn('Europe/London', reply.triggeredAt), 2, DEFAULT_SETTINGS.rules.workingDays));
    expect(await prisma.touch.count({ where: { personId, channel: 'LINKEDIN', direction: 'INBOUND' } })).toBe(1);
  });

  it('14 days unanswered: withdraw; withdrawn: send again 3 weeks later; then only once', async () => {
    const personId = await crmPerson();
    const sent = new Date(Date.now() - 15 * DAY);
    await feed(ev('invitation.sent', { at: sent }));
    expect(await openWithdrawTasks()).toBe(1);
    expect(await openWithdrawTasks()).toBe(0);
    const w = await prisma.linkedInFollowUp.findFirstOrThrow({ where: { personId, kind: 'WITHDRAW' } });
    expect(w).toMatchObject({ foUserId: b.users.alisa.id, trigger: 'pending' });
    await feed(ev('invitation.withdrawn', { at: new Date(Date.now() - 1000) }));
    expect(await prisma.linkedInFollowUp.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({ state: 'DONE' });
    const resend = await prisma.linkedInFollowUp.findFirstOrThrow({ where: { personId, kind: 'RESEND' } });
    expect(resend.dueDate! >= todayIn('Europe/London')).toBe(true);
    // Sent again: the resend is done, and the request starts its own 14 days.
    await feed(ev('invitation.sent'));
    expect(await prisma.linkedInFollowUp.findUniqueOrThrow({ where: { id: resend.id } })).toMatchObject({ state: 'DONE' });
    expect(await prisma.linkedInLink.findFirstOrThrow({ where: { personId } })).toMatchObject({ status: 'PENDING', resends: 1 });
    // Withdrawn a second time: no third request (one resend, then stop).
    expect(await feed(ev('invitation.withdrawn'))).toEqual({ withdrawn_no_more_resends: 1 });
  });

  it('accepting cancels a withdrawal that was waiting', async () => {
    const personId = await crmPerson();
    await feed(ev('invitation.sent', { at: new Date(Date.now() - 15 * DAY) }));
    await openWithdrawTasks();
    await feed(ev('connection.accepted', { data: { invitedByUs: true } }));
    expect(await prisma.linkedInFollowUp.findFirstOrThrow({ where: { personId, kind: 'WITHDRAW' } })).toMatchObject({ state: 'CANCELLED', closeReason: 'They accepted' });
  });

  it('a connect step for someone already connected closes, saying so', async () => {
    const personId = await crmPerson();
    await feed(ev('connection.accepted', { at: new Date(Date.now() - 30 * DAY), data: { invitedByUs: true } }));
    const enrollment = await linkedinCampaign(personId);
    const { closeConnectStepsAlreadyDone } = await import('@/lib/linkedin/events');
    expect(await closeConnectStepsAlreadyDone(null)).toBe(1);
    const t = await prisma.task.findFirstOrThrow({ where: { enrollmentId: enrollment.id, action: 'LINKEDIN_CONNECT' } });
    expect(t).toMatchObject({ state: 'DONE', completionSource: 'SYSTEM' });
    expect(t.note).toContain('Already connected');
  });

  it('nobody who must not be contacted gets a task', async () => {
    const personId = await crmPerson();
    await prisma.personCache.update({ where: { id: personId }, data: { dnd: true } });
    await feed(ev('connection.accepted', { data: { invitedByUs: true } }));
    expect(await prisma.linkedInFollowUp.count()).toBe(0);
  });

  it('an event without a profile link waits until one for the same member brings it', async () => {
    await crmPerson();
    expect(await feed(ev('connection.accepted', { profile: false, data: { invitedByUs: true } }))).toEqual({ waiting_profile: 1 });
    expect(await feed(ev('message.received', { at: new Date(Date.now() + 60_000) }))).toMatchObject({ accepted_message_opened: 1, reply_recorded: 1 });
  });

  it('Done by hand closes it', async () => {
    const personId = await crmPerson();
    await feed(ev('connection.accepted', { data: { invitedByUs: true } }));
    const f = await prisma.linkedInFollowUp.findFirstOrThrow({ where: { personId } });
    expect(await completeFollowUp(f.id, userActor(b.users.alisa))).toEqual({ ok: true });
    expect(await prisma.linkedInFollowUp.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ state: 'DONE', completionSource: 'MANUAL', completedById: b.users.alisa.id });
    expect(await completeFollowUp(f.id, userActor(b.users.alisa))).toMatchObject({ ok: false });
  });

  void workspaceTimezone;
});
