import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { enrollPeople } from '@/lib/engine/enrollment';
import { ingestEvent } from '@/lib/engine/ingest';
import { rawFromMessage, rawFromNote, rawFromOpportunity, rawFromPerson, reconcile } from '@/lib/engine/reconcile';
import { getSettings, saveSettingsSection } from '@/lib/settings';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const at = (date: string, time = '10:00:00') => new Date(`${date}T${time}Z`);
const iso = (date: string, time = '10:00:00') => at(date, time).toISOString();

async function pendingTasks(personId: string) {
  return prisma.task.findMany({ where: { enrollment: { personId }, state: 'PENDING' }, orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }] });
}

describe('webhook ingestion', () => {
  let b: Basics;
  const mock = getMockTwentyClient();

  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
    const enrol = (personIds: string[], podId: string, foUserId: string) =>
      enrollPeople({ personIds, sequenceId: b.sequence.id, podId, startDate: '2026-09-07', assignment: { mode: 'FIXED', foUserId }, actor: SYSTEM_ACTOR }, { now: at('2026-09-06') });
    await enrol(['person-01', 'person-03', 'person-05', 'person-06', 'person-11'], b.pods.Alisa.id, b.users.alisa.id);
    await enrol(['person-15', 'person-16', 'person-17'], b.pods.Leigh.id, b.users.leigh.id);
    await enrol(['person-32'], b.pods.Andrew.id, b.users.andrew.id);
  });

  it('stores each record version once: a duplicate webhook is a no-op', async () => {
    const note = mock.addNote({ id: 'note-dup', title: '[Email] Outbound email: hello', personIds: ['person-01'], createdByMemberId: 'wm-alisa', createdAt: iso('2026-09-07'), updatedAt: iso('2026-09-07') });
    const input = { source: 'WEBHOOK' as const, objectType: 'note', eventName: 'note.created', record: rawFromNote(note), now: at('2026-09-07') };
    const first = await ingestEvent(input);
    expect(first.status).toBe('processed');
    expect(first.result).toBe('note_outbound_email_completed');
    const second = await ingestEvent(input);
    expect(second.status).toBe('duplicate');
    // and Twenty's retry with the same updatedAt under a different event name is still one event
    const third = await ingestEvent({ ...input, eventName: 'note.updated' });
    expect(third.status).toBe('duplicate');
    const done = await prisma.task.findMany({ where: { enrollment: { personId: 'person-01' }, state: 'DONE' } });
    expect(done).toHaveLength(1);
    expect(done[0].label).toBe('Email 1');
    expect(done[0].completionSource).toBe('OBSERVED_NOTE');
    expect(done[0].evidenceId).toBe('note:note-dup:person:person-01');
    expect(await prisma.activityEvent.count({ where: { externalId: 'note-dup' } })).toBe(1);
  });

  it('an outbound email by someone other than the FO does not complete the task', async () => {
    // note-04 in the fixtures: written by Ria (an admin) about person-03, whose FO is Alisa
    const note = (await mock.getNote('note-04'))!;
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: rawFromNote(note), now: at('2026-09-07') });
    expect(r.result).toBe('ignored_non_fo');
    const pending = await pendingTasks('person-03');
    expect(pending.map((t) => t.label)).toEqual(['Email 1', 'LinkedIn connect']);
    // but the touch is on the timeline
    const touch = await prisma.touch.findUnique({ where: { externalId: 'note:note-04:person:person-03' } });
    expect(touch?.actorLabel).toBe('Ria Patel');
    expect(touch?.direction).toBe('OUTBOUND');
  });

  it('a call note by the FO completes the call step; Call Notes count as calls', async () => {
    // Move person-15 (Leigh) to step 1 by completing step 0 through observed evidence + manual LinkedIn
    const email = mock.addNote({ title: '[Email] Outbound email: Harbor Media intro', personIds: ['person-15'], createdByMemberId: 'wm-leigh', createdAt: iso('2026-09-07'), updatedAt: iso('2026-09-07') });
    expect((await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: rawFromNote(email), now: at('2026-09-07') })).result).toBe('note_outbound_email_completed');
    // LinkedIn is never observed: a note about it is just a touch
    const connect = (await pendingTasks('person-15')).find((t) => t.action === 'LINKEDIN_CONNECT')!;
    await prisma.task.update({ where: { id: connect.id }, data: { state: 'DONE', completedAt: at('2026-09-07'), completionSource: 'MANUAL' } });
    const { advanceEnrollment } = await import('@/lib/engine/tasks');
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-15' } });
    await advanceEnrollment(e.id, { actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    expect((await pendingTasks('person-15')).map((t) => t.label)).toEqual(['Call 1', 'Follow-up email']);

    const call = mock.addNote({ title: '[CALL] Outbound Call by tw_leigh', personIds: ['person-15'], createdByMemberId: null, createdByName: null, createdAt: iso('2026-09-09'), updatedAt: iso('2026-09-09') });
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: rawFromNote(call), now: at('2026-09-09') });
    expect(r.result).toBe('note_outbound_call_completed');
    expect((await pendingTasks('person-15')).map((t) => t.label)).toEqual(['Follow-up email']);

    // Call Notes [date] on Kwame (person-16, still on step 0 with no call task) is a touch only
    const notes = mock.addNote({ title: 'Call Notes [09-Sep-2026]', personIds: ['person-16'], createdByMemberId: 'wm-leigh', createdAt: iso('2026-09-09'), updatedAt: iso('2026-09-09') });
    const r2 = await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: rawFromNote(notes), now: at('2026-09-09') });
    expect(r2.result).toBe('note_call_notes_touch');
    expect(r2.details).toMatchObject({ 'person-16': 'no_pending_task' });
  });

  it('an outbound message from the FO completes the either/or email via the primary side', async () => {
    const msg = mock.addMessage({ subject: 'Re: Harbor Media', receivedAt: iso('2026-09-09', '12:00:00'), from: { handle: 'leigh@acumen.example', workspaceMemberId: 'wm-leigh' }, to: [{ handle: 'isabel.moreau@harbormedia.example', personId: 'person-15' }] });
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(msg), now: at('2026-09-09', '12:01:00') });
    expect(r.result).toBe('message_outbound_completed');
    const followUp = await prisma.task.findFirstOrThrow({ where: { enrollment: { personId: 'person-15' }, label: 'Follow-up email' } });
    expect(followUp.state).toBe('DONE');
    expect(followUp.chosenAction).toBe('EMAIL');
    expect(followUp.completionSource).toBe('OBSERVED_MESSAGE');
    // step 1 finished on time -> step 2 generated
    expect((await pendingTasks('person-15')).map((t) => t.label)).toEqual(['Email 2']);
  });

  it('a messageParticipant event fetches the message and is idempotent with the message event', async () => {
    const msg = (await mock.getMessage('msg-01'))!; // Alisa -> person-01 (Email 1 already done above: nothing left to complete on step 0 email)
    const participant = msg.participants[1];
    const r = await ingestEvent({
      source: 'WEBHOOK',
      objectType: 'messageParticipant',
      eventName: 'messageParticipant.created',
      record: { id: participant.id, messageId: participant.messageId, role: participant.role, handle: participant.handle, personId: participant.personId, workspaceMemberId: participant.workspaceMemberId },
      now: at('2026-09-07'),
    });
    expect(['message_outbound_touch', 'message_outbound_completed']).toContain(r.result);
    expect(await prisma.touch.findUnique({ where: { externalId: 'message:msg-01:person:person-01' } })).not.toBeNull();
  });

  it('an inbound reply closes open tasks and marks the enrollment replied', async () => {
    const reply = (await mock.getMessage('msg-02'))!; // Elena Rossi (person-05) -> Alisa
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(reply), now: at('2026-09-07') });
    expect(r.result).toBe('replied');
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-05' } });
    expect(e.status).toBe('REPLIED');
    expect(e.repliedAt?.toISOString()).toBe('2026-09-03T11:00:00.000Z');
    expect(await pendingTasks('person-05')).toHaveLength(0);
    expect(await prisma.task.count({ where: { enrollmentId: e.id, state: 'CANCELLED', cancelReason: 'replied' } })).toBe(2);
    const touch = await prisma.touch.findUnique({ where: { externalId: 'message:msg-02:person:person-05' } });
    expect(touch?.direction).toBe('INBOUND');
    // replaying the same message (new updatedAt) is harmless
    const again = await ingestEvent({ source: 'RECONCILE', objectType: 'message', eventName: 'message.updated', record: { ...rawFromMessage(reply), updatedAt: iso('2026-09-08') }, now: at('2026-09-08') });
    expect(again.result).toBe('already_replied');
  });

  it('a reply from a colleague pauses the rest of the company when enabled', async () => {
    const s = await getSettings();
    await saveSettingsSection('rules', { ...s.rules, companyReplyPausesColleagues: true });
    // person-16 (Kwame) and person-15 (Isabel) are both at Harbor Media; Kwame replies
    const reply = mock.addMessage({ subject: 'Re: intro', receivedAt: iso('2026-09-10'), from: { handle: 'kwame.mensah@harbormedia.example', personId: 'person-16' }, to: [{ handle: 'leigh@acumen.example', workspaceMemberId: 'wm-leigh' }] });
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'message', eventName: 'message.created', record: rawFromMessage(reply), now: at('2026-09-10') });
    expect(r.result).toBe('replied');
    expect(r.details).toMatchObject({ pausedColleagues: 1 });
    const isabel = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-15' } });
    expect(isabel.status).toBe('PAUSED');
    expect(isabel.pauseReason).toBe('colleague_replied:person-16');
    await saveSettingsSection('rules', { ...s.rules, companyReplyPausesColleagues: false });
  });

  it('dnd flipping to true exits the active enrollment; deletion too', async () => {
    const person = mock.updatePerson('person-06', { dnd: true, updatedAt: iso('2026-09-08') });
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'person', eventName: 'person.updated', record: rawFromPerson(person), now: at('2026-09-08') });
    expect(r.result).toBe('dnd_exited');
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-06' } });
    expect([e.status, e.exitReason]).toEqual(['EXITED', 'dnd']);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-06' } })).dnd).toBe(true);
    expect(await pendingTasks('person-06')).toHaveLength(0);

    const gone = (await mock.getPerson('person-17'))!;
    const r2 = await ingestEvent({ source: 'WEBHOOK', objectType: 'person', eventName: 'person.deleted', record: { id: gone.id, updatedAt: iso('2026-09-08', '11:00:00') }, now: at('2026-09-08') });
    expect(r2.result).toBe('person_deleted_exited');
    expect((await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-17' } })).exitReason).toBe('person_deleted');
  });

  it('an opportunity for an enrolled person marks a meeting', async () => {
    const opp = (await mock.listOpportunities()).items[0]; // Grace Kimura, person-11
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'opportunity', eventName: 'opportunity.created', record: rawFromOpportunity(opp), now: at('2026-09-07') });
    expect(r.result).toBe('meeting_from_opportunity');
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-11' } });
    expect(e.status).toBe('MEETING');
    expect(await pendingTasks('person-11')).toHaveLength(0);
  });

  it('statusOfMeeting on the person marks a meeting too', async () => {
    const person = mock.updatePerson('person-32', { statusOfMeeting: 'Booked', updatedAt: iso('2026-09-08', '12:00:00') });
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'person', eventName: 'person.updated', record: rawFromPerson(person), now: at('2026-09-08') });
    expect(r.result).toBe('meeting_from_status');
    expect((await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-32' } })).status).toBe('MEETING');
  });

  it('Cadence notes and unknown actors are handled safely', async () => {
    const own = mock.addNote({ title: '[Cadence] Email 1 sent by Alisa', personIds: ['person-03'], createdAt: iso('2026-09-07'), updatedAt: iso('2026-09-07') });
    expect((await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: rawFromNote(own), now: at('2026-09-07') })).result).toBe('ignored_cadence_note');
    const stranger = mock.addNote({ title: '[CALL] Outbound Call by tw_nobody', personIds: ['person-03'], createdAt: iso('2026-09-07'), updatedAt: iso('2026-09-07') });
    const r = await ingestEvent({ source: 'WEBHOOK', objectType: 'note', eventName: 'note.created', record: rawFromNote(stranger), now: at('2026-09-07') });
    expect(r.result).toBe('note_unknown_actor');
    expect(r.needsReview).toBe(true);
    expect((await pendingTasks('person-03')).map((t) => t.label)).toEqual(['Email 1', 'LinkedIn connect']);
  });

  it('a mirrored Twenty task marked done in Twenty completes the Cadence task', async () => {
    const task = await prisma.task.findFirstOrThrow({ where: { enrollment: { personId: 'person-03' }, label: 'LinkedIn connect' } });
    expect(task.twentyTaskId).toBeTruthy();
    const r = await ingestEvent({
      source: 'WEBHOOK',
      objectType: 'task',
      eventName: 'task.updated',
      record: { id: task.twentyTaskId, title: 'x', status: 'DONE', updatedAt: iso('2026-09-07', '15:00:00'), taskTargets: [{ personId: 'person-03' }] },
      now: at('2026-09-07'),
    });
    expect(r.result).toBe('twenty_task_done_completed');
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect([after.state, after.completionSource]).toEqual(['DONE', 'OBSERVED_TWENTY_TASK']);
  });

  it('reconcile re-scans Twenty and only processes what was missed', async () => {
    // A note that arrived while webhooks were down
    mock.addNote({ title: '[Email] Outbound email: missed by webhook', personIds: ['person-03'], createdByMemberId: 'wm-alisa', createdAt: iso('2026-09-08'), updatedAt: iso('2026-09-08') });
    const before = await prisma.activityEvent.count();
    const stats = await reconcile({ days: 30, now: at('2026-09-09') });
    expect(stats.notes).toBeGreaterThan(0);
    expect(stats.completions).toBe(1); // the missed email completes Email 1 for person-03
    expect(stats.duplicates).toBeGreaterThan(0); // everything already ingested was skipped
    const email1 = await prisma.task.findFirstOrThrow({ where: { enrollment: { personId: 'person-03' }, label: 'Email 1' } });
    expect(email1.state).toBe('DONE');
    // a second run changes nothing
    const again = await reconcile({ days: 30, now: at('2026-09-09') });
    expect(again.completions).toBe(0);
    expect(again.replies).toBe(0);
    expect(await prisma.activityEvent.count()).toBeGreaterThan(before);
  });
});
