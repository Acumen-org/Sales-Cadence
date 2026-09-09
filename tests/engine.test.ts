import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR, userActor } from '@/lib/audit';
import { DEFAULT_SEQUENCE_STEPS } from '@/lib/sequences/default-sequence';
import { getSettings, saveSettingsSection } from '@/lib/settings';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import {
  advanceEnrollment,
  applyPersonFlags,
  completeTask,
  createSequence,
  saveSequenceSteps,
  enrollPeople,
  exitEnrollment,
  markMeeting,
  markReplied,
  pauseEnrollment,
  previewEnrollment,
  reassignEnrollment,
  resumeEnrollment,
  runSchedulerTick,
  skipTask,
  snoozeTask,
} from '@/lib/engine';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const at = (date: string) => new Date(`${date}T10:00:00Z`); // 11:00 in Europe/London (BST)

async function tasksOf(enrollmentId: string) {
  return prisma.task.findMany({ where: { enrollmentId }, orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }] });
}

async function completeStep(enrollmentId: string, stepIndex: number, on: string) {
  const pending = await prisma.task.findMany({ where: { enrollmentId, stepIndex, state: 'PENDING' }, orderBy: { actionIndex: 'asc' } });
  let last;
  for (const t of pending) {
    last = await completeTask({ taskId: t.id, source: 'MANUAL' }, { actor: SYSTEM_ACTOR, now: at(on) });
    expect(last.ok).toBe(true);
  }
  return last;
}

async function setRules(patch: Record<string, unknown>) {
  const s = await getSettings();
  await saveSettingsSection('rules', { ...s.rules, ...patch } as typeof s.rules);
}

