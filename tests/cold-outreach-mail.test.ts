import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR, userActor } from '@/lib/audit';
import { resetEnvCache } from '@/lib/env';
import { emailCloseWords, graphMailState, mailTrackedFor, processInbox, processSent, syncFolder, TRACKING_OFF, type GraphMailStats, type GraphMessage } from '@/lib/mail/graph-mail';
import { bounceWords, clearPossibleBounce, confirmPossibleBounce, emailsToDoNotContact, originalSubject, systemNotice } from '@/lib/mail/cold-email';
import { optOutContact, removeContact } from '@/lib/outreach/transitions';
import { addSuppressions } from '@/lib/sandbox/suppression';
import { ingestEvent } from '@/lib/engine/ingest';
import { rawFromMessage, reconcile } from '@/lib/engine/reconcile';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { replyCount } from '@/lib/outreach/metrics';
import { saveSettingsSection, DEFAULT_SETTINGS } from '@/lib/settings';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/**
 * W10 (cold outreach PLAN 8.11): Outlook email tracking and its alerts. Each test is named after its bug.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const T0 = new Date('2026-11-04T15:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
let b: Basics;
let seq = 0;
let leader: { id: string };

const stats = (): GraphMailStats => ({ ran: true, mailboxes: 1, sent: 0, replies: 0, autoReplies: 0, bounces: 0, possibleBounces: 0, notices: 0, alerts: 0, closed: 0, resets: 0, errors: [] });
const addr = (address: string) => ({ emailAddress: { address } });
/** A message in a rep's Sent Items. */
const sent = (to: string, subject: string, when: Date, over: Partial<GraphMessage> = {}): GraphMessage => ({ internetMessageId: `<s${++seq}@acumen.example>`, conversationId: `conv-${seq}`, subject, sentDateTime: when.toISOString(), receivedDateTime: when.toISOString(), from: addr('alisa@cadence.local'), toRecipients: [addr(to)], ...over });
/** A message in a rep's Inbox. */
const inbox = (from: string, subject: string, when: Date, over: Partial<GraphMessage> = {}): GraphMessage => ({ internetMessageId: `<i${++seq}@mail.example>`, conversationId: `conv-in-${seq}`, subject, receivedDateTime: when.toISOString(), from: addr(from), toRecipients: [addr('alisa@cadence.local')], ...over });
const guard = (u: { id: string }, role: Role, podIds: string[]) => ({ id: u.id, role, podIds });

/** A cold contact (or CRM person) in a running campaign with one pending Email step due on `due`. */
async function inCampaign(subject: { sandboxContactId?: string; personId?: string }, foUserId: string, due = '2026-11-04') {
  const audience = subject.personId ? 'CRM' : 'SANDBOX';
  const created = new Date('2026-11-02T09:00:00Z');
  const campaign = await prisma.campaign.create({ data: { name: `Q4 Harbor ${Math.random().toString(36).slice(2, 6)}`, audience, sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [subject.personId ?? subject.sandboxContactId!], startDate: '2026-11-02', status: 'ACTIVE' } });
  const enrollment = await prisma.enrollment.create({ data: { ...subject, foUserId, podId: b.pods.Alisa.id, campaignId: campaign.id, sequenceId: b.sequence.id, startDate: '2026-11-02', status: 'ACTIVE', currentStep: 0, currentStepId: 's1', audience, createdAt: created } });
  const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action: 'EMAIL', label: 'Email 1', dueDate: due, dueAt: new Date(`${due}T09:00:00Z`), plannedDate: due, createdAt: created } });
  return { campaign, enrollment, task };
}

function graphOn(on = true) {
  if (on) process.env.GRAPH_MAIL_ENABLED = 'true'; else delete process.env.GRAPH_MAIL_ENABLED;
  resetEnvCache();
}

