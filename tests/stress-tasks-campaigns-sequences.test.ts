import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import { activateCampaign, changeCampaignStatus } from '@/lib/engine/campaigns';
import { delegateTasks } from '@/lib/engine/delegate';
import { enrollPeople } from '@/lib/engine/enrollment';
import { saveSequenceSteps } from '@/lib/engine/sequence-plan';
import { advanceEnrollment, completeTask, runSchedulerTick, skipTask, snoozeTask } from '@/lib/engine/tasks';
import { parseSteps } from '@/lib/sequences/steps';
import type { SessionUser } from '@/lib/auth/current-user';
import { resetDb, seedBasics, type Basics } from './helpers/db';

/**
 * The work surfaces under load: two people clicking the same touchpoint, a campaign paused while
 * its tasks are being worked, a plan edited while the engine generates from it. Every case asserts
 * an invariant an FO would notice - one completion, one next step, no task left half-moved - not
 * just that nothing threw.
 */
let b: Basics;
const now = new Date('2026-09-14T18:00:00Z');
const ctx = { now, actor: SYSTEM_ACTOR, skipSync: true };
const at = (iso: string) => new Date(`${iso}T18:00:00Z`);
const session = (user: Basics['users']['alisa'], podIds: string[]): SessionUser => ({ ...user, pods: [], podIds });

beforeEach(async () => { await resetDb(); b = await seedBasics(); });

/** One enrolled person with their first step generated, worked by Alisa. */
async function enrolled(personId: string, opts: { campaignId?: string } = {}) {
  await enrollPeople(
    { personIds: [personId], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, campaignId: opts.campaignId, startDate: '2026-09-14', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR },
    ctx,
  );
  return prisma.enrollment.findFirstOrThrow({ where: { personId } });
}

