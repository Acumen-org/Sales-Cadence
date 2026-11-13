import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Role } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { SessionUser } from '@/lib/auth/current-user';
import { FakeTwilio } from '@/lib/calls/fake-twilio';
import { importTwilioCalls, STATUS_KEY, WATERMARK_KEY } from '@/lib/calls/import';
import { logManualCall, pendingForms, submitCallForm, validateCallForm } from '@/lib/calls/form';
import { zonedInstant } from '@/lib/calls/words';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { discardCall } from '@/lib/calls/form-context';
import { unreadCallBlock, UNREAD_CALL } from '@/lib/calls/gate';
import { costlyNumber } from '@/lib/calls/hours';
import { CALL_TO_DO_NOT_CONTACT } from '@/lib/calls/call-log';
import { TwilioRestReader, getTwilioReader } from '@/lib/calls/twilio';
import { completeCall } from '@/lib/engine/outcomes';
import { addSuppressions } from '@/lib/sandbox/suppression';
import { scrub } from '@/lib/outreach/scrub';
import { resetEnvCache } from '@/lib/env';
import { userActor } from '@/lib/audit';
import { MOCK_PEOPLE } from '@/lib/twenty/fixtures';
import { toE164 } from '@/lib/sandbox/normalize';
import { addCallContactAction, assignCallRepAction, attachCallContactAction, logManualCallAction, recordCallIntentAction } from '@/lib/actions/call-forms';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { readyContact } from './helpers/sandbox';

