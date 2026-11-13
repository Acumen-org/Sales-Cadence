import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { automaticReply, processInbox, processSent, syncFolder, type GraphMailStats, type GraphMessage } from '@/lib/mail/graph-mail';
import { recordBounce, systemNotice } from '@/lib/mail/cold-email';
import { addSuppressions } from '@/lib/sandbox/suppression';
import { personalize, personalizeAction, unknownTokenError } from '@/lib/sequences/personalize';
import { refillDraftsFor } from '@/lib/sequences/refill-drafts';
import { advanceEnrollment } from '@/lib/engine/tasks';
import { contactability } from '@/lib/outreach/contactability';
import { optOutContact } from '@/lib/outreach/transitions';
import { MOCK_PEOPLE } from '@/lib/twenty/fixtures';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/** Fixes from the 12 Nov audit of email (11-cadence-email.md), one check per finding. */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const T0 = new Date('2026-11-04T15:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
let b: Basics;
let seq = 0;
const stats = (): GraphMailStats => ({ ran: true, mailboxes: 1, sent: 0, replies: 0, autoReplies: 0, bounces: 0, possibleBounces: 0, notices: 0, alerts: 0, closed: 0, resets: 0, errors: [] });
const addr = (address: string) => ({ emailAddress: { address } });
const sent = (to: string, subject: string, when: Date, over: Partial<GraphMessage> = {}): GraphMessage => ({ internetMessageId: `<s${++seq}@acumen.example>`, conversationId: `conv-${seq}`, subject, sentDateTime: when.toISOString(), receivedDateTime: when.toISOString(), from: addr('alisa@cadence.local'), toRecipients: [addr(to)], ...over });
const inbox = (from: string, subject: string, when: Date, over: Partial<GraphMessage> = {}): GraphMessage => ({ internetMessageId: `<i${++seq}@mail.example>`, conversationId: `conv-in-${seq}`, subject, receivedDateTime: when.toISOString(), from: addr(from), toRecipients: [addr('alisa@cadence.local')], ...over });

async function inCampaign(subject: { sandboxContactId?: string; personId?: string }, foUserId: string) {
  const audience = subject.personId ? 'CRM' : 'SANDBOX';
  const campaign = await prisma.campaign.create({ data: { name: `Q4 ${Math.random().toString(36).slice(2, 6)}`, audience, sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [subject.personId ?? subject.sandboxContactId!], startDate: '2026-11-02', status: 'ACTIVE' } });
  const enrollment = await prisma.enrollment.create({ data: { ...subject, foUserId, podId: b.pods.Alisa.id, campaignId: campaign.id, sequenceId: b.sequence.id, startDate: '2026-11-02', status: 'ACTIVE', currentStep: 0, currentStepId: 's1', audience } });
  const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action: 'EMAIL', label: 'Email 1', dueDate: '2026-11-04', dueAt: new Date('2026-11-04T09:00:00Z'), plannedDate: '2026-11-04' } });
  return { campaign, enrollment, task };
}

