import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { canActOnTask, toActor } from './auth/rbac';
import { formatLocalDate, todayIn, type LocalDate } from './dates';
import { plannedDateForStep } from './engine/clock';
import { previewNextStep } from './engine/sequence-plan';
import { colleagueEnrollments } from './engine/enrollment';
import { cachedPersonName } from './person-cache';
import { auditDetailText, describeAudit } from './audit-format';
import { describeStep, parseSteps, StepActionSchema, type SequenceStep, type StepAction } from './sequences/steps';
import { cleanRichText, plainToHtml } from './rich-text';
import { getSettings, getTwentyConnection } from './settings';
import { getTwentyClient } from './twenty';
import type { TwentyMessage, TwentyNote, TwentyOpportunity } from './twenty/types';
import { twentyPersonUrl } from './twenty/urls';
import { taskRowInclude, type TaskRow } from './tasks-query';

export type RenderedAction = {
  type: StepAction['type'];
  label: string;
  subject: string | null;
  body: string;
  html?: string;
  rawTemplate: string | null;
};

export type BriefTimelineItem = {
  id: string;
  at: Date;
  kind: 'email' | 'call' | 'linkedin' | 'note' | 'meeting' | 'state';
  /** 'in' for something they did, 'out' for something we did. */
  direction: 'in' | 'out' | 'neutral';
  title: string;
  detail: string | null;
  actor: string | null;
};

export type ColleagueRow = {
  personId: string;
  name: string;
  jobTitle: string | null;
  status: string | null;
  exitReason: string | null;
  foName: string | null;
  lastTouchAt: Date | null;
};

export type TaskBrief = {
  task: TaskRow;
  modules: Array<{ task: TaskRow; action: RenderedAction }>;
  person: TaskRow['enrollment']['person'];
  personName: string;
  /** Today in the reader's timezone, so "due" dates from Twenty can be coloured. */
  today: LocalDate;
  /** The pod's name in Cadence, which is the label of the podOwner option in Twenty. */
  podName: string | null;
  /** Who owns the relationship in Twenty (assignedTo), resolved to a Cadence user's name. */
  ownerName: string | null;
  twentyUrl: string | null;
  stepIndex: number;
  stepCount: number;
  step: SequenceStep | null;
  action: RenderedAction;
  touches: Array<{ id: string; channel: string; direction: string; occurredAt: Date; summary: string; actorLabel: string | null }>;
  notes: TwentyNote[];
  /** Emails Twenty has synced for this person, newest first. */
  emails: Array<{ id: string; subject: string | null; preview: string | null; at: Date; inbound: boolean; from: string | null }>;
  /** Touches, emails, notes and sequence events on one clock, newest first. */
  timeline: BriefTimelineItem[];
  colleagues: ColleagueRow[];
  opportunities: TwentyOpportunity[];
  nextStep: { step: SequenceStep; plannedDate: LocalDate; description: string } | null;
  /** Steps of the plan (for "move to step") and where the enrollment is. */
  steps: { index: number; day: number; label: string }[];
  currentStep: number;
  enrollment: { id: string; status: string; exitReason: string | null; startDate: string; campaignName: string | null; sequenceName: string; foName: string; shiftDays: number };
  warnings: string[];
};

/**
 * The copy an FO starts from. It is the module's own text, verbatim: there is no substitution,
 * so nothing can arrive half-filled. The FO edits it in the composer with the person's record
 * open beside it, and the edit is saved against the task.
 */
