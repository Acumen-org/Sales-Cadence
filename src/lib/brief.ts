import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { canActOnTask, toActor } from './auth/rbac';
import { formatLocalDate, type LocalDate } from './dates';
import { plannedDateForStep } from './engine/clock';
import { previewNextStep } from './engine/versioning';
import { colleagueEnrollments } from './engine/enrollment';
import { cachedPersonName } from './person-cache';
import { describeStep, parseSteps, type SequenceStep, type StepAction } from './sequences/steps';
import { getSettings, getTwentyConnection } from './settings';
import { renderTemplate, type TemplateVars } from './templates';
import { getTwentyClient } from './twenty';
import type { TwentyNote, TwentyOpportunity } from './twenty/types';
import { twentyPersonUrl } from './twenty/urls';
import { taskRowInclude, type TaskRow } from './tasks-query';

export type RenderedAction = {
  type: StepAction['type'];
  label: string;
  subject: string | null;
  body: string;
  rawTemplate: string | null;
};

export type ColleagueRow = {
  personId: string;
  name: string;
  jobTitle: string | null;
  status: string | null;
  foName: string | null;
  lastTouchAt: Date | null;
};

export type TaskBrief = {
  task: TaskRow;
  person: TaskRow['enrollment']['person'];
  personName: string;
  twentyUrl: string | null;
  stepIndex: number;
  stepCount: number;
  step: SequenceStep | null;
  action: RenderedAction;
  alternative: RenderedAction | null;
  touches: Array<{ id: string; channel: string; direction: string; occurredAt: Date; summary: string; actorLabel: string | null }>;
  notes: TwentyNote[];
  colleagues: ColleagueRow[];
  opportunities: TwentyOpportunity[];
  nextStep: { step: SequenceStep; plannedDate: LocalDate; description: string } | null;
  enrollment: { id: string; status: string; startDate: string; version: number; campaignName: string | null; sequenceName: string; foName: string; shiftDays: number };
  warnings: string[];
};

function render(a: { type: StepAction['type']; label: string; subject?: string; template?: string }, vars: TemplateVars): RenderedAction {
  return {
    type: a.type,
    label: a.label,
    subject: a.subject ? renderTemplate(a.subject, vars) : null,
    body: renderTemplate(a.template, vars),
    rawTemplate: a.template ?? null,
  };
}

/**
 * Everything an FO needs on the right-hand panel before touching someone:
 * who they are, where we met, what has happened so far, who else we know there,
 * the filled-in template for this step, and what comes next.
 */