describe('email: audit fixes of 12 Nov', () => {
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('L04: a reply from an address not on file, in the conversation of an email sent to one contact, is their reply', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const { enrollment } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id);
    await processSent(sent(c.email!, 'A quick idea', at(1), { conversationId: 'conv-x' }), b.users.alisa.id, stats());
    const s = stats();
    await processInbox(inbox('jane.personal@gmail.com', 'RE: A quick idea', at(30), { conversationId: 'conv-x' }), b.users.alisa.id, s);
    expect(s.replies).toBe(1);
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('REPLIED');
  });

  it('L07: an email to a moved contact whose CRM person opted out rings the alert', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await prisma.sandboxContact.update({ where: { id: c.id }, data: { status: 'MOVED' } });
    await addSuppressions([{ kind: 'email', value: c.email! }], { reason: 'opted_out', source: 'suppression_list' });
    const s = stats();
    await processSent(sent(c.email!, 'Checking in', at(1)), b.users.alisa.id, s);
    expect(s.alerts).toBe(1);
  });

  it('L08: an email step to an address not verified carries a warning', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const row = await prisma.sandboxContact.update({ where: { id: c.id }, data: { emailVerification: 'risky' } });
    expect(await contactability({ kind: 'cold', row }, { act: 'next_step', channel: 'EMAIL' })).toEqual(expect.objectContaining({ ok: true, warning: expect.stringContaining('risky') }));
  });

  it('L10: a Postfix bounce naming no subject is a possible bounce for the one contact emailed just before', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    await processSent(sent(c.email!, 'A quick idea', at(1)), b.users.alisa.id, stats());
    const r = await recordBounce({ key: '<b1@mx>', conversationId: 'other', subject: 'Undelivered Mail Returned to Sender', at: at(3), mailboxUserId: b.users.alisa.id, via: 'outlook' });
    expect(r.possible).toEqual([c.id]);
  });

  it('L13, L17, L18: placeholders with underscores fill in, unknown ones are refused at save, and names go in as text', () => {
    const ctx = { person: { firstName: 'Nina', lastName: 'Ross', companyName: 'A<B Capital', jobTitle: null, city: null }, fo: { name: 'Alisa Grant' } };
    expect(personalize('Hi {{first_name}} at {{company}}', ctx)).toBe('Hi Nina at A<B Capital');
    expect(personalizeAction({ id: 'a', type: 'EMAIL', label: 'Email', bodyHtml: '<p>{{company}}</p>' }, ctx).bodyHtml).toBe('<p>A&lt;B Capital</p>');
    expect(unknownTokenError([{ actions: [{ label: 'Email 1', template: 'Met you at {{leadSource}}' }] }])).toMatch(/leadSource/);
    expect(unknownTokenError([{ actions: [{ label: 'Email 1', template: 'Hi {{first-name}}' }] }])).toBeNull();
  });

  it('L14: one message that cannot be processed is set aside and the folder moves on', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const spy = vi.spyOn(prisma.touch, 'upsert').mockRejectedValueOnce(new Error('value too long'));
    const fetchImpl = (async () => new Response(JSON.stringify({ value: [sent(c.email!, 'One', at(1)), sent(c.email!, 'Two', at(2))], '@odata.deltaLink': 'https://graph.test/delta/1' }), { status: 200 })) as typeof fetch;
    const s = stats();
    await syncFolder({ id: b.users.alisa.id, microsoftId: 'alisa-ms' }, 'sentitems', 'token', s, { fetchImpl, now: T0 });
    spy.mockRestore();
    expect(s.sent).toBe(1);
    expect((await prisma.mailboxCursor.findUniqueOrThrow({ where: { userId_folder: { userId: b.users.alisa.id, folder: 'sentitems' } } })).deltaLink).toBe('https://graph.test/delta/1');
    expect(await prisma.auditLog.count({ where: { action: 'mail_message_skipped' } })).toBe(1);
  });

  it('L22, L23: a meeting acceptance is a reply, a German out-of-office is not, and other mail systems\' bounces are bounces', () => {
    expect(automaticReply('Accepted: Intro call')).toBe(false);
    expect(automaticReply('Abwesenheitsnotiz: Ihre Nachricht')).toBe(true);
    expect(systemNotice('mail-daemon@mx.example.com', 'Non-delivery report: A quick idea')).toBe('bounce');
    expect(systemNotice('bounces+123@mx.example.com', 'Mail System Error - Returned Mail')).toBe('bounce');
  });

  it('L24: a contact only copied on an email, or sent an invite, has no email step closed', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const { task } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id);
    await processSent(sent('colleague@other.example', 'FYI', at(1), { ccRecipients: [addr(c.email!)] }), b.users.alisa.id, stats());
    await processSent(sent(c.email!, 'Intro call', at(2), { '@odata.type': '#microsoft.graph.eventMessageRequest' }), b.users.alisa.id, stats());
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('PENDING');
  });

  it('L06, L11: a CRM person opted out gets no new step, and one whose email bounced gets no email step', async () => {
    const out = MOCK_PEOPLE[2];
    await prisma.personCache.update({ where: { id: out.id }, data: { optedOut: true } });
    const e1 = await prisma.enrollment.create({ data: { personId: out.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-02', status: 'ACTIVE', currentStep: -1, audience: 'CRM' } });
    await advanceEnrollment(e1.id, { actor: SYSTEM_ACTOR, now: T0, skipSync: true });
    expect(await prisma.task.count({ where: { enrollmentId: e1.id, state: 'PENDING' } })).toBe(0);
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: e1.id } })).status).not.toBe('ACTIVE');

    const bounced = MOCK_PEOPLE[3];
    await prisma.personCache.update({ where: { id: bounced.id }, data: { badEmail: true } });
    const e2 = await prisma.enrollment.create({ data: { personId: bounced.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, sequenceId: b.sequence.id, startDate: '2026-11-02', status: 'ACTIVE', currentStep: -1, audience: 'CRM' } });
    await advanceEnrollment(e2.id, { actor: SYSTEM_ACTOR, now: T0, skipSync: true, forceGenerate: true });
    expect(await prisma.task.count({ where: { enrollmentId: e2.id, action: 'EMAIL', state: 'PENDING' } })).toBe(0);
  });

  it('L12: a step handed to another rep is signed with their name, and the first rep\'s draft goes', async () => {
    await prisma.sequence.update({ where: { id: b.sequence.id }, data: { steps: [{ id: 's1', day: 1, actions: [{ id: 'a1', type: 'EMAIL', label: 'Email 1', template: 'Best, {{foName}}' }] }] } });
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
    const { task } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id);
    await prisma.task.update({ where: { id: task.id }, data: { foUserId: b.users.karson.id, actionSnapshot: { id: 'a1', type: 'EMAIL', label: 'Email 1', template: `Best, ${b.users.alisa.name}` }, draftHtml: `<p>Best, ${b.users.alisa.name}</p>` } });
    await prisma.$transaction((tx) => refillDraftsFor(tx, [task.id]));
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect((after.actionSnapshot as { template: string }).template).toBe(`Best, ${b.users.karson.name}`);
    expect(after.draftHtml).toBeNull();
  });

  it('L19: opting out a cold contact opts out an unlinked CRM person with the same personal email at once', async () => {
    const person = MOCK_PEOPLE[5];
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { email: person.email!.toLowerCase() });
    await optOutContact(c.id, { source: 'contact_page', actor: SYSTEM_ACTOR, reason: null, createdById: null });
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: person.id } })).optedOut).toBe(true);
  });
});
