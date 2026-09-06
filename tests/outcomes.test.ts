import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { SYSTEM_ACTOR } from '@/lib/audit';
import type { SessionUser } from '@/lib/auth/current-user';
import { DEFAULT_SEQUENCE_STEPS } from '@/lib/sequences/default-sequence';
import { pickVariant, resolveCopy } from '@/lib/sequences/steps';
import { getSettings, saveSettingsSection } from '@/lib/settings';
import { completeCall, createSequenceVersion, enrollPeople, finishEnrollment, moveToStep, optOutPerson, previewEnrollment, skipWithReason } from '@/lib/engine';
import { variantStats } from '@/lib/sequences-query';
import { listTasks } from '@/lib/tasks-query';
import { getMockTwentyClient } from '@/lib/twenty/mock-client';
import { resetDb, seedBasics, type Basics } from './helpers/db';

const at = (date: string) => new Date(`${date}T10:00:00Z`);

async function pending(personId: string) {
  return prisma.task.findMany({ where: { enrollment: { personId }, state: 'PENDING' }, orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }] });
}

describe('variant picking (pure)', () => {
  const action = { variants: [{ id: 'a', label: 'A', enabled: true }, { id: 'b', label: 'B', enabled: true }, { id: 'c', label: 'C', enabled: false }] };
  it('balances across enabled variants and never picks disabled ones', () => {
    expect(pickVariant(action, new Map([['a', 3], ['b', 1]]))?.id).toBe('b');
    expect(pickVariant(action, new Map([['a', 2], ['b', 2]]), () => 0)?.id).toBe('a');
    expect(pickVariant(action, new Map([['a', 2], ['b', 2]]), () => 0.99)?.id).toBe('b');
    expect(pickVariant({ variants: [] }, new Map())).toBeNull();
    expect(pickVariant({ variants: [{ id: 'c', label: 'C', enabled: false }] }, new Map())).toBeNull();
  });
  it('resolves the copy of the assigned variant, falling back to the action', () => {
    const a = { label: 'Email 1', subject: 'base', template: 'base body', variants: [{ id: 'x', label: 'X', subject: 'sub X', enabled: true }] };
    expect(resolveCopy(a, 'x')).toEqual({ subject: 'sub X', template: 'base body', variantLabel: 'X' });
    expect(resolveCopy(a, 'missing')).toEqual({ subject: 'base', template: 'base body', variantLabel: null });
  });
});

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

  it('opted out people cannot be enrolled again', async () => {
    const r = await optOutPerson('person-05', { actor: SYSTEM_ACTOR, optedOut: true });
    expect(r.exited).toHaveLength(1);
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
    expect(open.map((t) => [t.label, t.dueDate])).toEqual([['LinkedIn message 2', '2026-09-15']]); // day 9 from Sep 7 = Sep 15
    expect(await prisma.task.count({ where: { enrollmentId: e.id, state: 'CANCELLED' } })).toBe(2);

    const fin = await finishEnrollment(e.id, 'no_reply', { actor: SYSTEM_ACTOR, now: at('2026-09-08') });
    expect(fin.status).toBe('COMPLETED');
    expect(await pending('person-06')).toHaveLength(0);
  });

  it('A/B variants are assigned evenly and reported per variant', async () => {
    const steps = JSON.parse(JSON.stringify(DEFAULT_SEQUENCE_STEPS)) as typeof DEFAULT_SEQUENCE_STEPS;
    steps[0].actions[0].variants = [
      { id: 'v-a', label: 'A', subject: 'Subject A', template: 'Body A {{firstName}}', enabled: true },
      { id: 'v-b', label: 'B', subject: 'Subject B', template: 'Body B {{firstName}}', enabled: true },
    ];
    await createSequenceVersion(b.sequence.id, steps, SYSTEM_ACTOR, 'add A/B on email 1');
    const r = await enrollPeople(
      { personIds: ['person-11', 'person-12', 'person-13', 'person-14'], sequenceId: b.sequence.id, podId: b.pods.Alisa.id, startDate: '2026-09-08', assignment: { mode: 'FIXED', foUserId: b.users.alisa.id }, actor: SYSTEM_ACTOR },
      { now: at('2026-09-08') },
    );
    expect(r.enrolled).toHaveLength(4);
    const emailTasks = await prisma.task.findMany({ where: { actionId: 'act-email-1', enrollment: { personId: { in: ['person-11', 'person-12', 'person-13', 'person-14'] } } } });
    const counts = emailTasks.reduce((m, t) => m.set(t.variantId!, (m.get(t.variantId!) ?? 0) + 1), new Map<string, number>());
    expect(counts.get('v-a')).toBe(2);
    expect(counts.get('v-b')).toBe(2);
    // LinkedIn connect tasks (no variants) have none
    expect((await prisma.task.findFirst({ where: { actionId: 'act-li-connect-1', enrollment: { personId: 'person-11' } } }))?.variantId).toBeNull();

    // the brief renders the variant's copy
    const admin: SessionUser = { id: b.users.ria.id, email: b.users.ria.email, name: b.users.ria.name, role: 'ADMIN', timezone: 'Europe/London', twentyMemberId: null, dailyCap: null, podIds: [], pods: [] };
    const { getTaskBrief } = await import('@/lib/brief');
    const t = emailTasks.find((x) => x.variantId === 'v-b')!;
    const brief = await getTaskBrief(t.id, admin);
    expect(brief?.variantLabel).toBe('B');
    expect(brief?.action.subject).toBe('Subject B');

    // stats: complete one A email then reply -> credited to A
    const { completeTask } = await import('@/lib/engine/tasks');
    const { markReplied } = await import('@/lib/engine/enrollment');
    const a = emailTasks.find((x) => x.variantId === 'v-a')!;
    await completeTask({ taskId: a.id, source: 'MANUAL' }, { actor: SYSTEM_ACTOR, now: at('2026-09-08') });
    await markReplied(a.enrollmentId, { at: at('2026-09-09'), actor: SYSTEM_ACTOR });
    const stats = await variantStats(b.sequence.id, steps);
    const rowA = stats.find((s) => s.variantId === 'v-a')!;
    const rowB = stats.find((s) => s.variantId === 'v-b')!;
    expect([rowA.assigned, rowA.done, rowA.replied]).toEqual([2, 1, 1]);
    expect([rowB.assigned, rowB.done, rowB.replied]).toEqual([2, 0, 0]);

    // task list filters by channel
    const list = await listTasks(admin, { tab: 'today', channel: 'LINKEDIN' }, at('2026-09-08'));
    expect(list.rows.every((x) => x.action.startsWith('LINKEDIN'))).toBe(true);
    expect(list.channelCounts.EMAIL).toBeGreaterThan(0);
  });
});
