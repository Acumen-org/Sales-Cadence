import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import { resetDb, seedBasics, type Basics } from './helpers/db';
import { previewCampaignCalendar, saveCampaignCalendar } from '@/lib/campaign-planning-service';
import type { CampaignDraft } from '@/lib/campaign-planner';
import type { SessionUser } from '@/lib/auth/current-user';
import { activateCampaign, changeCampaignStatus } from '@/lib/engine/campaigns';
import { advanceEnrollment, completeTask, runSchedulerTick } from '@/lib/engine/tasks';
import { ingestEvent } from '@/lib/engine/ingest';
import { rawFromMessage, rawFromNote } from '@/lib/engine/reconcile';
import { completeFromEarlierEvidence, subjectKey } from '@/lib/engine/observed-evidence';
import { SYSTEM_ACTOR, userActor } from '@/lib/audit';
import { getSettings, saveSettingsSection } from '@/lib/settings';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';

const asUser = (user: User): SessionUser => ({ ...user, podIds: [], pods: [] });
// Monday 4 to Friday 8 January 2027, in Chicago.
const on = (day: string, time = '16:00:00') => new Date(`2027-01-${day}T${time}Z`);
const ctx = (day: string, time?: string) => ({ actor: SYSTEM_ACTOR, now: on(day, time), skipSync: true });

/**
 * What the hosted campaign showed on 24 September 2026: the FOs (Alyssa, Avani) are copied in
 * while Alisa sends from her own mailbox, emails go out before a person's step opens, and a tool
 * logs each email as a note that no Cadence user wrote. Every one of those is the step happening.
 */
