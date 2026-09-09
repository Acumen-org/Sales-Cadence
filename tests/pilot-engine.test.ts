import { beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { getSettings, saveSettingsSection } from '@/lib/settings';
import { parseSteps, type SequenceStep } from '@/lib/sequences/steps';
import {
  advanceEnrollment,
  completeTask,
  createSequence,
  saveSequenceSteps,
  enrollPeople,
  plannedDateForStep,
  runSchedulerTick,
} from '@/lib/engine';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const WORKING_DAYS = [1, 2, 3, 4, 5];
const START = '2026-09-07';
// Midday Central Time, so none of these cases depends on the test machine's timezone.
const at = (date: string) => new Date(`${date}T18:00:00Z`);
const context = (date = START) => ({ actor: SYSTEM_ACTOR, now: at(date), skipSync: true });
const STEPS: SequenceStep[] = [
  {
    id: 'pilot-introduction',
    day: 1,
    actions: [
      { id: 'pilot-call', type: 'CALL', label: 'Introduction call', template: 'Discuss the account priorities.' },
      { id: 'pilot-email', type: 'EMAIL', label: 'Introduction email', subject: 'Following up', template: 'Here is the information we discussed.' },
    ],
  },
  { id: 'pilot-linkedin', day: 3, actions: [{ id: 'pilot-linkedin-message', type: 'LINKEDIN_MESSAGE', label: 'LinkedIn follow-up', template: 'Following up on our introduction.' }] },
  { id: 'pilot-final', day: 7, actions: [{ id: 'pilot-final-email', type: 'EMAIL', label: 'Final email', subject: 'Next steps', template: 'Would a conversation be useful?' }] },
];

describe('pilot: sequence days count working days', () => {
  it.each([
    ['2026-09-07', 1, '2026-09-07'],
    ['2026-09-07', 7, '2026-09-15'],
    ['2026-09-11', 2, '2026-09-14'],
    ['2026-09-11', 7, '2026-09-21'],
    ['2026-09-12', 2, '2026-09-15'],
    ['2026-10-30', 2, '2026-11-02'],
  ] as const)('starting %s, day %i is %s', (start, day, expected) => {
    expect(plannedDateForStep(start, day, 0, WORKING_DAYS)).toBe(expected);
  });
});

describe('pilot: modular steps and lifecycle invariants', () => {
  let basics: Basics;
  let sequenceId: string;

  beforeEach(async () => {
    await resetDb();
    basics = await seedBasics();
    const created = await createSequence({ name: 'Pilot modular flow', steps: structuredClone(STEPS) }, SYSTEM_ACTOR);
    sequenceId = created.sequence.id;
    const settings = await getSettings();
    await saveSettingsSection('rules', { ...settings.rules, clockMode: 'shift', workingDays: WORKING_DAYS });
  });

  async function enroll(personIds = ['person-01'], campaignId?: string) {
    const result = await enrollPeople({
      personIds,
      sequenceId,
      podId: basics.pods.Alisa.id,
      campaignId,
      startDate: START,
      assignment: { mode: 'FIXED', foUserId: basics.users.alisa.id },
      actor: SYSTEM_ACTOR,
    }, context());
    expect(result.conflicts).toEqual([]);
    expect(result.enrolled).toHaveLength(personIds.length);
    return result.enrolled.map((row) => row.enrollmentId);
  }

  async function tasks(enrollmentId: string, stepIndex?: number) {
    return prisma.task.findMany({
      where: { enrollmentId, ...(stepIndex === undefined ? {} : { stepIndex }) },
      orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }],
    });
  }

  async function finishStep(enrollmentId: string, stepIndex: number, date = START, deferAdvance = false) {
    for (const task of await tasks(enrollmentId, stepIndex)) {
      if (task.state !== 'PENDING') continue;
      expect((await completeTask({ taskId: task.id, source: 'MANUAL' }, { ...context(date), deferAdvance })).ok).toBe(true);
    }
  }

  it('keeps both required actions in one step independent and advances only after both resolve', async () => {
    const [id] = await enroll();
    const [call, email] = await tasks(id);
    expect([call.action, email.action]).toEqual(['CALL', 'EMAIL']);
    expect(call.stepId).toBe(email.stepId);
    expect(call.dueDate).toBe(email.dueDate);

    expect((await completeTask({ taskId: call.id, source: 'MANUAL' }, context())).ok).toBe(true);
    expect((await tasks(id)).map((task) => task.state)).toEqual(['DONE', 'PENDING']);
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ACTIVE', currentStep: 0 });

    expect((await completeTask({ taskId: email.id, source: 'MANUAL' }, context())).ok).toBe(true);
    expect((await tasks(id, 1)).map((task) => [task.action, task.dueDate])).toEqual([['LINKEDIN_MESSAGE', '2026-09-09']]);
    await finishStep(id, 1, '2026-09-09');
    expect((await tasks(id, 2)).map((task) => task.dueDate)).toEqual(['2026-09-15']);
  });

  it('simultaneous completion of child actions creates the next step exactly once', async () => {
    const [id] = await enroll();
    const first = await tasks(id);
    const resolved = await Promise.all(first.map((task) => completeTask({ taskId: task.id, source: 'MANUAL' }, context())));
    expect(resolved.every((result) => result.ok)).toBe(true);
    expect(await tasks(id, 1)).toHaveLength(1);
    expect(await tasks(id, 2)).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { entityId: id, action: 'step_generated' } })).toBe(2);
  });

  it('rejects changes to a step while any of its child tasks remains pending', async () => {
    const [id] = await enroll();
    const [call] = await tasks(id);
    await completeTask({ taskId: call.id, source: 'MANUAL' }, context());
    const edited = structuredClone(STEPS);
    edited[0].actions[0].template = 'An edited call script.';
    await expect(saveSequenceSteps(sequenceId, edited, SYSTEM_ACTOR)).rejects.toThrow(/open action/i);
    const current = await prisma.sequence.findUniqueOrThrow({ where: { id: sequenceId } });
    expect(parseSteps(current.steps)[0]).toEqual(STEPS[0]);
    expect((await tasks(id)).map((task) => task.state)).toEqual(['DONE', 'PENDING']);
  });

  it('rejects removing a step with pending tasks', async () => {
    await enroll();
    await expect(saveSequenceSteps(sequenceId, structuredClone(STEPS.slice(1)), SYSTEM_ACTOR)).rejects.toThrow(/open action/i);
  });

  it('rejects adding another action to a step already in use', async () => {
    await enroll();
    const edited = structuredClone(STEPS);
    edited[0].actions.push({ id: 'pilot-extra-linkedin', type: 'LINKEDIN_MESSAGE', label: 'Additional LinkedIn message' });
    await expect(saveSequenceSteps(sequenceId, edited, SYSTEM_ACTOR)).rejects.toThrow(/open action/i);
  });

  it('allows an unused future step to change and applies it across enrollments', async () => {
    const ids = await enroll(['person-01', 'person-02']);
    const edited = structuredClone(STEPS);
    edited[1].day = 4;
    edited[1].actions[0].label = 'Updated LinkedIn follow-up';
    await saveSequenceSteps(sequenceId, edited, SYSTEM_ACTOR);
    for (const id of ids) {
      await finishStep(id, 0);
      expect((await tasks(id, 1)).map((task) => [task.label, task.dueDate])).toEqual([['Updated LinkedIn follow-up', '2026-09-10']]);
    }
  });

  it('unlocks a completed step while preserving completed task history', async () => {
    const [id] = await enroll();
    await finishStep(id, 0);
    const edited = structuredClone(STEPS);
    edited[0].actions[0].label = 'New introduction call';
    await saveSequenceSteps(sequenceId, edited, SYSTEM_ACTOR);
    expect((await tasks(id, 0)).map((task) => [task.label, task.state])).toEqual([
      ['Introduction call', 'DONE'],
      ['Introduction email', 'DONE'],
    ]);
  });

  it('serializes saving a future step against generating that same step', async () => {
    const [id] = await enroll();
    await finishStep(id, 0, START, true);
    const edited = structuredClone(STEPS);
    edited[1].actions[0].label = 'Concurrent edit';
    const [save, advance] = await Promise.allSettled([
      saveSequenceSteps(sequenceId, edited, SYSTEM_ACTOR),
      advanceEnrollment(id, context()),
    ]);
    expect(advance.status).toBe('fulfilled');
    if (save.status === 'rejected') expect(String(save.reason)).toMatch(/open action/i);
    // Either the edit wins before generation, or generation locks the original step.
    // It is never valid to silently edit the active definition after its task was generated.
    const sequence = await prisma.sequence.findUniqueOrThrow({ where: { id: sequenceId } });
    const activeSteps = parseSteps(sequence.steps);
    const generated = await tasks(id, 1);
    expect(generated).toHaveLength(1);
    expect(generated[0].label).toBe(activeSteps[1].actions[0].label);
  });

  it.each(['DRAFT', 'PAUSED', 'STOPPED', 'COMPLETED'] as const)('does not generate work for a %s campaign even if an enrollment remains active', async (status) => {
    const campaign = await prisma.campaign.create({ data: { name: 'Lifecycle gate', sequenceId, podId: basics.pods.Alisa.id, startDate: START, status: 'ACTIVE' } });
    const [id] = await enroll(['person-01'], campaign.id);
    await finishStep(id, 0, START, true);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status } });

    // This state can exist while a bulk pause is being applied. Both scheduler and
    // direct advancement must consult campaign state, rather than only enrollment state.
    await advanceEnrollment(id, context('2026-09-30'));
    await runSchedulerTick(context('2026-09-30'));
    expect(await tasks(id, 1)).toHaveLength(0);
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id } })).toMatchObject({ currentStep: 0 });
  });

  it('hold mode does not complete an enrollment while earlier required actions remain open', async () => {
    const settings = await getSettings();
    await saveSettingsSection('rules', { ...settings.rules, clockMode: 'hold' });
    const [id] = await enroll();
    await runSchedulerTick(context('2026-09-30'));
    await runSchedulerTick(context('2026-09-30'));
    expect(await tasks(id, 2)).toHaveLength(1);

    await finishStep(id, 2, '2026-09-30');
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ACTIVE' });
    await finishStep(id, 1, '2026-09-30');
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'ACTIVE' });
    await finishStep(id, 0, '2026-09-30');
    expect(await prisma.enrollment.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'COMPLETED' });
    expect((await tasks(id)).every((task) => task.state === 'DONE')).toBe(true);
  });
});
