import { prisma } from './db';
import { describeAction, parseSteps, type SequenceStep } from './sequences/steps';

export type StepFunnelRow = {
  stepId: string;
  index: number;
  day: number;
  title: string | null;
  actions: string;
  /** Enrollments currently working this step. */
  active: number;
  /** Enrollments that finished this step (at least one action done). */
  done: number;
  /** Enrollments that replied while on this step. */
  replied: number;
  /** Meetings booked while on this step. */
  meeting: number;
  /** Tasks skipped on this step. */
  skipped: number;
  /** Skipped with a reason mentioning bounce / wrong address. */
  bounced: number;
  /** Pending tasks past their day. */
  overdue: number;
};

export type SequenceSummary = {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  stepCount: number;
  lastDay: number;
  enrollments: { active: number; paused: number; replied: number; meeting: number; completed: number; exited: number; total: number };
  campaigns: number;
  preview: { id: string; day: number; actions: string[] }[];
};

export async function listSequences(): Promise<SequenceSummary[]> {
  const sequences = await prisma.sequence.findMany({ include: { _count: { select: { campaigns: true } } }, orderBy: [{ archived: 'asc' }, { name: 'asc' }] });
  const counts = await prisma.enrollment.groupBy({ by: ['sequenceId', 'status'], _count: { _all: true } });
  return sequences.map((s) => {
    const steps = parseSteps(s.steps);
    const e = { active: 0, paused: 0, replied: 0, meeting: 0, completed: 0, exited: 0, total: 0 };
    for (const c of counts.filter((c) => c.sequenceId === s.id)) {
      const key = c.status.toLowerCase() as keyof typeof e;
      if (key in e) e[key] += c._count._all;
      e.total += c._count._all;
    }
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      archived: s.archived,
      stepCount: steps.length,
      lastDay: steps.length ? steps[steps.length - 1].day : 0,
      enrollments: e,
      campaigns: s._count.campaigns,
      preview: steps.map((step) => ({ id: step.id, day: step.day, actions: step.actions.map((action) => action.type) })),
    };
  });
}

/** Per-step funnel across every version of the sequence (steps matched by stable id). */
export async function sequenceFunnel(sequenceId: string, steps: SequenceStep[], today: string): Promise<StepFunnelRow[]> {
  const [taskGroups, enrollments, skipped, overdueRows] = await Promise.all([
    prisma.task.groupBy({ by: ['stepId', 'state'], where: { enrollment: { sequenceId } }, _count: { _all: true } }),
    prisma.enrollment.findMany({
      where: { sequenceId, status: { in: ['ACTIVE', 'PAUSED', 'REPLIED', 'MEETING'] } },
      select: { id: true, status: true, currentStep: true, tasks: { select: { stepId: true, stepIndex: true }, orderBy: { stepIndex: 'desc' }, take: 1 } },
    }),
    prisma.task.findMany({ where: { enrollment: { sequenceId }, state: 'SKIPPED' }, select: { stepId: true, skipReason: true } }),
    prisma.task.findMany({
      where: { enrollment: { sequenceId }, state: 'PENDING', OR: [{ snoozedTo: null, dueDate: { lt: today } }, { snoozedTo: { lt: today } }] },
      select: { stepId: true },
    }),
  ]);
  const doneByStep = new Map<string, Set<string>>();
  const doneTasks = await prisma.task.findMany({ where: { enrollment: { sequenceId }, state: 'DONE' }, select: { stepId: true, enrollmentId: true } });
  for (const t of doneTasks) {
    const set = doneByStep.get(t.stepId) ?? new Set<string>();
    set.add(t.enrollmentId);
    doneByStep.set(t.stepId, set);
  }
  void taskGroups;
  return steps.map((step, index) => {
    const atStep = enrollments.filter((e) => e.tasks[0]?.stepId === step.id);
    const stepSkipped = skipped.filter((s) => s.stepId === step.id);
    return {
      stepId: step.id,
      index,
      day: step.day,
      title: step.title ?? null,
      actions: step.actions.map(describeAction).join(', then '),
      active: atStep.filter((e) => e.status === 'ACTIVE' || e.status === 'PAUSED').length,
      done: doneByStep.get(step.id)?.size ?? 0,
      replied: atStep.filter((e) => e.status === 'REPLIED').length,
      meeting: atStep.filter((e) => e.status === 'MEETING').length,
      skipped: stepSkipped.length,
      bounced: stepSkipped.filter((s) => /bounce|undeliver|wrong (email|address|number)|invalid/i.test(s.skipReason ?? '')).length,
      overdue: overdueRows.filter((o) => o.stepId === step.id).length,
    };
  });
}