export async function getTaskBrief(taskId: string, user: SessionUser): Promise<TaskBrief | null> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: taskRowInclude });
  if (!task) return null;
  if (!canActOnTask(toActor(user), { foUserId: task.foUserId, podId: task.enrollment.podId })) return null;

  const [settings, conn, enrollmentFull] = await Promise.all([
    getSettings(),
    getTwentyConnection(),
    prisma.enrollment.findUniqueOrThrow({
      where: { id: task.enrollmentId },
      include: { sequenceVersion: true, sequence: { include: { activeVersion: true } }, fo: { select: { name: true } } },
    }),
  ]);
  const person = task.enrollment.person;
  const warnings: string[] = [];

  const currentSteps = parseSteps(enrollmentFull.sequenceVersion.steps);
  const activeSteps = enrollmentFull.sequence.activeVersion ? parseSteps(enrollmentFull.sequence.activeVersion.steps) : currentSteps;
  const taskVersion = await prisma.sequenceVersion.findUnique({ where: { id: task.sequenceVersionId } });
  const taskSteps = taskVersion ? parseSteps(taskVersion.steps) : currentSteps;
  const step = taskSteps.find((s) => s.id === task.stepId) ?? taskSteps[task.stepIndex] ?? null;
  const actionDef = step?.actions.find((a) => a.id === task.actionId) ?? step?.actions[task.actionIndex];

  const vars: TemplateVars = {
    firstName: person.firstName,
    lastName: person.lastName,
    company: person.companyName,
    jobTitle: person.jobTitle,
    eventSource: person.eventSource,
    foName: task.fo.name,
  };
  const action: RenderedAction = actionDef
    ? render(actionDef, vars)
    : { type: task.action, label: task.label, subject: null, body: '', rawTemplate: null };
  const alternative = actionDef?.alternative ? render(actionDef.alternative, vars) : null;

  const [touches, colleagues, notesResult, oppsResult] = await Promise.all([
    prisma.touch.findMany({ where: { personId: person.id }, orderBy: { occurredAt: 'desc' }, take: 5 }),
    loadColleagues(person.companyId, person.id),
    fetchNotes(person.id),
    fetchOpportunities(person.id),
  ]);
  if (notesResult.error) warnings.push(notesResult.error);
  if (oppsResult.error && oppsResult.error !== notesResult.error) warnings.push(oppsResult.error);

  const next = previewNextStep({ currentStep: enrollmentFull.currentStep, currentSteps, activeSteps });
  const nextStep = next
    ? {
        step: next,
        plannedDate: plannedDateForStep(enrollmentFull.startDate, next.day, enrollmentFull.shiftDays, settings.rules.workingDays),
        description: describeStep(next),
      }
    : null;

  return {
    task,
    person,
    personName: cachedPersonName(person),
    twentyUrl: twentyPersonUrl(conn.baseUrl, person.id),
    stepIndex: task.stepIndex,
    stepCount: taskSteps.length,
    step,
    action,
    alternative,
    touches: touches.map((t) => ({ id: t.id, channel: t.channel, direction: t.direction, occurredAt: t.occurredAt, summary: t.summary, actorLabel: t.actorLabel })),
    notes: notesResult.notes,
    colleagues,
    opportunities: oppsResult.opportunities,
    nextStep,
    enrollment: {
      id: enrollmentFull.id,
      status: enrollmentFull.status,
      startDate: enrollmentFull.startDate,
      version: enrollmentFull.sequenceVersion.version,
      campaignName: task.enrollment.campaign?.name ?? null,
      sequenceName: task.enrollment.sequence.name,
      foName: enrollmentFull.fo.name,
      shiftDays: enrollmentFull.shiftDays,
    },
    warnings,
  };
}

async function loadColleagues(companyId: string | null, personId: string): Promise<ColleagueRow[]> {
  if (!companyId) return [];
  const [people, enrollments] = await Promise.all([
    prisma.personCache.findMany({ where: { companyId, id: { not: personId }, deletedAt: null }, orderBy: { lastName: 'asc' }, take: 25 }),
    colleagueEnrollments(companyId, personId),
  ]);
  const byPerson = new Map(enrollments.map((e) => [e.personId, e]));
  const lastTouches = await prisma.touch.groupBy({ by: ['personId'], where: { personId: { in: people.map((p) => p.id) } }, _max: { occurredAt: true } });
  const lastByPerson = new Map(lastTouches.map((t) => [t.personId, t._max.occurredAt]));
  return people.map((p) => {
    const e = byPerson.get(p.id);
    return {
      personId: p.id,
      name: cachedPersonName(p),
      jobTitle: p.jobTitle,
      status: e?.status ?? (p.dnd ? 'DND' : null),
      foName: e?.fo.name ?? null,
      lastTouchAt: lastByPerson.get(p.id) ?? null,
    };
  });
}

async function fetchNotes(personId: string): Promise<{ notes: TwentyNote[]; error?: string }> {
  try {
    const client = await getTwentyClient();
    const page = await client.listNotes({ personId, limit: 5 });
    return { notes: page.items.slice(0, 5) };
  } catch (err) {
    return { notes: [], error: `Twenty unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function fetchOpportunities(personId: string): Promise<{ opportunities: TwentyOpportunity[]; error?: string }> {
  try {
    const client = await getTwentyClient();
    const page = await client.listOpportunities({ personId, limit: 10 });
    return { opportunities: page.items };
  } catch (err) {
    return { opportunities: [], error: `Twenty unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function describeDue(t: { dueDate: string; snoozedTo: string | null; plannedDate: string }): string {
  const parts = [formatLocalDate(t.snoozedTo ?? t.dueDate, 'long')];
  if (t.snoozedTo) parts.push(`(snoozed from ${formatLocalDate(t.dueDate)})`);
  else if (t.plannedDate !== t.dueDate) parts.push(`(planned ${formatLocalDate(t.plannedDate)}, moved by cap)`);
  return parts.join(' ');
}