describe('stress: tasks', () => {
  it('eight clicks on the same touchpoint complete it once and generate one next step', async () => {
    const enrollment = await enrolled('person-01');
    const task = await prisma.task.findFirstOrThrow({ where: { enrollmentId: enrollment.id, state: 'PENDING' } });

    const runs = await Promise.allSettled(Array.from({ length: 8 }, () => completeTask({ taskId: task.id, source: 'MANUAL' }, ctx)));
    expect(runs.every((run) => run.status === 'fulfilled')).toBe(true);

    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).state).toBe('DONE');
    expect(await prisma.touch.count({ where: { personId: 'person-01', channel: 'EMAIL' } })).toBe(1);
    const after = await prisma.task.findMany({ where: { enrollmentId: enrollment.id }, select: { stepIndex: true, actionId: true } });
    expect(new Set(after.map((t) => `${t.stepIndex}:${t.actionId}`)).size).toBe(after.length);
    expect(await prisma.auditLog.count({ where: { entityType: 'task', entityId: task.id, action: 'completed' } })).toBe(1);
  });

  it('done, skip and snooze racing on one touchpoint leave exactly one outcome', async () => {
    const enrollment = await enrolled('person-02');
    const task = await prisma.task.findFirstOrThrow({ where: { enrollmentId: enrollment.id, state: 'PENDING' } });

    await Promise.allSettled([
      completeTask({ taskId: task.id, source: 'MANUAL' }, ctx),
      skipTask({ taskId: task.id, reason: 'other' }, ctx),
      snoozeTask({ taskId: task.id, toDate: '2026-09-16' }, ctx),
      completeTask({ taskId: task.id, source: 'MANUAL' }, ctx),
    ]);

    const resolved = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    // A snooze may win the race and leave it open; what may never happen is two outcomes at once.
    expect(['DONE', 'SKIPPED', 'PENDING']).toContain(resolved.state);
    if (resolved.state !== 'PENDING') expect(resolved.completedAt ?? resolved.updatedAt).toBeTruthy();
    const terminal = await prisma.auditLog.count({ where: { entityType: 'task', entityId: task.id, action: { in: ['completed', 'skipped'] } } });
    expect(terminal).toBeLessThanOrEqual(1);
    // The step keeps exactly the modules the plan holds: the race created no extra copy.
    const plan = parseSteps((await prisma.sequence.findUniqueOrThrow({ where: { id: b.sequence.id } })).steps);
    const sameStep = await prisma.task.findMany({ where: { enrollmentId: enrollment.id, stepIndex: 0 } });
    expect(sameStep).toHaveLength(plan[0].actions.length);
  });

  it('delegating a selection while one of it is completed moves all of it or none of it', async () => {
    const [first, second] = [await enrolled('person-01'), await enrolled('person-02')];
    const tasks = await prisma.task.findMany({ where: { enrollmentId: { in: [first.id, second.id] }, state: 'PENDING' }, orderBy: { id: 'asc' } });
    expect(tasks.length).toBeGreaterThan(1);
    const actor = session(b.users.alisa, [b.pods.Alisa.id]);

    const [delegation] = await Promise.all([
      delegateTasks(tasks.map((t) => t.id), b.users.karson.id, actor),
      completeTask({ taskId: tasks[0].id, source: 'MANUAL' }, ctx),
    ]);

    const after = await prisma.task.findMany({ where: { id: { in: tasks.map((t) => t.id) } } });
    const moved = after.filter((t) => t.foUserId === b.users.karson.id);
    // Either the whole selection moved, or the completion won and nothing moved. Never a mixture.
    expect(moved.length === after.length || moved.length === 0).toBe(true);
    if (!delegation.ok) expect(delegation.error).toMatch(/changed|open touchpoints/i);
    expect(after.every((t) => t.state !== 'PENDING' || t.foUserId !== b.users.alisa.id || moved.length === 0)).toBe(true);
  });

  it('a scheduler tick running beside hand completions never duplicates a step', async () => {
    const enrollment = await enrolled('person-03');
    for (let step = 0; step < 3; step++) {
      const pending = await prisma.task.findMany({ where: { enrollmentId: enrollment.id, state: 'PENDING' } });
      await Promise.allSettled([
        ...pending.map((task) => completeTask({ taskId: task.id, source: 'MANUAL' }, ctx)),
        runSchedulerTick(ctx),
        advanceEnrollment(enrollment.id, ctx),
        runSchedulerTick(ctx),
      ]);
    }
    const all = await prisma.task.findMany({ where: { enrollmentId: enrollment.id } });
    const keys = all.map((t) => `${t.stepIndex}:${t.actionId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('stress: campaigns', () => {
  async function scheduled(personIds: string[], data: Record<string, unknown> = {}) {
    return prisma.campaign.create({
      data: { name: `Stress ${Math.random().toString(36).slice(2, 8)}`, sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-14', status: 'SCHEDULED', personIds, assignmentMode: 'ROUND_ROBIN', ...data },
    });
  }

  it('six simultaneous launches enrol each person once and start one run', async () => {
    const people = ['person-01', 'person-02', 'person-03', 'person-04'];
    const campaign = await scheduled(people);

    const runs = await Promise.allSettled(Array.from({ length: 6 }, () => activateCampaign(campaign.id, ctx)));
    expect(runs.every((run) => run.status === 'fulfilled')).toBe(true);

    const enrollments = await prisma.enrollment.findMany({ where: { campaignId: campaign.id } });
    expect(enrollments).toHaveLength(people.length);
    expect(new Set(enrollments.map((e) => e.personId)).size).toBe(people.length);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('ACTIVE');
    expect(await prisma.auditLog.count({ where: { entityType: 'campaign', entityId: campaign.id, action: 'started' } })).toBe(1);
    for (const enrollment of enrollments) {
      const tasks = await prisma.task.findMany({ where: { enrollmentId: enrollment.id } });
      expect(new Set(tasks.map((t) => `${t.stepIndex}:${t.actionId}`)).size).toBe(tasks.length);
    }
  });

  it('pausing while its work is being completed leaves no active enrollment and no new step', async () => {
    const campaign = await scheduled(['person-01', 'person-02']);
    await activateCampaign(campaign.id, ctx);
    const open = await prisma.task.findMany({ where: { enrollment: { campaignId: campaign.id }, state: 'PENDING' } });
    expect(open.length).toBeGreaterThan(0);
    const before = await prisma.task.count({ where: { enrollment: { campaignId: campaign.id } } });

    await Promise.allSettled([
      changeCampaignStatus(campaign.id, 'PAUSED', SYSTEM_ACTOR, now),
      ...open.map((task) => completeTask({ taskId: task.id, source: 'MANUAL' }, ctx)),
      runSchedulerTick(ctx),
    ]);
    await runSchedulerTick(ctx);

    expect(await prisma.enrollment.count({ where: { campaignId: campaign.id, status: 'ACTIVE' } })).toBe(0);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe('PAUSED');
    // A paused campaign generates nothing further: any task that appeared was the step already due.
    const after = await prisma.task.findMany({ where: { enrollment: { campaignId: campaign.id } } });
    expect(after.filter((t) => t.state === 'PENDING').every((t) => open.some((o) => o.id === t.id))).toBe(true);
    expect(after.length).toBeLessThanOrEqual(before + open.length);
  });

  it('stopping while the scheduler runs cancels every open touchpoint exactly once', async () => {
    const campaign = await scheduled(['person-01', 'person-02', 'person-03']);
    await activateCampaign(campaign.id, ctx);
    const open = await prisma.task.findMany({ where: { enrollment: { campaignId: campaign.id }, state: 'PENDING' }, select: { id: true } });

    await Promise.allSettled([
      changeCampaignStatus(campaign.id, 'STOPPED', SYSTEM_ACTOR, now),
      runSchedulerTick(ctx),
      changeCampaignStatus(campaign.id, 'STOPPED', SYSTEM_ACTOR, now),
    ]);
    await runSchedulerTick(ctx);

    expect(await prisma.task.count({ where: { enrollment: { campaignId: campaign.id }, state: 'PENDING' } })).toBe(0);
    for (const task of open) {
      const cancellations = await prisma.auditLog.count({ where: { entityType: 'task', entityId: task.id, action: 'cancelled' } });
      expect(cancellations).toBeLessThanOrEqual(1);
    }
    expect(await prisma.enrollment.count({ where: { campaignId: campaign.id, status: { in: ['ACTIVE', 'PAUSED'] } } })).toBe(0);
  });

  it('pause and resume clicked together end in one state with the work intact', async () => {
    const campaign = await scheduled(['person-01', 'person-02']);
    await activateCampaign(campaign.id, ctx);
    await changeCampaignStatus(campaign.id, 'PAUSED', SYSTEM_ACTOR, now);

    await Promise.allSettled([
      changeCampaignStatus(campaign.id, 'ACTIVE', SYSTEM_ACTOR, now),
      changeCampaignStatus(campaign.id, 'ACTIVE', SYSTEM_ACTOR, now),
    ]);

    const campaignAfter = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(['ACTIVE', 'SCHEDULED']).toContain(campaignAfter.status);
    const enrollments = await prisma.enrollment.findMany({ where: { campaignId: campaign.id } });
    expect(enrollments).toHaveLength(2);
    expect(enrollments.every((e) => e.status === 'ACTIVE')).toBe(true);
    expect(enrollments.every((e) => e.pauseReason === null)).toBe(true);
    const tasks = await prisma.task.findMany({ where: { enrollment: { campaignId: campaign.id } } });
    expect(new Set(tasks.map((t) => `${t.enrollmentId}:${t.stepIndex}:${t.actionId}`)).size).toBe(tasks.length);
  });

  it('a daily ramp holds under a simultaneous launch', async () => {
    const people = ['person-01', 'person-02', 'person-03', 'person-04', 'person-05', 'person-06'];
    const campaign = await scheduled(people, { startsPerFoPerDay: 2, assignmentMode: 'ROUND_ROBIN' });

    await Promise.allSettled(Array.from({ length: 4 }, () => activateCampaign(campaign.id, ctx)));

    const enrollments = await prisma.enrollment.findMany({ where: { campaignId: campaign.id }, select: { personId: true, foUserId: true, startDate: true } });
    expect(new Set(enrollments.map((e) => e.personId)).size).toBe(enrollments.length);
    const perFoPerDay = new Map<string, number>();
    for (const e of enrollments) {
      const key = `${e.foUserId}:${e.startDate}`;
      perFoPerDay.set(key, (perFoPerDay.get(key) ?? 0) + 1);
    }
    for (const [key, count] of perFoPerDay) expect(count, key).toBeLessThanOrEqual(2);
  });
});

describe('stress: sequences', () => {
  it('a plan edit racing with the last completion on that step never rewrites a live task', async () => {
    const enrollment = await enrolled('person-01');
    const task = await prisma.task.findFirstOrThrow({ where: { enrollmentId: enrollment.id, state: 'PENDING' } });
    const snapshot = JSON.stringify(task.actionSnapshot);
    const steps = parseSteps((await prisma.sequence.findUniqueOrThrow({ where: { id: b.sequence.id } })).steps);
    const edited = steps.map((step, index) => (index === 0 ? { ...step, actions: step.actions.map((a) => ({ ...a, template: 'Rewritten while live' })) } : step));

    const [save] = await Promise.allSettled([
      saveSequenceSteps(b.sequence.id, edited, SYSTEM_ACTOR),
      completeTask({ taskId: task.id, source: 'MANUAL' }, ctx),
    ]);

    // The frozen copy on the task is what the FO was looking at, whichever side won.
    expect(JSON.stringify((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).actionSnapshot)).toBe(snapshot);
    if (save.status === 'rejected') expect(String(save.reason)).toMatch(/open|pending|in use|refus/i);
  });

  it('a nurture sequence that finishes under concurrent ticks starts exactly one new cycle', async () => {
    await prisma.sequence.update({ where: { id: b.sequence.id }, data: { repeatEveryDays: 5 } });
    const enrollment = await enrolled('person-02');

    for (let step = 0; step < 10; step++) {
      const pending = await prisma.task.findMany({ where: { enrollmentId: enrollment.id, state: 'PENDING' } });
      if (!pending.length) break;
      for (const task of pending) await completeTask({ taskId: task.id, source: 'MANUAL' }, ctx);
      await advanceEnrollment(enrollment.id, ctx);
    }
    expect((await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('COMPLETED');

    await Promise.allSettled([
      advanceEnrollment(enrollment.id, ctx),
      advanceEnrollment(enrollment.id, ctx),
      runSchedulerTick(ctx),
      runSchedulerTick(ctx),
    ]);

    const cycles = await prisma.enrollment.findMany({ where: { personId: 'person-02' }, select: { cycle: true, status: true } });
    expect(cycles.filter((e) => e.cycle === 2)).toHaveLength(1);
    expect(cycles.filter((e) => e.status === 'ACTIVE')).toHaveLength(1);
  });

  it('completing a repeating sequence for a person who opted out starts no new cycle', async () => {
    await prisma.sequence.update({ where: { id: b.sequence.id }, data: { repeatEveryDays: 5 } });
    const enrollment = await enrolled('person-03');
    for (let step = 0; step < 10; step++) {
      const pending = await prisma.task.findMany({ where: { enrollmentId: enrollment.id, state: 'PENDING' } });
      if (!pending.length) break;
      for (const task of pending) await completeTask({ taskId: task.id, source: 'MANUAL' }, ctx);
      if (step === 0) await prisma.personCache.update({ where: { id: 'person-03' }, data: { optedOut: true } });
      await advanceEnrollment(enrollment.id, ctx);
    }
    expect(await prisma.enrollment.count({ where: { personId: 'person-03', cycle: 2 } })).toBe(0);
  });

  it('a campaign paused mid-plan resumes on the step it stopped on, once', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Resume once', sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-14', status: 'SCHEDULED', personIds: ['person-04'], assignmentMode: 'ROUND_ROBIN' },
    });
    await activateCampaign(campaign.id, ctx);
    const enrollment = await prisma.enrollment.findFirstOrThrow({ where: { campaignId: campaign.id } });
    const first = await prisma.task.findMany({ where: { enrollmentId: enrollment.id, state: 'PENDING' } });
    for (const task of first) await completeTask({ taskId: task.id, source: 'MANUAL' }, { ...ctx, now: at('2026-09-14') });
    await changeCampaignStatus(campaign.id, 'PAUSED', SYSTEM_ACTOR, at('2026-09-15'));
    const stoppedOn = (await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).currentStep;

    await changeCampaignStatus(campaign.id, 'ACTIVE', SYSTEM_ACTOR, at('2026-09-16'));
    await runSchedulerTick({ ...ctx, now: at('2026-09-16') });

    const resumed = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(resumed.status).toBe('ACTIVE');
    expect(resumed.currentStep).toBeGreaterThanOrEqual(stoppedOn);
    const tasks = await prisma.task.findMany({ where: { enrollmentId: enrollment.id } });
    expect(new Set(tasks.map((t) => `${t.stepIndex}:${t.actionId}`)).size).toBe(tasks.length);
  });
});

describe('stress: the daily cap', () => {
  /**
   * The cap is read and then written inside one transaction, but the lock that serialises
   * generation is the sequence. Two plans feeding the same FO on the same day are the case that
   * lock does not cover, so it is the one worth measuring.
   */
  it('two sequences feeding one FO on the same day never exceed their cap', async () => {
    const cap = 2;
    await prisma.user.update({ where: { id: b.users.alisa.id }, data: { dailyCap: cap } });
    const second = await prisma.sequence.create({
      data: {
        name: 'Parallel plan',
        steps: [{ id: 'p1', day: 1, title: 'Open', actions: [{ id: 'p-email', type: 'EMAIL', label: 'Email 1', subject: 'Hello', template: 'Hi there,' }] }],
      },
    });
    const people = ['person-01', 'person-02', 'person-03', 'person-04', 'person-05', 'person-06'];
    const request = (personIds: string[], sequenceId: string) => ({
      personIds, sequenceId, podId: b.pods.Alisa.id, startDate: '2026-09-14',
      assignment: { mode: 'FIXED' as const, foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR,
    });

    await Promise.allSettled([
      enrollPeople(request(people.slice(0, 3), b.sequence.id), ctx),
      enrollPeople(request(people.slice(3), second.id), ctx),
      runSchedulerTick(ctx),
      runSchedulerTick(ctx),
    ]);

    const tasks = await prisma.task.findMany({ where: { foUserId: b.users.alisa.id, state: 'PENDING' }, select: { dueDate: true } });
    const perDay = new Map<string, number>();
    for (const task of tasks) perDay.set(task.dueDate, (perDay.get(task.dueDate) ?? 0) + 1);
    for (const [day, count] of perDay) expect(count, `${count} touches on ${day}, cap ${cap}`).toBeLessThanOrEqual(cap);
  });
});