/** Fixes from the 12 Nov audit of calls (12-cadence-calls.md), one check per finding. */

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock('@/lib/auth/current-user', () => ({ requireUser: auth.requireUser, requireAdmin: auth.requireUser, getCurrentUser: auth.requireUser, toActor: (u: SessionUser) => ({ id: u.id, role: u.role, podIds: u.podIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
const { CallButton } = await import('@/components/calls/call-button');

const ALISA_LINE = '+13125550100';
const T0 = new Date('2026-11-03T15:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const iso = (min: number) => at(min).toISOString();
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v); return fd; };

let b: Basics;
let fake: FakeTwilio;
const session = (u: Basics['users']['alisa'], podIds: string[] = []): SessionUser => ({ ...u, podIds, pods: podIds.map((id) => ({ id, name: id })) });
const alisa = () => ({ id: b.users.alisa.id, name: b.users.alisa.name, timezone: 'Europe/London', role: 'SENIOR_FO' as Role, podIds: [b.pods.Alisa.id] });

describe('calls: audit fixes of 12 Nov', () => {
  beforeEach(async () => {
    await resetDb();
    b = await seedBasics();
    fake = new FakeTwilio();
    await prisma.user.update({ where: { id: b.users.alisa.id }, data: { callerNumber: ALISA_LINE } });
    auth.requireUser.mockResolvedValue(session(b.users.alisa, [b.pods.Alisa.id]));
    await importTwilioCalls({ reader: fake, now: T0 });
  });

  it('M04: "Asked not to be contacted" opts the person out even when the save fails after', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550184', phoneType: 'direct' });
    const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id }, at(1));
    // The form's own save fails (the claim of the call row); every other write goes through.
    const real = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, ...rest: unknown[]) => (typeof fn === 'function' && String(fn).includes('callForm.create') ? Promise.reject(new Error('database went away')) : (real as (...a: unknown[]) => unknown)(fn, ...rest))) as never);
    await expect(submitCallForm(call.id, { outcome: 'do_not_contact', rating: 1, notes: 'Stop calling', nextStep: 'none' }, alisa(), at(2))).rejects.toThrow('database went away');
    spy.mockRestore();
    expect((await prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('OPTED_OUT');
  });

  it('M05, M50: the Call button holds no link to the dialpad, so only its click (and the server check) opens it', () => {
    const html = renderToStaticMarkup(createElement(CallButton, { phone: '+13125550100', template: 'https://dialpad.example/admin/dialpad?to={phone}' }));
    expect(html).not.toContain('href=');
    expect(html).toContain('<button');
  });

  it('M06: while the import is failing, a rep\'s Call press with no call read back blocks the next call until it is logged', async () => {
    for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET']) process.env[k] = 'x';
    resetEnvCache();
    try {
      const now = new Date();
      await prisma.setting.upsert({ where: { key: STATUS_KEY }, create: { key: STATUS_KEY, value: { at: now.toISOString(), error: 'Twilio answered 503', failedInARow: 2 } }, update: { value: { at: now.toISOString(), error: 'Twilio answered 503', failedInARow: 2 } } });
      expect(await unreadCallBlock(b.users.alisa.id, now)).toBeNull();
      const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550185', phoneType: 'direct' });
      await prisma.callIntent.create({ data: { userId: b.users.alisa.id, toNumber: '+13125550185', sandboxContactId: c.id, createdAt: new Date(now.getTime() - 5 * 60_000) } });
      expect(await unreadCallBlock(b.users.alisa.id, now)).toBe(UNREAD_CALL);
      const logged = await logManualCallAction(form({ sandboxContactId: c.id, startedAt: '', direction: 'OUTBOUND' }));
      expect(logged.ok).toBe(true);
      expect(await unreadCallBlock(b.users.alisa.id, now)).toBeNull();
    } finally {
      for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET']) delete process.env[k];
      resetEnvCache();
    }
  });

  it('M07: a call from the dialpad to a suppressed number nobody holds is counted and the rep is told', async () => {
    await addSuppressions([{ kind: 'phone', value: '+13125550177' }], { reason: 'do_not_contact', source: 'suppression_list' });
    const call = fake.addCall({ from: ALISA_LINE, to: '+13125550177', startTime: iso(1), endTime: iso(2), durationSec: 30 });
    await importTwilioCalls({ reader: fake, now: at(3) });
    await importTwilioCalls({ reader: fake, now: at(5) });
    const row = await prisma.callLog.findUniqueOrThrow({ where: { twilioCallSid: call.sid } });
    expect(await prisma.auditLog.count({ where: { action: CALL_TO_DO_NOT_CONTACT, entityId: row.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: b.users.alisa.id, kind: 'compliance_alert' } })).toBe(1);
  });

  it('M08: erasing a contact takes its recordings out of Cadence and names them for Twilio', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550186', phoneType: 'direct' });
    const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
    await prisma.callLog.update({ where: { id: call.id }, data: { recordingSid: 'RE1', recordingStatus: 'found' } });
    const r = await prisma.$transaction((tx) => scrub(tx, { id: c.id, phone: '+13125550186' }));
    expect(r.recordings).toEqual(['RE1']);
    expect(await prisma.callLog.findUniqueOrThrow({ where: { id: call.id } })).toEqual(expect.objectContaining({ recordingSid: null, recordingStatus: 'erased' }));
  });

  it('M09: a call logged by hand is never taken for a later dialpad call to the same person', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550176', phoneType: 'direct' });
    const logged = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id, startedAt: at(1), talkSec: 60 }, at(2));
    await prisma.callLog.update({ where: { id: logged.id }, data: { createdAt: at(2) } });
    fake.addCall({ from: ALISA_LINE, to: '+13125550176', startTime: iso(10), endTime: iso(12), durationSec: 110 });
    await importTwilioCalls({ reader: fake, now: at(13) });
    expect(await prisma.callLog.count()).toBe(2);
    expect((await prisma.callLog.findUniqueOrThrow({ where: { id: logged.id } })).talkSec).toBe(60);
  });

  it('M11, M12: an incoming call is answered only if a dialpad leg was, and that leg names the rep', async () => {
    const person = MOCK_PEOPLE[4];
    const missed = fake.addCall({ from: person.phone!, to: '+13125550900', direction: 'inbound', startTime: iso(1), endTime: iso(2), durationSec: 40 });
    fake.addCall({ from: '+13125550900', to: 'client:tw_karson', direction: 'outbound-dial', parentCallSid: missed.sid, status: 'no-answer', startTime: iso(1), endTime: iso(2), durationSec: 0 });
    const answered = fake.addCall({ from: person.phone!, to: '+13125550900', direction: 'inbound', startTime: iso(5), endTime: iso(9), durationSec: 240 });
    fake.addCall({ from: '+13125550900', to: 'client:tw_karson', direction: 'outbound-dial', parentCallSid: answered.sid, startTime: iso(5), endTime: iso(9), durationSec: 230 });
    await importTwilioCalls({ reader: fake, now: at(10) });
    expect(await prisma.callLog.findUniqueOrThrow({ where: { twilioCallSid: missed.sid } })).toEqual(expect.objectContaining({ talkSec: 0, formDueAt: null }));
    expect(await prisma.callLog.findUniqueOrThrow({ where: { twilioCallSid: answered.sid } })).toEqual(expect.objectContaining({ talkSec: 230, userId: b.users.karson.id, repMatchedBy: 'alias', formDueAt: expect.any(Date) }));
  });

  it('M13: a discarded call read again by the import stays off the timeline', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550166', phoneType: 'direct' });
    const call = fake.addCall({ from: ALISA_LINE, to: '+13125550166', startTime: iso(1), endTime: iso(2), durationSec: 20 });
    await importTwilioCalls({ reader: fake, now: at(3) });
    const row = await prisma.callLog.findUniqueOrThrow({ where: { twilioCallSid: call.sid } });
    expect((await discardCall(row.id, 'Dialled by mistake', { id: b.users.alisa.id, role: 'SENIOR_FO', podIds: [b.pods.Alisa.id] } as never, userActor(b.users.alisa), at(4))).ok).toBe(true);
    await importTwilioCalls({ reader: fake, now: at(5) });
    expect(await prisma.touch.count({ where: { sandboxContactId: c.id, channel: 'CALL' } })).toBe(0);
  });

  it('M14: a leader can neither give a matched call to another rep nor move it to another person', async () => {
    const c = await readyContact(b.users.alisa.id, b.pods.Alisa.id, { phone: '+13125550167', phoneType: 'direct' });
    const call = await logManualCall({ userId: b.users.alisa.id, sandboxContactId: c.id });
    auth.requireUser.mockResolvedValue(session(b.users.leigh, [b.pods.Leigh.id]));
    expect(await assignCallRepAction(form({ callId: call.id, userId: b.users.leigh.id }))).toEqual(expect.objectContaining({ ok: false }));
    expect(await attachCallContactAction(form({ callId: call.id, contact: `person:${MOCK_PEOPLE[1].id}` }))).toEqual(expect.objectContaining({ ok: false }));
    expect(await prisma.callLog.findUniqueOrThrow({ where: { id: call.id } })).toEqual(expect.objectContaining({ userId: b.users.alisa.id, sandboxContactId: c.id }));
  });

  it('M15, M42: "Add someone new" refuses another rep\'s call, and a hidden caller\'s number, before creating anyone', async () => {
    const theirs = await prisma.callLog.create({ data: { source: 'TWILIO_IMPORT', direction: 'OUTBOUND', status: 'COMPLETED', statusRank: 4, userId: b.users.karson.id, toNumber: '+13125550168', matchedBy: 'none', formDueAt: new Date() } });
    const before = await prisma.sandboxContact.count();
    expect(await addCallContactAction(form({ callId: theirs.id, firstName: 'Ann', lastName: 'Other' }))).toEqual(expect.objectContaining({ ok: false }));
    const hidden = await prisma.callLog.create({ data: { source: 'TWILIO_IMPORT', direction: 'INBOUND', status: 'COMPLETED', statusRank: 4, userId: b.users.alisa.id, fromNumber: '+266696687', matchedBy: 'none', formDueAt: new Date() } });
    expect(await addCallContactAction(form({ callId: hidden.id, firstName: 'Ann', lastName: 'Hidden' }))).toEqual(expect.objectContaining({ ok: false }));
    expect(await prisma.sandboxContact.count()).toBe(before);
  });

  it('M17: an answered call is read again until Twilio has priced it', async () => {
    const call = fake.addCall({ from: ALISA_LINE, to: '+13125550169', startTime: iso(1), endTime: iso(20), durationSec: 1100, price: null as unknown as number });
    fake.updateCall(call.sid, { price: null });
    await importTwilioCalls({ reader: fake, now: at(21) });
    fake.updateCall(call.sid, { price: -0.35 });
    // The call has left the listing's overlap by now; only the price re-read finds it.
    await importTwilioCalls({ reader: fake, now: at(60) });
    expect(Number((await prisma.callLog.findUniqueOrThrow({ where: { twilioCallSid: call.sid } })).priceUsd)).toBeCloseTo(0.35);
  });

  it('M20, M27: a 404 on the list of calls is an error, and a 429 is asked again', async () => {
    const answers = [new Response('{}', { status: 429, headers: { 'retry-after': '0' } }), new Response(JSON.stringify({ calls: [], next_page_uri: null }), { status: 200 }), new Response('{}', { status: 404 })];
    const reader = new TwilioRestReader({ accountSid: 'AC1', keySid: 'SK1', keySecret: 's', baseUrl: 'https://twilio.test', fetchImpl: (async () => answers.shift()!) as typeof fetch });
    expect((await reader.listCalls({ after: T0 })).calls).toEqual([]);
    await expect(reader.listCalls({ after: T0 })).rejects.toThrow(/404/);
  });

  it('M21: a long backlog is read a day at a time, oldest first, and the bookmark moves only as far as was read', async () => {
    const old = fake.addCall({ from: ALISA_LINE, to: '+13125550170', startTime: iso(60), endTime: iso(61), durationSec: 30 });
    const late = at(3 * 24 * 60);
    await importTwilioCalls({ reader: fake, now: late });
    expect(await prisma.callLog.count({ where: { twilioCallSid: old.sid } })).toBe(1);
    const mark = Date.parse(((await prisma.setting.findUniqueOrThrow({ where: { key: WATERMARK_KEY } })).value as { at: string }).at);
    expect(mark).toBeLessThan(late.getTime());
  });

  it('M22: the test Twilio never stands in for a real account that is configured', () => {
    process.env.CADENCE_FAKE_TWILIO = '1';
    process.env.TWILIO_ACCOUNT_SID = 'AC1';
    resetEnvCache();
    try {
      expect(() => getTwilioReader()).toThrow(/real TWILIO_\* keys/);
    } finally {
      delete process.env.CADENCE_FAKE_TWILIO;
      delete process.env.TWILIO_ACCOUNT_SID;
      resetEnvCache();
    }
  });

  it('M23: premium-rate numbers are refused and dear destinations asked about', async () => {
    expect(costlyNumber('+19005550100').block).toMatch(/premium-rate/);
    expect(costlyNumber('+18765550100').ask).toMatch(/international rates/);
    expect(costlyNumber('+442071234567').ask).toMatch(/outside the US/);
    expect(costlyNumber('+13125550100')).toEqual({ block: null, ask: null });
    expect(await recordCallIntentAction({ phone: '+19005550100' })).toEqual(expect.objectContaining({ ok: false }));
  });

  it('M24: a dialpad session\'s recording is not given to each of its calls', async () => {
    const session1 = fake.addCall({ from: 'client:tw_alisa', to: '+13125550171', direction: 'inbound', startTime: iso(1), endTime: iso(9), durationSec: 480 });
    fake.addCall({ from: ALISA_LINE, to: '+13125550171', parentCallSid: session1.sid, startTime: iso(1), endTime: iso(4), durationSec: 150 });
    fake.addCall({ from: ALISA_LINE, to: '+13125550172', parentCallSid: session1.sid, startTime: iso(5), endTime: iso(9), durationSec: 200 });
    fake.addRecording(session1.sid, 470);
    await importTwilioCalls({ reader: fake, now: at(10) });
    expect(await prisma.callLog.count({ where: { recordingSid: { not: null } } })).toBe(0);
  });

  it('M33, M46: an unanswered outcome keeps no rating, and notes too long are refused, not cut', () => {
    const ctx = { rules: DEFAULT_SETTINGS.rules, today: '2026-11-03' as never };
    expect(validateCallForm({ outcome: 'no_answer', rating: 4, nextStep: 'none' }, ctx)).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ rating: null }) }));
    expect(validateCallForm({ outcome: 'no_answer', notes: 'x'.repeat(10_001), nextStep: 'none' }, ctx)).toEqual(expect.objectContaining({ ok: false, field: 'notes' }));
  });

  it('M34: a time typed just after the clock goes back is the right hour', () => {
    expect(zonedInstant('2026-11-01', '03:00', 'America/New_York')?.toISOString()).toBe('2026-11-01T08:00:00.000Z');
    expect(zonedInstant('2026-03-08', '03:30', 'America/New_York')?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('M25: a call first read in progress still joins the CRM\'s quick Log call when it ends', async () => {
    const person = MOCK_PEOPLE[7];
    const campaign = await prisma.campaign.create({ data: { name: 'Q4', audience: 'CRM', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, personIds: [person.id], startDate: '2026-11-02', status: 'ACTIVE' } });
    const enrollment = await prisma.enrollment.create({ data: { personId: person.id, foUserId: b.users.alisa.id, podId: b.pods.Alisa.id, campaignId: campaign.id, sequenceId: b.sequence.id, startDate: '2026-11-02', status: 'ACTIVE', currentStep: 0, currentStepId: 's1', audience: 'CRM' } });
    const task = await prisma.task.create({ data: { enrollmentId: enrollment.id, foUserId: b.users.alisa.id, stepIndex: 0, stepId: 's1', stepDay: 1, actionIndex: 0, actionId: 'a1', action: 'CALL', label: 'Call 1', dueDate: '2026-11-03', dueAt: new Date('2026-11-03T09:00:00Z'), plannedDate: '2026-11-03' } });
    const call = fake.addCall({ from: ALISA_LINE, to: person.phone!, status: 'in-progress', startTime: iso(1), endTime: null, durationSec: null });
    await importTwilioCalls({ reader: fake, now: at(2) });
    await completeCall({ taskId: task.id, disposition: 'connected', note: 'Logged in Tasks' }, { actor: userActor(b.users.alisa), now: at(4) });
    fake.updateCall(call.sid, { status: 'completed', endTime: iso(3), durationSec: 120 });
    await importTwilioCalls({ reader: fake, now: at(5) });
    expect(await prisma.callLog.findUniqueOrThrow({ where: { twilioCallSid: call.sid } })).toEqual(expect.objectContaining({ taskId: task.id, formDoneAt: expect.any(Date) }));
    expect(await pendingForms(b.users.alisa.id)).toHaveLength(0);
    expect(toE164(person.phone)).toBeTruthy();
  });
});