describe('emails and calls close the step they belong to', () => {
  let b: Basics, campaignId: string;
  const mock = getMockTwentyClient();
  const PEOPLE = ['person-05', 'person-06', 'person-07', 'person-08'];

  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    const s = await getSettings();
    await saveSettingsSection('rules', { ...s.rules, internalDomains: ['prairie-hill.com'] });
    await prisma.personCache.updateMany({ where: { id: { in: PEOPLE } }, data: { ownerMemberId: b.users.karson.twentyMemberId, podOwner: 'ALISA', dnd: false, optedOut: false } });
    // Two emails a day apart, one a day to start: batches start Monday to Thursday.
    const d: CampaignDraft = { name: 'Webinar follow-up', podId: b.pods.Alisa.id, startDate: '2027-01-04', endDate: '2027-01-08', productInterest: ['PHH'], defaultBatchSize: 1, fos: [{ id: b.users.karson.id, batchSize: 1 }], personIds: PEOPLE, assignments: {}, flows: [{ id: 'default', name: 'Default', steps: [{ id: 'first', day: 1, actions: [{ id: 'email', type: 'EMAIL', label: 'Email 1', template: 'Hi {{firstName}}' }] }, { id: 'second', day: 2, actions: [{ id: 'email2', type: 'EMAIL', label: 'Email 2' }] }] }] };
    const admin = asUser(b.users.ria);
    const p = await previewCampaignCalendar(d, admin);
    expect(p.calendar.valid).toBe(true);
    campaignId = (await saveCampaignCalendar(d, admin, { publish: true, fingerprint: p.fingerprint })).id;
    await activateCampaign(campaignId, { actor: SYSTEM_ACTOR, now: on('04', '12:00:00'), skipSync: true });
  });

  const enrollment = (personId: string) => prisma.enrollment.findFirstOrThrow({ where: { campaignId, personId }, include: { tasks: { orderBy: { stepIndex: 'asc' } } } });
  const firstDay = async () => (await prisma.enrollment.findFirstOrThrow({ where: { campaignId, startDate: '2027-01-04' } })).personId;
  const laterDay = async () => (await prisma.enrollment.findFirstOrThrow({ where: { campaignId, startDate: { gt: '2027-01-05' } } }));
  const email = (personId: string, from: { handle: string; workspaceMemberId?: string | null }, subject: string, receivedAt: Date, cc: { handle: string; workspaceMemberId?: string | null }[] = []) => {
    const m = mock.addMessage({ subject, receivedAt: receivedAt.toISOString(), from: { ...from, personId: null }, to: [{ handle: `${personId}@prospect.example`, personId }, ...cc.map((c) => ({ ...c, role: 'cc' as const }))] });
    return ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(m), now: receivedAt, skipSync: true });
  };
  const note = (personId: string, title: string, createdAt: Date, createdByMemberId: string | null = null) => {
    const n = mock.addNote({ title, personIds: [personId], createdByMemberId, createdByName: createdByMemberId ? null : 'crm-sales-glynac', createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString() });
    return ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: rawFromNote(n), now: createdAt, skipSync: true });
  };

  it('closes the FO’s email when a colleague sends it from their own mailbox, with the FO copied', async () => {
    const personId = await firstDay();
    const r = await email(personId, { handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId }, 'Alisa and Bruce connect', on('04', '15:00:00'), [{ handle: 'karson@cadence.local', workspaceMemberId: b.users.karson.twentyMemberId }]);
    expect(r.result).toBe('message_outbound_completed');
    const e = await enrollment(personId);
    expect(e.tasks[0]).toEqual(expect.objectContaining({ state: 'DONE', completionSource: 'OBSERVED_MESSAGE', foUserId: b.users.karson.id }));
    // The timeline says who sent it.
    expect(await prisma.touch.findFirstOrThrow({ where: { personId, direction: 'OUTBOUND' } })).toEqual(expect.objectContaining({ actorUserId: b.users.alisa.id, summary: 'Email sent: Alisa and Bruce connect' }));
  });

  it('counts a colleague at one of our domains who has no Cadence login, and never reads them as a reply', async () => {
    const personId = await firstDay();
    const r = await email(personId, { handle: 'smilliman@prairie-hill.com' }, 'Wheeling update', on('04', '15:00:00'));
    expect(r.result).toBe('message_outbound_completed');
    const e = await enrollment(personId);
    expect(e.status).toBe('ACTIVE');
    expect(e.tasks[0].state).toBe('DONE');
    expect(await prisma.touch.findFirstOrThrow({ where: { personId, direction: 'OUTBOUND' } })).toEqual(expect.objectContaining({ actorUserId: null, actorLabel: 'smilliman@prairie-hill.com' }));
    expect(await prisma.touch.count({ where: { personId, direction: 'INBOUND' } })).toBe(0);
  });

  it('leaves a step that opens after an email as work: the email was not that step', async () => {
    const later = await laterDay();
    expect(later.currentStep).toBe(-1);
    const r = await email(later.personId, { handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId }, 'Re: Alisa and Roman connect on PHH', on('04', '15:00:00'));
    expect(r).toEqual(expect.objectContaining({ result: 'message_outbound_touch', details: { [later.personId]: 'no_pending_task' } }));
    // Its first day: the step opens as work, and the scheduler does not close it from the earlier email.
    const opened = await advanceEnrollment(later.id, ctx(later.startDate.slice(8), '06:00:00'));
    expect(opened.outcome).toBe('generated');
    await runSchedulerTick(ctx(later.startDate.slice(8), '07:00:00'));
    const e = await enrollment(later.personId);
    expect(e.tasks.map((t) => t.state)).toEqual(['PENDING']);
    // An email once it is open closes it.
    await email(later.personId, { handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId }, 'Following up', on(later.startDate.slice(8), '15:00:00'));
    expect((await enrollment(later.personId)).tasks[0].state).toBe('DONE');
  });

  it('counts the same email once when it arrives as a synced message and as a logged note', async () => {
    const personId = await firstDay();
    await email(personId, { handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId }, 'Following up from the PHH webinar', on('04', '15:00:00'));
    const dup = await note(personId, '[Email] Outbound email: Re: Following up from the PHH webinar', on('04', '15:02:00'));
    expect(dup).toMatchObject({ result: 'note_outbound_email_touch', details: { [personId]: 'no_pending_task', loggedBy: 'crm-sales-glynac' } });
    // Tuesday: Email 2 opens and stays open - the note was Email 1 again.
    const e0 = await enrollment(personId);
    await advanceEnrollment(e0.id, ctx('05', '09:00:00'));
    let e = await enrollment(personId);
    expect(e.tasks.map((t) => t.state)).toEqual(['DONE', 'PENDING']);
    // A real second email closes it, logged by the team's tool with no Cadence user behind it.
    const second = await note(personId, '[Email] Outbound email: Checking in after the webinar', on('05', '15:00:00'));
    expect(second.result).toBe('note_outbound_email_completed');
    e = await enrollment(personId);
    expect(e.tasks.map((t) => t.state)).toEqual(['DONE', 'DONE']);
    expect(e.status).toBe('COMPLETED');
  });

  it('never gives the next step an email that came before this one was done', async () => {
    const personId = await firstDay();
    const e0 = await enrollment(personId);
    await completeTask({ taskId: e0.tasks[0].id, source: 'MANUAL' }, ctx('04', '15:30:00'));
    // Sent at 15:00, synced after the FO marked it done: it was Email 1.
    const late = await email(personId, { handle: 'karson@cadence.local', workspaceMemberId: b.users.karson.twentyMemberId }, 'Following up', on('04', '15:00:00'));
    expect(late.details).toEqual({ [personId]: 'no_pending_task' });
    await advanceEnrollment(e0.id, ctx('05'));
    expect((await enrollment(personId)).tasks.map((t) => t.state)).toEqual(['DONE', 'PENDING']);
    await runSchedulerTick(ctx('05', '17:00:00'));
    expect((await enrollment(personId)).tasks.map((t) => t.state)).toEqual(['DONE', 'PENDING']);
  });

  it('keeps the email behind a step marked done by hand from closing the next step', async () => {
    const personId = await firstDay();
    const e0 = await enrollment(personId);
    await completeTask({ taskId: e0.tasks[0].id, source: 'MANUAL' }, { actor: userActor(b.users.karson), now: on('04', '15:00:00'), skipSync: true });
    await advanceEnrollment(e0.id, ctx('05', '12:00:00'));
    expect((await enrollment(personId)).tasks.map((t) => t.state)).toEqual(['DONE', 'PENDING']);
    // The team's tool logged that email twenty minutes after the Done; it reaches Cadence on Tuesday.
    const late = await note(personId, '[Email] Outbound email: Following up from the webinar', on('04', '15:20:00'));
    expect(late.details).toMatchObject({ [personId]: 'before_step_opened' });
    await runSchedulerTick(ctx('05', '12:30:00'));
    expect((await enrollment(personId)).tasks.map((t) => t.state)).toEqual(['DONE', 'PENDING']);
    // Tuesday's follow-up in the same thread is the next email, not the same one.
    const next = await email(personId, { handle: 'karson@cadence.local', workspaceMemberId: b.users.karson.twentyMemberId }, 'Re: Following up from the webinar', on('05', '14:00:00'));
    expect(next.result).toBe('message_outbound_completed');
    expect((await enrollment(personId)).tasks.map((t) => t.state)).toEqual(['DONE', 'DONE']);
  });

  it('counts a next-day reply in the same thread as the next email', async () => {
    const personId = await firstDay();
    await email(personId, { handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId }, 'Following up from the webinar', on('04', '15:00:00'));
    await advanceEnrollment((await enrollment(personId)).id, ctx('05', '09:00:00'));
    const r = await email(personId, { handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId }, 'Re: Following up from the webinar', on('05', '10:00:00'));
    expect(r.result).toBe('message_outbound_completed');
    expect((await enrollment(personId)).status).toBe('COMPLETED');
  });

  it('records a closing from Twenty as Cadence, not as whoever clicked last', async () => {
    const personId = await firstDay();
    const open = (await enrollment(personId)).tasks[0];
    // Came in while it could not be applied, after the step opened.
    await prisma.touch.create({ data: { personId, channel: 'EMAIL', direction: 'OUTBOUND', occurredAt: on('04', '14:00:00'), summary: 'Email sent: Hello', externalId: `message:held:person:${personId}` } });
    expect(await completeFromEarlierEvidence([open.id], { actor: userActor(b.users.karson), now: on('04', '17:00:00'), skipSync: true })).toEqual([open.id]);
    const task = (await enrollment(personId)).tasks[0];
    expect(task).toEqual(expect.objectContaining({ state: 'DONE', completedById: null, completionSource: 'OBSERVED_MESSAGE' }));
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'task', entityId: task.id, action: 'completed' } });
    expect(audit.actorType).toBe('SYSTEM');
  });

  it('closes an open step from a touch already on file when the scheduler runs', async () => {
    const personId = await firstDay();
    const e0 = await enrollment(personId);
    // Recorded before this rule, or while the step was waiting: nothing closed it then.
    await prisma.touch.create({ data: { personId, channel: 'EMAIL', direction: 'OUTBOUND', occurredAt: on('04', '14:00:00'), summary: 'Email sent: Hello', externalId: `message:earlier:person:${personId}`, actorUserId: b.users.alisa.id } });
    // A manual completion elsewhere and an inbound reply are never evidence.
    await prisma.touch.create({ data: { personId, channel: 'EMAIL', direction: 'INBOUND', occurredAt: on('04', '14:30:00'), summary: 'Reply: Hello', externalId: `message:reply:person:${personId}` } });
    await runSchedulerTick(ctx('04', '17:00:00'));
    const task = (await enrollment(personId)).tasks[0];
    expect(task).toEqual(expect.objectContaining({ id: e0.tasks[0].id, state: 'DONE', evidenceId: `message:earlier:person:${personId}` }));
    // Running again changes nothing.
    await runSchedulerTick(ctx('04', '17:05:00'));
    expect(await prisma.task.count({ where: { enrollmentId: e0.id, state: 'DONE' } })).toBe(1);
  });

  it('does not use a touch from before the person joined', async () => {
    const personId = await firstDay();
    await prisma.touch.create({ data: { personId, channel: 'EMAIL', direction: 'OUTBOUND', occurredAt: new Date('2026-12-20T15:00:00Z'), summary: 'Email sent: Holiday note', externalId: `message:old:person:${personId}` } });
    await runSchedulerTick(ctx('04', '17:00:00'));
    expect((await enrollment(personId)).tasks[0].state).toBe('PENDING');
  });

  it('closes the step from an email to an address Twenty has not matched to the contact', async () => {
    const personId = await firstDay();
    await prisma.personCache.update({ where: { id: personId }, data: { email: 'Dana.Reyes@Prospect.example' } });
    const m = mock.addMessage({ subject: 'PHH webinar', receivedAt: on('04', '15:00:00').toISOString(), from: { handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId }, to: [{ handle: 'dana.reyes@prospect.example', personId: null }, { handle: 'karson@cadence.local', role: 'cc' }] });
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(m), now: on('04', '15:00:00'), skipSync: true });
    expect(r).toMatchObject({ result: 'message_outbound_completed', details: { [personId]: 'completed' } });
    expect((await enrollment(personId)).tasks[0].state).toBe('DONE');
  });

  it('does not pick between two contacts who share an address', async () => {
    const personId = await firstDay();
    await prisma.personCache.updateMany({ where: { id: { in: [personId, 'person-01'] } }, data: { email: 'office@prospect.example' } });
    const m = mock.addMessage({ subject: 'Hello', receivedAt: on('04', '15:00:00').toISOString(), from: { handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId }, to: [{ handle: 'office@prospect.example', personId: null }] });
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(m), now: on('04', '15:00:00'), skipSync: true });
    expect(r.result).toBe('ignored_outbound_no_person');
    expect((await enrollment(personId)).tasks[0].state).toBe('PENDING');
  });

  it('holds evidence while the campaign is paused and uses it once it runs again', async () => {
    const personId = await firstDay();
    await changeCampaignStatus(campaignId, 'PAUSED', SYSTEM_ACTOR, on('04', '13:00:00'));
    await email(personId, { handle: 'alisa@cadence.local', workspaceMemberId: b.users.alisa.twentyMemberId }, 'While paused', on('04', '15:00:00'));
    expect((await enrollment(personId)).tasks[0].state).toBe('PENDING');
    await changeCampaignStatus(campaignId, 'ACTIVE', SYSTEM_ACTOR, on('04', '16:00:00'));
    await runSchedulerTick(ctx('04', '17:00:00'));
    expect((await enrollment(personId)).tasks[0].state).toBe('DONE');
  });
});