describe('enrollment engine', () => {
  let b: Basics;
  const alisaFixed = (foUserId: string) => ({ mode: 'FIXED' as const, foUserId });

  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
  });

  it('enrols people and generates the first step on the start date', async () => {
    const r = await enrollPeople(
      { personIds: ['person-01', 'person-02'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: alisaFixed(b.users.alisa.id), actor: userActor(b.users.alisa) },
      { now: at('2026-09-06') },
    );
    expect(r.conflicts).toEqual([]);
    expect(r.enrolled).toHaveLength(2);
    const e = await prisma.enrollment.findUniqueOrThrow({ where: { id: r.enrolled[0].enrollmentId } });
    expect(e.currentStep).toBe(0);
    expect(e.currentStepId).toBe('step-d1');
    expect(e.status).toBe('ACTIVE');
    const tasks = await tasksOf(e.id);
    expect(tasks.map((t) => [t.label, t.action, t.dueDate, t.state])).toEqual([
      ['Email 1', 'EMAIL', '2026-09-07', 'PENDING'],
      ['LinkedIn connect', 'LINKEDIN_CONNECT', '2026-09-07', 'PENDING'],
    ]);
    // Twenty sync out: mirrored tasks were created against the mock workspace
    const mock = getMockTwentyClient();
    expect(mock.writes.filter((w) => w.op === 'createTask')).toHaveLength(4);
    const withMirror = await prisma.task.count({ where: { enrollmentId: e.id, twentyTaskId: { not: null } } });
    expect(withMirror).toBe(2);
  });

  it('allows one active enrollment per person and frees the slot on exit', async () => {
    const again = await enrollPeople(
      { personIds: ['person-01'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-08', assignment: alisaFixed(b.users.alisa.id), actor: SYSTEM_ACTOR },
      { now: at('2026-09-06') },
    );
    expect(again.enrolled).toHaveLength(0);
    expect(again.conflicts.map((c) => c.reason)).toEqual(['already_active']);

    const active = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-02', status: 'ACTIVE' } });
    await exitEnrollment(active.id, { reason: 'test', actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    const exited = await prisma.enrollment.findUniqueOrThrow({ where: { id: active.id }, include: { tasks: true } });
    expect(exited.status).toBe('EXITED');
    expect(exited.tasks.every((t) => t.state === 'CANCELLED')).toBe(true);
    // mirrored tasks removed from Twenty
    expect(getMockTwentyClient().writes.filter((w) => w.op === 'deleteTask')).toHaveLength(2);

    const third = await enrollPeople(
      { personIds: ['person-02'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-08', assignment: alisaFixed(b.users.alisa.id), actor: SYSTEM_ACTOR },
      { now: at('2026-09-07') },
    );
    expect(third.enrolled).toHaveLength(1);
  });

  it('never enrols dnd people, unknown ids or duplicates', async () => {
    const p = await previewEnrollment({
      personIds: ['person-07', 'person-99', 'person-03', 'person-03'],
      sequenceId: b.sequence.id,
      podId: b.pods.Alisa.id,
      startDate: '2026-09-07',
      assignment: alisaFixed(b.users.alisa.id),
      actor: SYSTEM_ACTOR,
    });
    expect(p.conflicts.map((c) => [c.personId, c.reason])).toEqual([
      ['person-03', 'duplicate'],
      ['person-07', 'dnd'],
      ['person-99', 'not_found'],
    ]);
    expect(p.candidates.map((c) => c.personId)).toEqual(['person-03']);
  });

  it('assigns by person owner, falls back to the least loaded FO, and ramps start dates', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Ramp test', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', dailyRampPerFo: 1, status: 'ACTIVE' },
    });
    // person-04 is owned by Karson (wm-karson); person-10 has no owner
    const p = await previewEnrollment({
      personIds: ['person-04', 'person-10', 'person-11', 'person-12'],
      sequenceId: b.sequence.id,
      podId: b.pods.Alisa.id,
      campaignId: campaign.id,
      startDate: '2026-09-05', // Saturday -> Monday 7th
      assignment: { mode: 'OWNER' },
      dailyRampPerFo: 1,
      actor: SYSTEM_ACTOR,
    });
    expect(p.warnings.some((w) => w.includes('2026-09-07'))).toBe(true);
    const byPerson = Object.fromEntries(p.candidates.map((c) => [c.personId, c]));
    expect(byPerson['person-04'].foUserId).toBe(b.users.karson.id);
    expect(byPerson['person-04'].assignedBy).toBe('owner');
    expect(byPerson['person-04'].startDate).toBe('2026-09-07');
    // Alisa is least loaded within this campaign, so the unowned person goes to her
    expect(byPerson['person-10'].assignedBy).toBe('round_robin');
    // ramp of 1 per FO per day spreads the rest
    const dates = p.candidates.map((c) => `${c.foName}:${c.startDate}`).sort();
    expect(new Set(dates).size).toBe(4);
  });

  it('shifts later steps when a step completes late (clock mode = shift)', async () => {
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-01', status: 'ACTIVE' } });
    // step 0 done on time (Mon 7th) -> step 1 (day 3) due Wed 9th
    await completeStep(e.id, 0, '2026-09-07');
    let tasks = await tasksOf(e.id);
    // Both modules of step 1 (the call and its follow-up) are due the same day.
    expect(tasks.filter((t) => t.stepIndex === 1).map((t) => [t.label, t.dueDate])).toEqual([
      ['Call 1', '2026-09-09'],
      ['Follow-up email', '2026-09-09'],
    ]);
    // Step 1 is 5 calendar days late. Business day 6 is Mon 14th;
    // adding that delay reaches Sat 19th, which rolls forward to Mon 21st.
    await completeStep(e.id, 1, '2026-09-14');
    const after = await prisma.enrollment.findUniqueOrThrow({ where: { id: e.id } });
    expect(after.shiftDays).toBe(5);
    expect(after.currentStep).toBe(2);
    tasks = await tasksOf(e.id);
    const step2 = tasks.filter((t) => t.stepIndex === 2);
    expect(step2.map((t) => [t.label, t.dueDate, t.plannedDate])).toEqual([['Email 2', '2026-09-21', '2026-09-21']]);
    // completion notes written to Twenty for each completed action
    const notes = getMockTwentyClient().writes.filter((w) => w.op === 'createNote');
    expect(notes.length).toBeGreaterThanOrEqual(4);
    expect(notes.some((w) => w.op === 'createNote' && w.input.title === '[Cadence] Email 1 sent by Alisa')).toBe(true);
    expect(notes.some((w) => w.op === 'createNote' && w.input.title === '[Cadence] Call 1 made by Alisa')).toBe(true);
  });

  it('hold mode keeps the plan and generates steps when they fall due', async () => {
    await setRules({ clockMode: 'hold' });
    const r = await enrollPeople(
      { personIds: ['person-03'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: alisaFixed(b.users.alisa.id), actor: SYSTEM_ACTOR },
      { now: at('2026-09-07') },
    );
    const id = r.enrolled[0].enrollmentId;
    // nothing new on the 8th
    expect((await advanceEnrollment(id, { actor: SYSTEM_ACTOR, now: at('2026-09-08') })).outcome).toBe('waiting');
    // on the 9th the day-3 step is due even though step 0 is still pending
    const tick = await runSchedulerTick({ actor: SYSTEM_ACTOR, now: at('2026-09-09') });
    expect(tick.generated).toBeGreaterThanOrEqual(1);
    const tasks = await tasksOf(id);
    expect(tasks.filter((t) => t.stepIndex === 0).every((t) => t.state === 'PENDING')).toBe(true);
    expect(tasks.filter((t) => t.stepIndex === 1).map((t) => t.dueDate)).toEqual(['2026-09-09', '2026-09-09']);
    // Finishing both steps late does not move the plan: business day 6 is Mon 14th.
    await completeStep(id, 0, '2026-09-16');
    await completeStep(id, 1, '2026-09-16');
    const e = await prisma.enrollment.findUniqueOrThrow({ where: { id } });
    expect(e.shiftDays).toBe(0);
    expect((await tasksOf(id)).filter((t) => t.stepIndex === 2).map((t) => t.dueDate)).toEqual(['2026-09-14']);
    await setRules({ clockMode: 'shift' });
  });

  it('rolls whole steps forward when the daily cap is reached', async () => {
    await setRules({ dailyCap: 3 });
    const r = await enrollPeople(
      { personIds: ['person-15', 'person-16'], sequenceId: b.sequence.id, podId: b.pods.Leigh.id, startDate: '2026-09-07', assignment: alisaFixed(b.users.leigh.id), actor: SYSTEM_ACTOR },
      { now: at('2026-09-06') },
    );
    const [first, second] = await Promise.all(r.enrolled.map((x) => prisma.enrollment.findUniqueOrThrow({ where: { id: x.enrollmentId }, include: { tasks: true } })));
    expect(first.tasks.map((t) => t.dueDate)).toEqual(['2026-09-07', '2026-09-07']);
    expect(second.tasks.map((t) => t.dueDate)).toEqual(['2026-09-08', '2026-09-08']);
    expect(second.startDate).toBe('2026-09-08'); // the sequence starts when its first touch happens
    await setRules({ dailyCap: 40 });
  });

  it('leaves generated work alone when a later step is edited, and generates the edited step next', async () => {
    // Other cases in this suite leave step 2 in use. This case requires an unused
    // future step, so its plan is isolated without bypassing the in-use lock.
    const { sequence } = await createSequence({ name: 'Future-step edit isolation', steps: DEFAULT_SEQUENCE_STEPS }, SYSTEM_ACTOR);
    const r = await enrollPeople(
      { personIds: ['person-21'], sequenceId: sequence.id, podId: b.pods.Leigh.id, startDate: '2026-09-07', assignment: alisaFixed(b.users.daniel.id), actor: SYSTEM_ACTOR },
      { now: at('2026-09-07') },
    );
    const id = r.enrolled[0].enrollmentId;
    await completeStep(id, 0, '2026-09-07');
    const before = await tasksOf(id);
    expect(before.filter((t) => t.stepIndex === 1).map((t) => t.label)).toEqual(['Call 1', 'Follow-up email']);

    // A Senior FO edits the plan: Email 2 moves to day 7 and is renamed. Step 2 has no tasks
    // yet, so the edit is allowed.
    const steps = JSON.parse(JSON.stringify(DEFAULT_SEQUENCE_STEPS)) as typeof DEFAULT_SEQUENCE_STEPS;
    steps[2].day = 7;
    steps[2].actions[0].label = 'Email 2, reworked';
    await saveSequenceSteps(sequence.id, steps, userActor(b.users.ria));

    // Work already handed to an FO is untouched: the task carries its own copy.
    const mid = await tasksOf(id);
    expect(mid.filter((t) => t.stepIndex === 1).map((t) => t.label)).toEqual(['Call 1', 'Follow-up email']);

    // The next step generated is the edited one: business day 7 is Tue 15th.
    await completeStep(id, 1, '2026-09-09');
    const after = await prisma.enrollment.findUniqueOrThrow({ where: { id } });
    expect([after.currentStep, after.currentStepId]).toEqual([2, 'step-d6']);
    const step2 = (await tasksOf(id)).filter((t) => t.stepIndex === 2);
    expect(step2.map((t) => [t.label, t.dueDate])).toEqual([['Email 2, reworked', '2026-09-15']]);

    // A step people are standing on is refused rather than moved under them.
    const moveLive = JSON.parse(JSON.stringify(steps)) as typeof steps;
    moveLive[2].actions[0].label = 'Changed while in use';
    await expect(saveSequenceSteps(sequence.id, moveLive, userActor(b.users.ria))).rejects.toThrow(/open action/i);
  });

  it('skips need a reason, snoozes land on working days, and resolving a step advances it', async () => {
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-02', status: 'ACTIVE' } });
    const [email1, connect] = await tasksOf(e.id);
    expect((await skipTask({ taskId: email1.id, reason: '  ' }, { actor: SYSTEM_ACTOR })).ok).toBe(false);

    // Friday -> snoozing to Saturday lands on Monday; the past is rejected
    const snooze = await snoozeTask({ taskId: connect.id, toDate: '2026-09-12' }, { actor: SYSTEM_ACTOR, now: at('2026-09-11') });
    expect(snooze.ok).toBe(true);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: connect.id } })).snoozedTo).toBe('2026-09-14');
    expect((await snoozeTask({ taskId: connect.id, toDate: '2026-09-10' }, { actor: SYSTEM_ACTOR, now: at('2026-09-11') })).ok).toBe(false);

    const skipped = await skipTask({ taskId: email1.id, reason: 'bounced' }, { actor: userActor(b.users.alisa), now: at('2026-09-08') });
    expect(skipped.ok).toBe(true);
    if (skipped.ok) expect(skipped.advance.outcome).toBe('waiting'); // connect still pending
    const done = await completeTask({ taskId: connect.id, source: 'MANUAL' }, { actor: userActor(b.users.alisa), now: at('2026-09-08') });
    expect(done.ok && done.advance.outcome).toBe('generated');
    const t = await prisma.task.findUniqueOrThrow({ where: { id: email1.id } });
    expect([t.state, t.skipReason]).toEqual(['SKIPPED', 'bounced']);
    // manual completions are logged as manual
    const audit = await prisma.auditLog.findFirst({ where: { entityType: 'task', entityId: connect.id, action: 'completed' } });
    expect((audit?.details as { source: string }).source).toBe('MANUAL');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: connect.id } })).completionSource).toBe('MANUAL');
  });

  it('completes a task at most once per piece of evidence', async () => {
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-02', status: 'ACTIVE' } });
    const pending = await prisma.task.findMany({ where: { enrollmentId: e.id, state: 'PENDING' }, orderBy: { actionIndex: 'asc' } });
    const first = await completeTask({ taskId: pending[0].id, source: 'OBSERVED_NOTE', evidenceId: 'note:abc' }, { actor: SYSTEM_ACTOR, now: at('2026-09-09') });
    expect(first.ok).toBe(true);
    const again = await completeTask({ taskId: pending[0].id, source: 'OBSERVED_NOTE', evidenceId: 'note:abc' }, { actor: SYSTEM_ACTOR, now: at('2026-09-09') });
    expect(again.ok === false && again.reason).toBe('already_resolved');
    const other = await completeTask({ taskId: pending[1].id, source: 'OBSERVED_NOTE', evidenceId: 'note:abc' }, { actor: SYSTEM_ACTOR, now: at('2026-09-09') });
    expect(other.ok === false && other.reason).toBe('evidence_used');
  });

  it('reassigns within the pod only', async () => {
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-01', status: 'ACTIVE' } });
    await expect(reassignEnrollment(e.id, b.users.leigh.id, { actor: SYSTEM_ACTOR })).rejects.toThrow(/not a member/);
    await reassignEnrollment(e.id, b.users.karson.id, { actor: SYSTEM_ACTOR });
    const after = await prisma.enrollment.findUniqueOrThrow({ where: { id: e.id }, include: { tasks: { where: { state: 'PENDING' } } } });
    expect(after.foUserId).toBe(b.users.karson.id);
    expect(after.tasks.every((t) => t.foUserId === b.users.karson.id)).toBe(true);
  });

  it('a reply closes open tasks; a meeting does too; dnd exits', async () => {
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-01', status: 'ACTIVE' } });
    const replied = await markReplied(e.id, { at: at('2026-09-18'), evidenceId: 'message:x', actor: SYSTEM_ACTOR });
    expect(replied.changed).toBe(true);
    expect(replied.enrollment.status).toBe('REPLIED');
    expect(await prisma.task.count({ where: { enrollmentId: e.id, state: 'PENDING' } })).toBe(0);
    expect(await prisma.task.count({ where: { enrollmentId: e.id, state: 'CANCELLED', cancelReason: 'replied' } })).toBe(1);
    // replying again is a no-op
    expect((await markReplied(e.id, { at: at('2026-09-19'), actor: SYSTEM_ACTOR })).changed).toBe(false);

    const m = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-15', status: 'ACTIVE' } });
    expect((await markMeeting(m.id, { at: at('2026-09-10'), actor: SYSTEM_ACTOR })).enrollment.status).toBe('MEETING');

    const d = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-16', status: 'ACTIVE' } });
    const flags = await applyPersonFlags({ id: 'person-16', dnd: true, deletedAt: null }, { actor: SYSTEM_ACTOR });
    expect(flags.exited).toEqual([d.id]);
    const exited = await prisma.enrollment.findUniqueOrThrow({ where: { id: d.id } });
    expect([exited.status, exited.exitReason]).toEqual(['EXITED', 'dnd']);
  });

  it('pause and resume keep the cadence spacing in shift mode', async () => {
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-03', status: 'ACTIVE' } });
    await pauseEnrollment(e.id, { reason: 'holiday', actor: SYSTEM_ACTOR, now: at('2026-09-14') });
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('PAUSED');
    await resumeEnrollment(e.id, { actor: SYSTEM_ACTOR, now: at('2026-09-21') });
    const after = await prisma.enrollment.findUniqueOrThrow({ where: { id: e.id }, include: { tasks: { where: { state: 'PENDING' } } } });
    expect(after.status).toBe('ACTIVE');
    expect(after.shiftDays).toBe(7);
    expect(after.tasks.every((t) => t.dueDate >= '2026-09-21')).toBe(true);
  });

  it('completes the enrollment after the last step', async () => {
    const r = await enrollPeople(
      { personIds: ['person-28'], sequenceId: b.sequence.id, podId: b.pods.Andrew.id, startDate: '2026-09-07', assignment: alisaFixed(b.users.andrew.id), actor: SYSTEM_ACTOR },
      { now: at('2026-09-07') },
    );
    const id = r.enrolled[0].enrollmentId;
    for (let step = 0; step < 8; step++) {
      const e = await prisma.enrollment.findUniqueOrThrow({ where: { id } });
      expect(e.currentStep).toBe(step);
      await completeStep(id, step, '2026-09-07');
    }
    const done = await prisma.enrollment.findUniqueOrThrow({ where: { id } });
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).not.toBeNull();
    expect(await prisma.task.count({ where: { enrollmentId: id, state: 'DONE' } })).toBe(12);
  });
});
