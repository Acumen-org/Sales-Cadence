import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { getSettings, saveSettingsSection } from '@/lib/settings';
import { applyExitConsequence, completeCall, enrollPeople, exitEnrollment, finishEnrollment, moveToStep, previewEnrollment, skipWithReason } from '@/lib/engine';
import { listTasks } from '@/lib/tasks-query';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { WORKSPACE_TIMEZONE } from '@/lib/workspace';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const at = (date: string) => new Date(`${date}T10:00:00Z`);

async function pending(personId: string) {
  return prisma.task.findMany({ where: { enrollment: { personId }, state: 'PENDING' }, orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }] });
}

describe('Outreach-style outcomes', () => {
  let b: Basics;
  beforeAll(async () => {
    await resetDb();
    b = await seedBasics();
    await enrollPeople(
      { personIds: ['person-01', 'person-02', 'person-03', 'person-04', 'person-05', 'person-06'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-07', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR },
      { now: at('2026-09-07') },
    );
  });

  async function reachCallStep(personId: string) {
    for (const t of await pending(personId)) {
      const { completeTask } = await import('@/lib/engine/tasks');
      await completeTask({ taskId: t.id, source: 'MANUAL' }, { actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    }
    const tasks = await pending(personId);
    expect(tasks.map((t) => t.label)).toEqual(['Call 1', 'Follow-up email']);
    return tasks[0];
  }

  it('a call needs a disposition; an answered call finishes the sequence as replied', async () => {
    const call = await reachCallStep('person-01');
    const bad = await completeCall({ taskId: call.id, disposition: 'nope' }, { actor: SYSTEM_ACTOR, now: at('2026-09-09') });
    expect(bad.ok).toBe(false);
    const r = await completeCall({ taskId: call.id, disposition: 'connected', note: 'Great chat, wants a demo' }, { actor: SYSTEM_ACTOR, now: at('2026-09-09') });
    expect(r.ok && r.replied).toBe(true);
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-01' } });
    expect(e.status).toBe('REPLIED');
    const done = await prisma.task.findUniqueOrThrow({ where: { id: call.id } });
    expect([done.state, done.disposition, done.note]).toEqual(['DONE', 'connected', 'Great chat, wants a demo']);
    expect(await pending('person-01')).toHaveLength(0);
    // the Twenty note carries the outcome and the notes
    const notes = getMockTwentyClient().writes.filter((w) => w.op === 'createNote');
    const callNote = notes.find((w) => w.op === 'createNote' && w.input.title.includes('Call 1'));
    expect(callNote && callNote.op === 'createNote' ? callNote.input.title : '').toBe('[Cadence] Call 1 made by Alisa - Connected');
    expect(callNote && callNote.op === 'createNote' ? callNote.input.bodyMarkdown : '').toContain('Great chat');
  });

  it('a not-answered call just completes the task; wrong number flags the phone', async () => {
    const call = await reachCallStep('person-02');
    const r = await completeCall({ taskId: call.id, disposition: 'wrong_number' }, { actor: SYSTEM_ACTOR, now: at('2026-09-09') });
    expect(r.ok && !r.replied).toBe(true);
    expect((await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-02' } })).status).toBe('ACTIVE');
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-02' } })).badPhone).toBe(true);
    expect((await pending('person-02')).map((t) => t.label)).toEqual(['Follow-up email']);
  });

  it('a bounced skip exits the enrollment and flags the email; not interested exits; other skips do not', async () => {
    const [email1] = await pending('person-03');
    const r = await skipWithReason({ taskId: email1.id, reasonKey: 'bounced', note: 'mailbox not found' }, { actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    expect(r.ok && r.exited).toBe('bounced');
    const e3 = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-03' } });
    expect([e3.status, e3.exitReason]).toEqual(['EXITED', 'bounced']);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-03' } })).badEmail).toBe(true);
    expect(await pending('person-03')).toHaveLength(0);

    const [e4task] = await pending('person-04');
    expect((await skipWithReason({ taskId: e4task.id, reasonKey: 'not_interested' }, { actor: SYSTEM_ACTOR })).exited).toBe('not_interested');
    expect((await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-04' } })).exitReason).toBe('not_interested');

    const [e5task, e5other] = await pending('person-05');
    const soft = await skipWithReason({ taskId: e5task.id, reasonKey: 'no_linkedin' }, { actor: SYSTEM_ACTOR });
    expect(soft.ok && soft.exited).toBeNull();
    expect((await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-05' } })).status).toBe('ACTIVE');
    expect((await pending('person-05')).map((t) => t.id)).toEqual([e5other.id]);
  });

  it('exitOnBounce can be turned off', async () => {
    const s = await getSettings();
    await saveSettingsSection('rules', { ...s.rules, exitOnBounce: false });
    const [task] = await pending('person-05');
    const r = await skipWithReason({ taskId: task.id, reasonKey: 'bounced' }, { actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    expect(r.ok && r.exited).toBeNull();
    expect((await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-05' } })).status).toBe('ACTIVE');
    await saveSettingsSection('rules', { ...s.rules, exitOnBounce: true });
  });

  // The reason lives on the enrollment, but "asked not to be contacted" has to outlive it: the
  // consequence goes on the person, or the next campaign re-enrols somebody who told us to stop.
  it('ending a sequence because they asked us to stop opts the person out of every future campaign', async () => {
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-05' } });
    await exitEnrollment(e.id, { reason: 'opted_out', actor: SYSTEM_ACTOR });
    await applyExitConsequence('person-05', 'opted_out', SYSTEM_ACTOR);
    expect((await prisma.personCache.findUniqueOrThrow({ where: { id: 'person-05' } })).optedOut).toBe(true);
    const p = await previewEnrollment({ personIds: ['person-05'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-08', assignment: { mode: 'OWNER' }, actor: SYSTEM_ACTOR });
    expect(p.conflicts.map((c) => c.reason)).toEqual(['opted_out']);
  });

  it('move to step jumps ahead and generates the target step due now; finish (no reply) completes', async () => {
    const e = await prisma.enrollment.findFirstOrThrow({ where: { personId: 'person-06' } });
    const bad = await moveToStep(e.id, 0, { actor: SYSTEM_ACTOR, now: at('2026-09-07') });
    expect(bad.ok).toBe(false);
    const r = await moveToStep(e.id, 3, { actor: SYSTEM_ACTOR, now: at('2026-09-07') }); // day 9 step, LinkedIn message 2
    expect(r.ok && r.generated.length).toBe(1);
    const after = await prisma.enrollment.findUniqueOrThrow({ where: { id: e.id } });
    expect(after.currentStep).toBe(3);
    const open = await pending('person-06');
    // Step days count working days only: from Mon 7 Sep, day 9 is Thu 17 Sep (two weekends skipped).
    expect(open.map((t) => [t.label, t.dueDate])).toEqual([['LinkedIn message 2', '2026-09-17']]);
    expect(await prisma.task.count({ where: { enrollmentId: e.id, state: 'CANCELLED' } })).toBe(2);

    const fin = await finishEnrollment(e.id, 'no_reply', { actor: SYSTEM_ACTOR, now: at('2026-09-08') });
    expect(fin.status).toBe('COMPLETED');
    expect(await pending('person-06')).toHaveLength(0);
  });

  it('a step with two modules makes two tasks the FO works together, and the channel filter splits them', async () => {
    // Step 1 of the house sequence is an email plus a LinkedIn connect. That is one step, so the
    // two land on the same day with the same stepId and are worked side by side in one task view.
    const r = await enrollPeople(
      { personIds: ['person-11', 'person-12'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-08', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR },
      { now: at('2026-09-08') },
    );
    expect(r.enrolled).toHaveLength(2);
    const first = await prisma.task.findMany({ where: { enrollment: { personId: 'person-11' } }, orderBy: { actionIndex: 'asc' } });
    expect(first.map((t) => [t.action, t.actionIndex, t.dueDate])).toEqual([
      ['EMAIL', 0, '2026-09-08'],
      ['LINKEDIN_CONNECT', 1, '2026-09-08'],
    ]);
    expect(new Set(first.map((t) => t.stepId)).size).toBe(1);

    const admin: SessionUser = { id: b.users.ria.id, email: b.users.ria.email, name: b.users.ria.name, role: 'ADMIN', timezone: WORKSPACE_TIMEZONE, twentyMemberId: null, dailyCap: null, podIds: [], pods: [] };
    // The brief for either task shows both modules, so the FO sees the whole step at once.
    const { getTaskBrief } = await import('@/lib/brief');
    const brief = await getTaskBrief(first[0].id, admin);
    expect(brief?.modules.map((m) => m.action.type)).toEqual(['EMAIL', 'LINKEDIN_CONNECT']);
    // Copy is literal: no variable syntax survives into what an FO would send.
    expect(brief?.action.body).not.toMatch(/\{\{/);

    const list = await listTasks(admin, { tab: 'today', channel: 'LINKEDIN' }, at('2026-09-08'));
    expect(list.rows.every((x) => x.action.startsWith('LINKEDIN'))).toBe(true);
    expect(list.channelCounts.EMAIL).toBeGreaterThan(0);
  });
});