describe('calls logged in Twenty', () => {
  let b: Basics;
  const mock = getMockTwentyClient();
  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    await prisma.personCache.update({ where: { id: 'person-05' }, data: { ownerMemberId: b.users.karson.twentyMemberId, podOwner: 'ALISA', dnd: false, optedOut: false } });
    const d: CampaignDraft = { name: 'Calls', podId: b.pods.Alisa.id, startDate: '2027-01-04', endDate: '2027-01-04', productInterest: ['PHH'], defaultBatchSize: 1, fos: [{ id: b.users.karson.id, batchSize: 1 }], personIds: ['person-05'], assignments: {}, flows: [{ id: 'default', name: 'Default', steps: [{ id: 'first', day: 1, actions: [{ id: 'email', type: 'EMAIL', label: 'Email 1' }, { id: 'call', type: 'CALL', label: 'Call 1' }] }] }] };
    const admin = asUser(b.users.ria);
    const p = await previewCampaignCalendar(d, admin);
    const id = (await saveCampaignCalendar(d, admin, { publish: true, fingerprint: p.fingerprint })).id;
    await activateCampaign(id, { actor: SYSTEM_ACTOR, now: on('04', '12:00:00'), skipSync: true });
  });

  it('closes the call from a logged call note, whoever logged it, and a call never closes the email', async () => {
    const n = mock.addNote({ title: '[CALL] Outbound Call', personIds: ['person-05'], createdByName: 'Dialpad', createdAt: on('04', '15:00:00').toISOString(), updatedAt: on('04', '15:00:00').toISOString() });
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: rawFromNote(n), now: on('04', '15:01:00'), skipSync: true });
    expect(r.result).toBe('note_outbound_call_completed');
    const tasks = await prisma.task.findMany({ where: { enrollment: { personId: 'person-05' } }, orderBy: { actionIndex: 'asc' } });
    expect(tasks.map((t) => [t.action, t.state])).toEqual([['EMAIL', 'PENDING'], ['CALL', 'DONE']]);
    // The step waits for its email; the scheduler does not reuse the call for it.
    await runSchedulerTick({ actor: SYSTEM_ACTOR, now: on('04', '17:00:00'), skipSync: true });
    expect((await prisma.task.findFirstOrThrow({ where: { enrollment: { personId: 'person-05' }, action: 'EMAIL' } })).state).toBe('PENDING');
  });

  // Dialpad and the email logger write the note first and link the contact a moment later, so the
  // note's own webhook arrives on no one. That note used to be set aside and never read again.
  const loggedLate = () => {
    const n = mock.addNote({ title: '[CALL] Outbound Call', personIds: [], createdByName: 'Dialpad', createdAt: on('04', '15:00:00').toISOString(), updatedAt: on('04', '15:00:00').toISOString() });
    const { noteTargets: _targets, ...bare } = rawFromNote(n);
    return { n, bare };
  };
  const callTask = () => prisma.task.findFirstOrThrow({ where: { enrollment: { personId: 'person-05' }, action: 'CALL' } });

  it('closes the call once Twenty links the contact to the note, just after the note', async () => {
    const { n, bare } = loggedLate();
    const first = await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: bare, now: on('04', '15:00:05'), skipSync: true });
    expect(first.result).toBe('ignored_note_no_person');
    n.personIds.push('person-05');
    const linked = await ingestEvent({ source: 'WEBHOOK', objectType: 'noteTarget', eventName: 'noteTarget.created', record: { id: 'nt-1', noteId: n.id, personId: 'person-05', companyId: null }, now: on('04', '15:00:06'), skipSync: true });
    expect(linked.result).toBe('note_outbound_call_completed');
    expect(await callTask()).toEqual(expect.objectContaining({ state: 'DONE', evidenceId: `note:${n.id}:person:person-05` }));
    // A link to an account is not a contact.
    const account = await ingestEvent({ source: 'WEBHOOK', objectType: 'noteTarget', eventName: 'noteTarget.created', record: { id: 'nt-2', noteId: n.id, personId: null, companyId: 'company-01' }, skipSync: true });
    expect(account.result).toBe('ignored_note_target_not_person');
  });

  it('reads a note set aside on no contact again when the sync lists it with its contact', async () => {
    const { n, bare } = loggedLate();
    expect((await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: bare, now: on('04', '15:00:05'), skipSync: true })).result).toBe('ignored_note_no_person');
    n.personIds.push('person-05');
    // The next sync lists the same version of the note, now with its contact: read again, not "already received".
    const listed = { source: 'RECONCILE' as const, objectType: 'note', eventName: 'note.updated', record: rawFromNote(n), recordId: n.id, updatedAt: n.updatedAt, now: on('04', '15:02:00'), skipSync: true };
    expect((await ingestEvent(listed)).result).toBe('note_outbound_call_completed');
    expect((await callTask()).state).toBe('DONE');
    // Read whole once, it is done with.
    expect((await ingestEvent(listed)).status).toBe('duplicate');
    expect(await prisma.activityEvent.count({ where: { externalId: n.id } })).toBe(1);
  });

  it('reads a webhook note whole when the contact is already linked in Twenty', async () => {
    const { n, bare } = loggedLate();
    n.personIds.push('person-05');
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: bare, now: on('04', '15:00:05'), skipSync: true });
    expect(r.result).toBe('note_outbound_call_completed');
  });
});