function render(a: { type: StepAction['type']; label: string; subject?: string; template?: string; bodyHtml?: string }): RenderedAction {
  const text = a.template ?? '';
  return {
    type: a.type,
    label: a.label,
    subject: a.subject ?? null,
    body: text,
    html: a.bodyHtml ? cleanRichText(a.bodyHtml) : plainToHtml(text),
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
      include: { sequence: true, fo: { select: { name: true } } },
    }),
  ]);
  const person = task.enrollment.person;
  const warnings: string[] = [];

  // One plan per sequence. What this task says is frozen on the task itself, so an edit to the
  // plan since it was generated cannot rewrite the message an FO is looking at.
  const steps = parseSteps(enrollmentFull.sequence.steps);
  const step = steps.find((s) => s.id === task.stepId) ?? steps[task.stepIndex] ?? null;
  const snapshot = StepActionSchema.safeParse(task.actionSnapshot);
  const actionDef = snapshot.success ? snapshot.data : step?.actions.find((a) => a.id === task.actionId) ?? step?.actions[task.actionIndex];

  const action: RenderedAction = actionDef
    ? render(actionDef)
    : { type: task.action, label: task.label, subject: null, body: '', html: '<p></p>', rawTemplate: null };
  const siblings = await prisma.task.findMany({ where: { enrollmentId: task.enrollmentId, stepId: task.stepId }, include: taskRowInclude, orderBy: { actionIndex: 'asc' } });
  const modules = siblings.filter(t => canActOnTask(user, { foUserId: t.foUserId, podId: t.enrollment.podId })).map(t => {
    const snapshot = StepActionSchema.safeParse(t.actionSnapshot);
    const def = snapshot.success ? snapshot.data : step?.actions.find(a => a.id === t.actionId);
    const rendered = def ? render(def) : { type: t.action, label: t.label, subject: null, body: '', html: '<p></p>', rawTemplate: null };
    return { task: t, action: { ...rendered, subject: t.draftSubject ?? rendered.subject, html: t.draftHtml ?? rendered.html } };
  });

  const [touches, colleagues, notesResult, oppsResult, emailsResult, stateEvents, pod, owner] = await Promise.all([
    // 20 feeds both the dot timeline and the merged timeline below it.
    prisma.touch.findMany({ where: { personId: person.id }, orderBy: { occurredAt: 'desc' }, take: 20 }),
    loadColleagues(person.companyId, person.id),
    fetchNotes(person.id),
    fetchOpportunities(person.id),
    fetchEmails(person.id),
    prisma.auditLog.findMany({
      where: { entityType: 'enrollment', entityId: task.enrollmentId, action: { in: ['enrolled', 'replied', 'meeting', 'exited', 'paused', 'resumed', 'moved_to_step'] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    person.podOwner ? prisma.pod.findUnique({ where: { podOwnerValue: person.podOwner }, select: { name: true } }) : Promise.resolve(null),
    person.ownerMemberId ? prisma.user.findFirst({ where: { twentyMemberId: person.ownerMemberId }, select: { name: true } }) : Promise.resolve(null),
  ]);
  if (notesResult.error) warnings.push(notesResult.error);
  if (oppsResult.error && oppsResult.error !== notesResult.error) warnings.push(oppsResult.error);
  if (emailsResult.error && emailsResult.error !== notesResult.error) warnings.push(emailsResult.error);

  const next = previewNextStep({ currentStep: enrollmentFull.currentStep, currentStepId: enrollmentFull.currentStepId, steps });
  const nextStep = next
    ? {
        step: next,
        plannedDate: plannedDateForStep(enrollmentFull.startDate, next.day, enrollmentFull.shiftDays, settings.rules.workingDays),
        description: describeStep(next),
      }
    : null;

  return {
    task,
    modules,
    person,
    personName: cachedPersonName(person),
    today: todayIn(user.timezone),
    podName: pod?.name ?? null,
    ownerName: owner?.name ?? null,
    twentyUrl: twentyPersonUrl(conn.baseUrl, person.id),
    stepIndex: task.stepIndex,
    stepCount: steps.length,
    step,
    action,
    touches: touches.map((t) => ({ id: t.id, channel: t.channel, direction: t.direction, occurredAt: t.occurredAt, summary: t.summary, actorLabel: t.actorLabel })),
    notes: notesResult.notes,
    emails: emailsResult.emails,
    timeline: buildTimeline({
      touches,
      notes: notesResult.notes,
      emails: emailsResult.emails,
      stateEvents,
      crm: { lastCallAt: person.lastCallAt, lastEmailAt: person.lastEmailAt },
    }),
    colleagues,
    opportunities: oppsResult.opportunities,
    nextStep,
    steps: steps.map((s, index) => ({ index, day: s.day, label: describeStep(s) })),
    currentStep: enrollmentFull.currentStep,
    enrollment: {
      id: enrollmentFull.id,
      status: enrollmentFull.status,
      exitReason: enrollmentFull.exitReason,
      startDate: enrollmentFull.startDate,
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
      exitReason: e?.exitReason ?? null,
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

/**
 * Emails Twenty synced for this person. Direction comes from the participant list: if the person
 * is the sender it came in, otherwise it went out from one of our mailboxes.
 */
async function fetchEmails(personId: string): Promise<{ emails: TaskBrief['emails']; error?: string }> {
  try {
    const client = await getTwentyClient();
    const page = await client.listMessages({ personId, limit: 8 });
    const emails = page.items
      .map((m: TwentyMessage) => {
        const from = m.participants.find((x) => x.role === 'from');
        const text = (m.text ?? '').replace(/\s+/g, ' ').trim();
        return {
          id: m.id,
          subject: m.subject,
          preview: text ? text.slice(0, 180) : null,
          at: new Date(m.receivedAt ?? m.updatedAt ?? Date.now()),
          inbound: from?.personId === personId,
          from: from?.displayName ?? from?.handle ?? null,
        };
      })
      .sort((a, b) => b.at.getTime() - a.at.getTime());
    return { emails };
  } catch (err) {
    return { emails: [], error: `Twenty unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** One clock for everything known about this person, newest first. */
function buildTimeline(input: {
  touches: Array<{ id: string; channel: string; direction: string; occurredAt: Date; summary: string; actorLabel: string | null }>;
  notes: TwentyNote[];
  emails: TaskBrief['emails'];
  stateEvents: Array<{ id: string; action: string; createdAt: Date; actorLabel: string | null; details: unknown }>;
  /** Twenty's own last-touch stamps, which exist for people Cadence never worked. */
  crm: { lastCallAt: Date | null; lastEmailAt: Date | null };
}): BriefTimelineItem[] {
  const kindOfChannel = (channel: string): BriefTimelineItem['kind'] => (channel === 'EMAIL' ? 'email' : channel === 'CALL' ? 'call' : channel === 'MEETING' ? 'meeting' : 'linkedin');
  // An email listed in full from Twenty would otherwise show again as its touch record.
  const emailSubjects = new Set(input.emails.map((e) => (e.subject ?? '').toLowerCase()).filter(Boolean));
  const looksLikeListedEmail = (summary: string) => {
    const stripped = summary.replace(/^(reply|email)\s*[:-]?\s*/i, '').toLowerCase();
    return emailSubjects.has(stripped) || [...emailSubjects].some((s) => stripped.includes(s));
  };

  const items: BriefTimelineItem[] = [
    ...input.touches
      .filter((t) => !(t.channel === 'EMAIL' && looksLikeListedEmail(t.summary)))
      .map<BriefTimelineItem>((t) => ({
        id: `t:${t.id}`,
        at: t.occurredAt,
        kind: kindOfChannel(t.channel),
        direction: t.direction === 'INBOUND' ? 'in' : 'out',
        title: t.summary,
        detail: null,
        actor: t.actorLabel,
      })),
    ...input.emails.map<BriefTimelineItem>((e) => ({
      id: `m:${e.id}`,
      at: e.at,
      kind: 'email',
      direction: e.inbound ? 'in' : 'out',
      title: e.subject ?? (e.inbound ? 'Email received' : 'Email sent'),
      detail: e.preview,
      actor: e.from,
    })),
    ...input.notes.map<BriefTimelineItem>((n) => ({
      id: `n:${n.id}`,
      at: new Date(n.createdAt ?? Date.now()),
      kind: 'note',
      direction: 'neutral',
      title: n.title || 'Note',
      detail: (n.bodyMarkdown ?? '').replace(/\s+/g, ' ').trim().slice(0, 180) || null,
      actor: n.createdByName,
    })),
    ...input.stateEvents.map<BriefTimelineItem>((a) => {
      const said = describeAudit(a.action, a.details as Record<string, unknown> | null, null);
      return {
        id: `a:${a.id}`,
        at: a.createdAt,
        kind: a.action === 'meeting' ? 'meeting' : 'state',
        direction: a.action === 'replied' || a.action === 'meeting' ? 'in' : 'neutral',
        title: said.title,
        detail: auditDetailText(said.fields),
        actor: a.actorLabel,
      };
    }),
  ];

  // Twenty keeps a "last call" and "last email" stamp per person, maintained by its own
  // automations. For anyone the pod worked before Cadence existed that is the only history
  // there is, so it belongs on the clock - but only when nothing already covers that moment.
  const covered = (at: Date, kind: BriefTimelineItem['kind']) =>
    items.some((x) => x.kind === kind && Math.abs(x.at.getTime() - at.getTime()) < 5 * 60_000);
  for (const [at, kind, title] of [
    [input.crm.lastCallAt, 'call' as const, 'Called, according to Twenty'],
    [input.crm.lastEmailAt, 'email' as const, 'Emailed, according to Twenty'],
  ] as const) {
    if (at && !covered(at, kind)) {
      items.push({ id: `crm:${kind}`, at, kind, direction: 'out', title, detail: null, actor: null });
    }
  }

  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 24);
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