/** A stand-in for Microsoft Graph: pages by URL, every call recorded. */
function fakeGraph(answer: (url: string) => { status?: number; body: unknown }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const a = answer(url);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('W10: Outlook tracking and notifications', () => {
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    leader = await prisma.user.create({ data: { email: 'lena@cadence.local', name: 'Lena Lead', role: 'SALES_LEADER', passwordHash: 'x', pods: { create: [{ podId: b.pods.Alisa.id }] } } });
    graphOn(false);
  });
  afterEach(() => graphOn(false));

  describe('reading the mailboxes (N015, N088)', () => {
    it('N015: a first sync bigger than 50 pages keeps its place, finishes on a later run, and reads only from the day tracking started', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const { task } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id);
      const user = { id: b.users.alisa.id, microsoftId: 'alisa-ms' };
      const graph = fakeGraph((url) => {
        if (url.includes('$filter=')) return { body: { value: [sent(c.email!, 'A quick idea for your team', at(5))], '@odata.nextLink': 'https://graph.test/page/2' } };
        const n = Number(url.split('/page/')[1]);
        return n < 60 ? { body: { value: [], '@odata.nextLink': `https://graph.test/page/${n + 1}` } } : { body: { value: [], '@odata.deltaLink': 'https://graph.test/delta/1' } };
      });
      const s = stats();
      await syncFolder(user, 'sentitems', 'token', s, { fetchImpl: graph.fetchImpl, now: T0 });
      expect(graph.calls).toHaveLength(50);
      // The first read starts from the moment tracking ran for this folder: nothing older is read.
      expect(decodeURIComponent(graph.calls[0])).toContain(`receivedDateTime ge ${T0.toISOString()}`);
      let cursor = await prisma.mailboxCursor.findUniqueOrThrow({ where: { userId_folder: { userId: user.id, folder: 'sentitems' } } });
      expect(cursor).toEqual(expect.objectContaining({ nextLink: 'https://graph.test/page/51', deltaLink: null, startedAt: T0, lastSuccessAt: T0, error: null }));
      // Mail read on the first sync counts: it is all from after tracking started.
      expect(s.sent).toBe(1);
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('DONE');

      await syncFolder(user, 'sentitems', 'token', stats(), { fetchImpl: graph.fetchImpl, now: at(2) });
      expect(graph.calls[50]).toBe('https://graph.test/page/51');
      cursor = await prisma.mailboxCursor.findUniqueOrThrow({ where: { userId_folder: { userId: user.id, folder: 'sentitems' } } });
      expect(cursor).toEqual(expect.objectContaining({ nextLink: null, deltaLink: 'https://graph.test/delta/1', startedAt: T0 }));
    });

    it('N015: an expired sync link reads the folder again from an hour before the last good run, and says so', async () => {
      const user = { id: b.users.alisa.id, microsoftId: 'alisa-ms' };
      const good = new Date('2026-11-03T10:00:00Z');
      await prisma.mailboxCursor.create({ data: { userId: user.id, folder: 'inbox', deltaLink: 'https://graph.test/delta/old', startedAt: new Date('2026-11-01T00:00:00Z'), lastSuccessAt: good, lastRunAt: good } });
      const graph = fakeGraph((url) => (url.includes('/delta/old') ? { status: 410, body: { error: { code: 'SyncStateNotFound', message: 'The sync state generation is not found.' } } } : { body: { value: [], '@odata.deltaLink': 'https://graph.test/delta/new' } }));
      const s = stats();
      await syncFolder(user, 'inbox', 'token', s, { fetchImpl: graph.fetchImpl, now: T0 });
      expect(s.errors).toEqual([]);
      expect(s.resets).toBe(1);
      expect(decodeURIComponent(graph.calls[1])).toContain(`receivedDateTime ge ${new Date(good.getTime() - 3_600_000).toISOString()}`);
      expect(await prisma.mailboxCursor.findUniqueOrThrow({ where: { userId_folder: { userId: user.id, folder: 'inbox' } } })).toEqual(expect.objectContaining({ deltaLink: 'https://graph.test/delta/new', resetAt: T0, error: null, lastSuccessAt: T0 }));
    });

    it('N015: a mailbox that keeps failing shows amber with its error and since when, never a green "Read"', async () => {
      graphOn();
      await prisma.user.update({ where: { id: b.users.alisa.id }, data: { microsoftId: 'alisa-ms' } });
      const user = { id: b.users.alisa.id, microsoftId: 'alisa-ms' };
      const graph = fakeGraph(() => ({ status: 404, body: { error: { code: 'ErrorItemNotFound', message: 'The mailbox was not found.' } } }));
      await syncFolder(user, 'sentitems', 'token', stats(), { fetchImpl: graph.fetchImpl, now: T0 });
      await syncFolder(user, 'sentitems', 'token', stats(), { fetchImpl: graph.fetchImpl, now: at(2) });
      const state = await graphMailState(at(3));
      expect(state.failing).toBe(1);
      const alisa = state.mailboxes.find((m) => m.userId === b.users.alisa.id)!;
      expect(alisa.failing).toBe(true);
      expect(alisa.folders.find((f) => f.folder === 'sentitems')).toEqual(expect.objectContaining({ state: 'failing', errorAt: T0, lastRunAt: at(2), error: expect.stringContaining('ErrorItemNotFound') }));
      // A rep whose sent mail fails to read is told to click Done (N088).
      expect(await mailTrackedFor([b.users.alisa.id])).toEqual(new Set());
    });

    it('N088: Settings says why tracking is off, and email rows say whether they close themselves', async () => {
      const off = await graphMailState();
      expect(off).toEqual(expect.objectContaining({ enabled: false, why: TRACKING_OFF }));
      expect(await mailTrackedFor([b.users.alisa.id])).toEqual(new Set());
      expect(emailCloseWords(false)).toBe('Click Done after sending.');

      graphOn();
      await prisma.user.update({ where: { id: b.users.alisa.id }, data: { microsoftId: 'alisa-ms' } });
      await prisma.mailboxCursor.create({ data: { userId: b.users.alisa.id, folder: 'sentitems', deltaLink: 'https://graph.test/delta/1', startedAt: T0, lastSuccessAt: T0, lastRunAt: T0 } });
      const tracked = await mailTrackedFor([b.users.alisa.id, b.users.karson.id]);
      expect(tracked).toEqual(new Set([b.users.alisa.id]));
      expect(emailCloseWords(tracked.has(b.users.alisa.id))).toBe('Closes itself when you send from Outlook.');
      expect(emailCloseWords(tracked.has(b.users.karson.id))).toBe('Click Done after sending.');
      const on = await graphMailState();
      expect(on.mailboxes.find((m) => m.userId === b.users.karson.id)).toEqual(expect.objectContaining({ signedIn: false, failing: false }));
      expect(on.mailboxes.find((m) => m.userId === b.users.alisa.id)!.folders[0]).toEqual(expect.objectContaining({ folder: 'sentitems', state: 'in_step', lastSuccessAt: T0 }));
    });
  });

  describe('emails to people who must not be contacted (N016)', () => {
    it('N016: an email to an opted-out contact stores nothing, rings the rep and the pod leader, and is counted once', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      await optOutContact(c.id, { actor: SYSTEM_ACTOR, source: 'contact_page' });
      const m = sent(c.email!, 'Following up', at(0));
      const s = stats();
      await processSent(m, b.users.alisa.id, s);
      await processSent(m, b.users.alisa.id, stats());
      expect(s.alerts).toBe(1);
      expect(await prisma.sandboxEmail.count()).toBe(0);
      expect(await prisma.touch.count({ where: { sandboxContactId: c.id } })).toBe(0);
      const alerts = await prisma.notification.findMany({ where: { kind: 'compliance_alert' }, orderBy: { userId: 'asc' } });
      expect(alerts.map((n) => n.userId).sort()).toEqual([b.users.alisa.id, leader.id].sort());
      const text = String((alerts[0].payload as { text: string }).text);
      expect(text).toContain('asked not to be contacted');
      expect(text).not.toContain('Following up');
      expect(text).toContain(`${c.email!.slice(0, 1)}***@`);
      expect(await emailsToDoNotContact(new Date(0))).toBe(1);
    });

    it('N016: an email to a removed contact, known only by the hashes it kept, alerts too; a CRM person with the address may be emailed', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const email = c.email!;
      await removeContact(c.id, { actor: SYSTEM_ACTOR, reason: 'Not a fit' });
      expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).email).toBeNull();
      await processSent(sent(email, 'Hello again', at(0)), b.users.alisa.id, stats());
      expect(await prisma.notification.findFirst({ where: { kind: 'compliance_alert', userId: b.users.alisa.id, sandboxContactId: c.id } })).toEqual(expect.objectContaining({ payload: expect.objectContaining({ why: 'They were removed from Cold outreach.' }) }));

      await prisma.personCache.create({ data: { id: 'person-new', firstName: 'Sam', lastName: 'Rivera', email, emailNorm: email } });
      const s = stats();
      await processSent(sent(email, 'Welcome aboard', at(10)), b.users.alisa.id, s);
      expect(s.alerts).toBe(0);
    });

    it('N016: an email to an address on the suppression list (a CRM person who opted out) rings the rep and their pod leader', async () => {
      const person = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null } } });
      await addSuppressions([{ kind: 'email', value: person.email!.toLowerCase() }], { reason: 'opted_out', personId: person.id, source: 'person_page' });
      const s = stats();
      await processSent(sent(person.email!, 'Quarterly note', at(0)), b.users.alisa.id, s);
      expect(s.alerts).toBe(1);
      expect((await prisma.notification.findMany({ where: { kind: 'compliance_alert', personId: person.id } })).map((n) => n.userId).sort()).toEqual([b.users.alisa.id, leader.id].sort());
    });
  });

  describe('bounces (N058, N059, N060, N097)', () => {
    it('N058: a notice is matched only to email sent from the mailbox it came back to; matched by subject alone it is a possible bounce', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const out = sent(c.email!, 'One concrete example', at(0));
      await processSent(out, b.users.alisa.id, stats());
      // The same subject bounces in Andrew's mailbox, on a CRM thread: not Alisa's email.
      await processInbox(inbox('postmaster@acumen.example', 'Undeliverable: One concrete example', at(5), { conversationId: 'crm-thread' }), b.users.andrew.id, stats());
      let row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
      expect(row).toEqual(expect.objectContaining({ badEmail: false, possibleBounceAt: null }));

      // In Alisa's own mailbox, matched by subject only: possible, not bounced.
      const s = stats();
      await processInbox(inbox('postmaster@acumen.example', 'Undeliverable: One concrete example', at(6), { conversationId: 'unknown-thread' }), b.users.alisa.id, s);
      expect(s).toEqual(expect.objectContaining({ bounces: 0, possibleBounces: 1 }));
      row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
      expect(row).toEqual(expect.objectContaining({ badEmail: false, possibleBounceAt: at(6) }));
      expect(await prisma.sandboxEmail.count({ where: { kind: 'BOUNCE' } })).toBe(0);

      // Matched by its conversation: a bounce, and the possible one is settled.
      await processInbox(inbox('postmaster@acumen.example', 'Undeliverable: One concrete example', at(7), { conversationId: out.conversationId }), b.users.alisa.id, stats());
      row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
      expect(row).toEqual(expect.objectContaining({ badEmail: true, possibleBounceAt: null }));
      expect(await prisma.sandboxEmail.count({ where: { kind: 'BOUNCE', sandboxContactId: c.id, userId: b.users.alisa.id } })).toBe(1);
    });

    it('N059: delay notices and delivery receipts are not bounces; only a mail system saying it failed is', async () => {
      expect(systemNotice('microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@acumen.example', 'Delivery delayed: V25 intro one')).toBe('notice');
      expect(systemNotice('microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@acumen.example', 'Delivered: V25 intro two')).toBe('notice');
      expect(systemNotice('mailer-daemon@googlemail.com', 'Delivery Status Notification (Delay)')).toBe('notice');
      expect(systemNotice('postmaster@acumen.example', 'Relayed: hello')).toBe('notice');
      expect(systemNotice('mailer-daemon@googlemail.com', 'Delivery Status Notification (Failure)')).toBe('bounce');
      expect(systemNotice('postmaster@outlook.com', 'Undeliverable: hello')).toBe('bounce');
      // A person who writes "Undeliverable" in a subject is a person.
      expect(systemNotice('jane@client.example', 'Undeliverable: hello')).toBeNull();
      expect(originalSubject('Undeliverable: One concrete example')).toBe('One concrete example');

      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const out = sent(c.email!, 'V25 intro one', at(0));
      await processSent(out, b.users.alisa.id, stats());
      const s = stats();
      await processInbox(inbox('microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@acumen.example', 'Delivery delayed: V25 intro one', at(30), { conversationId: out.conversationId }), b.users.alisa.id, s);
      await processInbox(inbox('microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@acumen.example', 'Delivered: V25 intro one', at(31), { conversationId: out.conversationId }), b.users.alisa.id, s);
      expect(s).toEqual(expect.objectContaining({ bounces: 0, possibleBounces: 0, notices: 2, replies: 0 }));
      expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ badEmail: false, possibleBounceAt: null }));
    });

    it('N060: a bounce seen in the mailbox follows the "Email bounced" skip: the address is flagged, email steps skipped, the campaign ends', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const { enrollment, task } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id);
      const later = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId: b.users.alisa.id, stepIndex: 1, stepId: 's2', stepDay: 3, actionIndex: 0, actionId: 'a2', action: 'EMAIL', label: 'Email 2', dueDate: '2026-11-06', dueAt: new Date('2026-11-06T09:00:00Z'), plannedDate: '2026-11-06' } });
      const out = sent(c.email!, 'Email 1', at(0));
      await processSent(out, b.users.alisa.id, stats());
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('DONE');
      await processInbox(inbox('postmaster@acumen.example', 'Undeliverable: Email 1', at(3), { conversationId: out.conversationId }), b.users.alisa.id, stats());
      expect(await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).toEqual(expect.objectContaining({ status: 'EXITED', exitReason: 'bounced' }));
      expect((await prisma.task.findUniqueOrThrow({ where: { id: later.id } })).state).not.toBe('PENDING');
      expect(await prisma.task.count({ where: { enrollmentId: enrollment.id, state: 'PENDING' } })).toBe(0);
      expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).badEmail).toBe(true);
      // Bounces raise their own alert (N064).
      expect(await prisma.notification.findFirstOrThrow({ where: { kind: 'bounce', userId: b.users.alisa.id } })).toEqual(expect.objectContaining({ sandboxContactId: c.id, payload: expect.objectContaining({ text: expect.stringContaining('campaign ended') }) }));
    });

    it('N060: with "exit on bounce" off, a detected bounce skips the email steps and the campaign carries on, as the manual skip does', async () => {
      await saveSettingsSection('rules', { ...DEFAULT_SETTINGS.rules, exitOnBounce: false });
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const { enrollment, task } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id, '2026-11-09');
      // The step opens after this email, so the email does not close it.
      await prisma.task.update({ where: { id: task.id }, data: { createdAt: at(30) } });
      const out = sent(c.email!, 'Before the step', at(0));
      await processSent(out, b.users.alisa.id, stats());
      await processInbox(inbox('postmaster@acumen.example', 'Undeliverable: Before the step', at(3), { conversationId: out.conversationId }), b.users.alisa.id, stats());
      expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).exitReason).toBeNull();
      expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(expect.objectContaining({ state: 'SKIPPED', skipReason: 'Email bounced' }));
      expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).badEmail).toBe(true);
    });

    it('N097: a possible bounce is a field set once, shown as a chip, never a tag; the rep clears it or confirms it', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const { enrollment, task } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id, '2026-11-09');
      await prisma.task.update({ where: { id: task.id }, data: { createdAt: at(30) } });
      await processSent(sent(c.email!, 'V25 Template Z', at(0)), b.users.alisa.id, stats());
      await processInbox(inbox('postmaster@acumen.example', 'Undeliverable: V25 Template Z', at(5), { conversationId: 'x1' }), b.users.alisa.id, stats());
      await processInbox(inbox('postmaster@acumen.example', 'Undeliverable: V25 Template Z', at(9), { conversationId: 'x2' }), b.users.alisa.id, stats());
      let row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
      expect(row.possibleBounceAt).toEqual(at(5));
      expect(row.tags).not.toContain('bounce:check');
      expect(bounceWords(row)).toBe('Possible bounce');
      expect(await prisma.notification.count({ where: { kind: 'possible_bounce' } })).toBe(1);

      // Biz Ops may look, not change; the owner clears it.
      const bea = await prisma.user.create({ data: { email: 'bea@cadence.local', name: 'Bea Ops', role: 'BIZ_OPS', passwordHash: 'x' } });
      expect(await clearPossibleBounce(c.id, guard(bea, 'BIZ_OPS', []), userActor(bea))).toEqual(expect.objectContaining({ ok: false }));
      expect(await clearPossibleBounce(c.id, guard(b.users.alisa, 'SENIOR_FO', [b.pods.Alisa.id]), userActor(b.users.alisa))).toEqual({ ok: true, message: 'Cleared. The address stays as it is.' });
      row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
      expect(row).toEqual(expect.objectContaining({ possibleBounceAt: null, badEmail: false }));
      expect(await clearPossibleBounce(c.id, guard(b.users.alisa, 'SENIOR_FO', [b.pods.Alisa.id]), userActor(b.users.alisa))).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('settled it already') }));

      // Confirmed, it is the bounce rule (N060).
      await prisma.sandboxContact.update({ where: { id: c.id }, data: { possibleBounceAt: at(20) } });
      const r = await confirmPossibleBounce(c.id, guard(b.users.alisa, 'SENIOR_FO', [b.pods.Alisa.id]), userActor(b.users.alisa));
      expect(r).toEqual({ ok: true, message: 'Marked bounced. Their campaign ended.' });
      expect(await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).toEqual(expect.objectContaining({ badEmail: true, possibleBounceAt: null }));
      expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).exitReason).toBe('bounced');
      expect(await prisma.auditLog.count({ where: { entityId: c.id, action: { in: ['possible_bounce', 'possible_bounce_cleared', 'possible_bounce_confirmed'] } } })).toBe(3);
    });

    it('N097: the release turns old "bounce:check" tags into the field, once, and audits each', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { tags: ['vip', 'bounce:check', 'bounce:check'] });
      const sql = fs.readFileSync(path.join(process.cwd(), 'prisma/migrations/20261105400000_mail_tracking_state/migration.sql'), 'utf8');
      const block = sql.slice(sql.indexOf('DO $$'), sql.lastIndexOf('END $$;') + 'END $$;'.length);
      await prisma.$executeRawUnsafe(block);
      await prisma.$executeRawUnsafe(block);
      const row = await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } });
      expect(row.tags).toEqual(['vip']);
      expect(row.possibleBounceAt).not.toBeNull();
      expect(await prisma.auditLog.count({ where: { entityId: c.id, action: 'possible_bounce_backfill' } })).toBe(1);
    });
  });

  describe('replies and who hears of them (N064)', () => {
    it('N064: a cold reply rings the campaign\'s rep, the mailbox owner and the owner; an auto-reply rings nobody', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const { enrollment } = await inCampaign({ sandboxContactId: c.id }, b.users.karson.id, '2026-11-09');
      const s = stats();
      await processInbox(inbox(c.email!, 'Automatic reply: Out of office', at(0)), b.users.andrew.id, s);
      expect(s.autoReplies).toBe(1);
      expect(await prisma.notification.count()).toBe(0);
      expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('ACTIVE');

      await processInbox(inbox(c.email!, 'Re: A quick idea', at(10)), b.users.andrew.id, s);
      expect(s.replies).toBe(1);
      expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('REPLIED');
      const told = await prisma.notification.findMany({ where: { kind: 'reply', sandboxContactId: c.id } });
      expect(told.map((n) => n.userId).sort()).toEqual([b.users.alisa.id, b.users.andrew.id, b.users.karson.id].sort());
      // The touch is stamped Cold outreach and counts as one reply there, none in the CRM.
      const touches = await prisma.touch.findMany({ where: { sandboxContactId: c.id } });
      expect(touches.every((t) => t.audience === 'SANDBOX')).toBe(true);
      const period = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-08T00:00:00Z') };
      expect(await replyCount({ kind: 'all' }, 'cold', period)).toBe(1);
      expect(await replyCount({ kind: 'all' }, 'crm', period)).toBe(0);
    });

    it('N064: an unclaimed contact\'s reply rings the pod\'s leaders, and a CRM auto-reply no longer rings the bell', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { ownerId: null, claimedAt: null });
      await processInbox(inbox(c.email!, 'Re: hello', at(0)), b.users.alisa.id, stats());
      expect((await prisma.notification.findMany({ where: { kind: 'reply' } })).map((n) => n.userId).sort()).toEqual([b.users.alisa.id, leader.id].sort());

      const { unreadNotifications } = await import('@/lib/notifications');
      const person = await prisma.personCache.findFirstOrThrow({ where: { ownerMemberId: 'wm-alisa' } });
      const me = { id: b.users.alisa.id, twentyMemberId: 'wm-alisa' };
      const before = await unreadNotifications(me);
      await prisma.touch.create({ data: { personId: person.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: at(1), summary: 'Auto-reply: Out of office', externalId: 'message:ooo:person', audience: 'CRM' } });
      expect(await unreadNotifications(me)).toBe(before);
      await prisma.touch.create({ data: { personId: person.id, channel: 'EMAIL', direction: 'INBOUND', occurredAt: at(2), summary: 'Reply: Sounds good', externalId: 'message:yes:person', audience: 'CRM' } });
      expect(await unreadNotifications(me)).toBe(before + 1);
    });
  });

  describe('closing Email next steps (N098)', () => {
    it('N098: an email closes the Email next step by the rep\'s own day, not UTC\'s, and the close is logged', async () => {
      await prisma.user.update({ where: { id: b.users.alisa.id }, data: { timezone: 'America/Chicago' } });
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      const na = await prisma.nextAction.create({ data: { sandboxContactId: c.id, foUserId: b.users.alisa.id, label: 'Send the deck', action: 'EMAIL', dueDate: '2026-11-04', audience: 'SANDBOX', createdAt: new Date('2026-11-01T12:00:00Z') } });
      // 19:30 on 3 Nov in Chicago is 01:30 on 4 Nov in UTC: not the day the step is due.
      await processSent(sent(c.email!, 'Evening note', new Date('2026-11-04T01:30:00Z')), b.users.alisa.id, stats());
      expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: na.id } })).state).toBe('OPEN');
      await processSent(sent(c.email!, 'The deck', new Date('2026-11-04T16:00:00Z')), b.users.alisa.id, stats());
      expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: na.id } })).state).toBe('DONE');
      expect(await prisma.auditLog.findFirstOrThrow({ where: { action: 'next_action_auto_closed', entityId: c.id } })).toEqual(expect.objectContaining({ details: expect.objectContaining({ dueDate: '2026-11-04', emailDay: '2026-11-04' }) }));
    });

    it('N098: a CRM person\'s Email next step closes by the same rule when the CRM\'s mail sync sees the email', async () => {
      await prisma.user.update({ where: { id: b.users.alisa.id }, data: { timezone: 'America/Chicago' } });
      const person = await prisma.personCache.findFirstOrThrow({ where: { email: { not: null } } });
      const na = await prisma.nextAction.create({ data: { personId: person.id, foUserId: b.users.alisa.id, label: 'Send the deck', action: 'EMAIL', dueDate: '2026-11-04', audience: 'CRM', createdAt: new Date('2026-11-01T12:00:00Z') } });
      const mock = getMockTwentyClient();
      const early = mock.addMessage({ subject: 'Evening note', receivedAt: '2026-11-04T01:30:00.000Z', from: { handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }, to: [{ handle: person.email!, personId: person.id }] });
      await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(early), now: new Date('2026-11-04T01:31:00Z') });
      expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: na.id } })).state).toBe('OPEN');
      const msg = mock.addMessage({ subject: 'The deck', receivedAt: '2026-11-04T16:00:00.000Z', from: { handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }, to: [{ handle: person.email!, personId: person.id }] });
      await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(msg), now: new Date('2026-11-04T16:01:00Z') });
      expect((await prisma.nextAction.findUniqueOrThrow({ where: { id: na.id } })).state).toBe('DONE');
      expect(await prisma.auditLog.count({ where: { action: 'next_action_auto_closed', entityId: person.id } })).toBe(1);
    });
  });

  describe('the CRM\'s mail sync while tracking is off (N028)', () => {
    it('N028: a cold contact\'s email and reply in the CRM\'s mail are the contact\'s: the step closes, the campaign stops, the rep hears, and the person Twenty made gets nothing', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { createdAt: new Date('2026-11-01T09:00:00Z') });
      const { enrollment, task } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id);
      // Twenty's mail sync made a person for the address, after the contact was pushed.
      await prisma.personCache.create({ data: { id: 'person-auto-1', firstName: c.firstName, lastName: c.lastName, email: c.email, emailNorm: c.email, createdBySource: 'EMAIL', raw: { createdAt: '2026-11-04T15:00:30.000Z' } } });
      const mock = getMockTwentyClient();
      const out = mock.addMessage({ subject: 'A quick idea for your team', receivedAt: T0.toISOString(), from: { handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }, to: [{ handle: c.email!, personId: 'person-auto-1' }] });
      const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(out), now: at(1) });
      expect(r.result).toBe('message_outbound_cold');
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('DONE');
      expect(await prisma.touch.count({ where: { personId: 'person-auto-1' } })).toBe(0);
      expect(await prisma.touch.findFirstOrThrow({ where: { sandboxContactId: c.id, direction: 'OUTBOUND' } })).toEqual(expect.objectContaining({ audience: 'SANDBOX', actorUserId: b.users.alisa.id }));

      // Outlook tracking sees the same email: it is one email, recorded once.
      await processSent(sent(c.email!, 'A quick idea for your team', at(0)), b.users.alisa.id, stats());
      expect(await prisma.sandboxEmail.count({ where: { sandboxContactId: c.id, kind: 'SENT' } })).toBe(1);
      expect(await prisma.touch.count({ where: { sandboxContactId: c.id, direction: 'OUTBOUND' } })).toBe(1);

      const reply = mock.addMessage({ subject: 'Re: A quick idea for your team', receivedAt: at(60).toISOString(), from: { handle: c.email!, personId: 'person-auto-1' }, to: [{ handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }] });
      const r2 = await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(reply), now: at(61) });
      expect(r2.result).toBe('inbound_cold_reply');
      expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('REPLIED');
      expect(await prisma.notification.findFirstOrThrow({ where: { kind: 'reply', userId: b.users.alisa.id } })).toEqual(expect.objectContaining({ sandboxContactId: c.id }));
      expect(await prisma.touch.count({ where: { personId: 'person-auto-1' } })).toBe(0);
    });

    it('N028: an email and its reply read in one sync run: the email closes its step first, then the reply ends the campaign', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { createdAt: new Date('2026-11-01T09:00:00Z') });
      const { enrollment, task } = await inCampaign({ sandboxContactId: c.id }, b.users.alisa.id);
      await prisma.personCache.create({ data: { id: 'person-auto-2', firstName: c.firstName, lastName: c.lastName, email: c.email, emailNorm: c.email, createdBySource: 'EMAIL', raw: { createdAt: '2026-11-04T15:00:30.000Z' } } });
      const mock = getMockTwentyClient();
      // The CRM lists its mail newest first: the reply comes before the email in the listing.
      mock.addMessage({ subject: 'A quick idea for your team', receivedAt: T0.toISOString(), from: { handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }, to: [{ handle: c.email!, personId: 'person-auto-2' }] });
      mock.addMessage({ subject: 'Re: A quick idea for your team', receivedAt: at(60).toISOString(), from: { handle: c.email!, personId: 'person-auto-2' }, to: [{ handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }] });
      await reconcile({ only: ['messages'], since: '2026-11-01T00:00:00Z', now: at(61) }, mock);
      expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('DONE');
      expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('REPLIED');
      expect(await prisma.sandboxEmail.count({ where: { sandboxContactId: c.id, kind: 'SENT' } })).toBe(1);
    });

    it('N028: a real CRM person with the address keeps the CRM\'s behaviour', async () => {
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id);
      await prisma.personCache.create({ data: { id: 'person-real-1', firstName: 'Sam', lastName: 'Rivera', email: c.email, emailNorm: c.email, createdBySource: 'MANUAL' } });
      const mock = getMockTwentyClient();
      const out = mock.addMessage({ subject: 'Hello', receivedAt: T0.toISOString(), from: { handle: 'alisa@cadence.local', workspaceMemberId: 'wm-alisa' }, to: [{ handle: c.email!, personId: 'person-real-1' }] });
      const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(out), now: at(1) });
      expect(r.result).toBe('message_outbound_touch');
      expect(await prisma.touch.count({ where: { personId: 'person-real-1' } })).toBe(1);
      expect(await prisma.sandboxEmail.count()).toBe(0);
    });
  });
});