describe('a call logged twice', () => {
  let b: Basics;
  const mock = getMockTwentyClient();
  beforeEach(async () => {
    await resetDb(); b = await seedBasics();
    await prisma.personCache.update({ where: { id: 'person-05' }, data: { ownerMemberId: b.users.karson.twentyMemberId, podOwner: 'ALISA', dnd: false, optedOut: false } });
    const d: CampaignDraft = { name: 'Two calls', podId: b.pods.Alisa.id, startDate: '2027-01-04', endDate: '2027-01-05', productInterest: ['PHH'], defaultBatchSize: 1, fos: [{ id: b.users.karson.id, batchSize: 1 }], personIds: ['person-05'], assignments: {}, flows: [{ id: 'default', name: 'Default', steps: [{ id: 'first', day: 1, actions: [{ id: 'call', type: 'CALL', label: 'Call 1' }] }, { id: 'second', day: 2, actions: [{ id: 'call2', type: 'CALL', label: 'Call 2' }] }] }] };
    const admin = asUser(b.users.ria);
    const p = await previewCampaignCalendar(d, admin);
    expect(p.calendar.valid).toBe(true);
    const id = (await saveCampaignCalendar(d, admin, { publish: true, fingerprint: p.fingerprint })).id;
    await activateCampaign(id, { actor: SYSTEM_ACTOR, now: on('04', '12:00:00'), skipSync: true });
  });
  const logCall = (createdAt: Date) => {
    const n = mock.addNote({ title: '[CALL] Outbound Call', personIds: ['person-05'], createdByName: 'Dialpad', createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString() });
    return ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: rawFromNote(n), now: createdAt, skipSync: true });
  };
  const states = async () => (await prisma.task.findMany({ where: { enrollment: { personId: 'person-05' } }, orderBy: { stepIndex: 'asc' } })).map((t) => t.state);
  const openNext = async () => advanceEnrollment((await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-05', status: 'ACTIVE' } })).id, { actor: SYSTEM_ACTOR, now: on('05', '12:00:00'), skipSync: true });

  it('counts one call once, and the next day’s call for the next step', async () => {
    expect((await logCall(on('04', '15:00:00'))).result).toBe('note_outbound_call_completed');
    expect((await logCall(on('04', '15:40:00'))).result).toBe('note_outbound_call_touch');
    await openNext();
    expect(await states()).toEqual(['DONE', 'PENDING']);
    expect((await logCall(on('05', '15:00:00'))).result).toBe('note_outbound_call_completed');
    expect(await states()).toEqual(['DONE', 'DONE']);
  });

  it('reads a call written up the next morning as that call, not a new one', async () => {
    expect((await logCall(on('04', '15:00:00'))).result).toBe('note_outbound_call_completed');
    await openNext();
    const n = mock.addNote({ title: 'Call Notes [2027-01-04]', personIds: ['person-05'], createdByName: 'Dialpad', createdAt: on('05', '13:30:00').toISOString(), updatedAt: on('05', '13:30:00').toISOString() });
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: rawFromNote(n), now: on('05', '13:31:00'), skipSync: true });
    expect(r.details).toMatchObject({ 'person-05': 'same_touch' });
    expect(await states()).toEqual(['DONE', 'PENDING']);
  });

  it('keeps the call behind a logged outcome from closing the next call', async () => {
    const first = await prisma.task.findFirstOrThrow({ where: { enrollment: { personId: 'person-05' }, stepIndex: 0 } });
    await completeTask({ taskId: first.id, source: 'MANUAL' }, { actor: userActor(b.users.karson), now: on('04', '15:00:00'), skipSync: true });
    await logCall(on('04', '15:10:00'));
    await openNext();
    expect(await states()).toEqual(['DONE', 'PENDING']);
  });
});

describe('the same email under two names', () => {
  it('reads the synced subject and the logged note title as one email', () => {
    expect(subjectKey('Email sent: Re: Following up from the PHH webinar')).toBe(subjectKey('[Email] Outbound email: Following up from the PHH webinar'));
    expect(subjectKey('Email sent: FW: Re:  Q2   update')).toBe('q2 update');
    expect(subjectKey('Email sent: Q2 update')).not.toBe(subjectKey('Email sent: Q3 update'));
  });
});
