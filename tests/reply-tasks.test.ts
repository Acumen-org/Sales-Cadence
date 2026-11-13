import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { todayIn, toLocalDate } from '@/lib/dates';
import { ingestEvent } from '@/lib/engine/ingest';
import { rawFromMessage } from '@/lib/engine/reconcile';
import { recordColdReply, recordColdSent, type SeenMail } from '@/lib/mail/cold-email';
import { EMAIL_REPLY_DAYS, workingDaysAfter } from '@/lib/linkedin/follow-ups';
import { needsOwnerItems } from '@/lib/linkedin/tasks-view';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';
import { sessionOf } from './helpers/cold-campaign';

/**
 * "Reply to their email" (owner, 13 Nov 2026): when a CRM person or a cold contact answers an email, in a
 * campaign or not, their owner gets a task due 2 working days later, closed by our next email to them.
 */
let b: Basics;
const mock = getMockTwentyClient();
const outlook = (key: string, subject: string, at: Date): SeenMail => ({ key, conversationId: `conv-${key}`, subject, at, mailboxUserId: b.users.alisa.id, via: 'outlook' });

async function crmReply(personId: string, email: string, at: Date, subject = 'Re: Our note') {
  const msg = mock.addMessage({ subject, receivedAt: at.toISOString(), from: { handle: email, personId }, to: [{ handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }] });
  return ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(msg), now: new Date(at.getTime() + 60_000) });
}
async function crmSent(personId: string, email: string, at: Date) {
  const msg = mock.addMessage({ subject: 'Our answer', receivedAt: at.toISOString(), from: { handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }, to: [{ handle: email, personId }] });
  return ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(msg), now: new Date(at.getTime() + 60_000) });
}
const dueAfter = (at: Date) => workingDaysAfter(toLocalDate(at, 'Europe/London'), EMAIL_REPLY_DAYS, DEFAULT_SETTINGS.rules.workingDays);

beforeEach(async () => { await resetDb(); b = await seedBasics(); });

describe('Reply to their email', () => {
  it('a CRM person who answers, in no campaign, gives their owner a task due 2 working days later; our email closes it', async () => {
    const p = await prisma.personCache.update({ where: { id: 'person-01' }, data: { email: 'pat@prospect.example', emailNorm: 'pat@prospect.example', ownerMemberId: b.users.leigh.twentyMemberId, dnd: false, optedOut: false } });
    const at = new Date(Date.now() - 60_000);
    await crmReply(p.id, p.email!, at);
    const f = await prisma.linkedInFollowUp.findFirstOrThrow({ where: { personId: p.id } });
    expect(f).toMatchObject({ kind: 'EMAIL_REPLY', state: 'OPEN', foUserId: b.users.leigh.id, linkId: null, accountId: null, audience: 'CRM' });
    expect(f.dueDate).toBe(dueAfter(at));
    // The same email seen again opens nothing new.
    expect(await prisma.linkedInFollowUp.count()).toBe(1);
    await crmSent(p.id, p.email!, new Date());
    expect(await prisma.linkedInFollowUp.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ state: 'DONE' });
  });

  it('an out-of-office, or a reply first seen over a week late, opens nothing', async () => {
    const p = await prisma.personCache.update({ where: { id: 'person-01' }, data: { email: 'pat@prospect.example', emailNorm: 'pat@prospect.example', ownerMemberId: b.users.leigh.twentyMemberId } });
    await crmReply(p.id, p.email!, new Date(), 'Automatic reply: Out of office');
    await crmReply(p.id, p.email!, new Date(Date.now() - 8 * 86_400_000), 'Re: Old thread');
    expect(await prisma.linkedInFollowUp.count()).toBe(0);
  });

  it('a cold contact\'s reply goes to its owner; one nobody owns waits in Cold outreach > Needs an owner', async () => {
    const owned = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await recordColdReply(owned.email!, outlook('<r1@x>', 'Re: A quick idea', new Date()), false);
    expect(await prisma.linkedInFollowUp.findFirstOrThrow({ where: { sandboxContactId: owned.id } })).toMatchObject({ kind: 'EMAIL_REPLY', foUserId: b.users.alisa.id, audience: 'SANDBOX' });

    const free = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: 'free@prospect.example' });
    await prisma.sandboxContact.update({ where: { id: free.id }, data: { ownerId: null } });
    await recordColdReply('free@prospect.example', outlook('<r2@x>', 'Re: A quick idea', new Date()), false);
    const waiting = await prisma.linkedInFollowUp.findFirstOrThrow({ where: { sandboxContactId: free.id } });
    expect(waiting).toMatchObject({ foUserId: null, dueDate: null });
    expect((await needsOwnerItems(await sessionOf(b.users.karson.id))).map((x) => x.id)).toEqual([waiting.id]);

    // Our email to the owned one closes its task.
    await recordColdSent([owned.email!], outlook('<s1@x>', 'Re: A quick idea', new Date(Date.now() + 60_000)));
    expect(await prisma.linkedInFollowUp.findFirstOrThrow({ where: { sandboxContactId: owned.id } })).toMatchObject({ state: 'DONE' });
  });

  it('a cold contact also in the CRM: the task is the CRM person\'s, in the normal Tasks list', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.personCache.update({ where: { id: 'person-02' }, data: { ownerMemberId: b.users.andrew.twentyMemberId, dnd: false, optedOut: false } });
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { crmMatchPersonId: 'person-02' } });
    await recordColdReply(c.email!, outlook('<r3@x>', 'Re: A quick idea', new Date()), false);
    expect(await prisma.linkedInFollowUp.findFirstOrThrow({ where: { kind: 'EMAIL_REPLY' } })).toMatchObject({ personId: 'person-02', foUserId: b.users.andrew.id });
    expect(await needsOwnerItems(await sessionOf(b.users.ria.id))).toEqual([]);
    void todayIn;
  });
});
