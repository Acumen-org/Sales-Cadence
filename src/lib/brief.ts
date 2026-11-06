import { prisma } from './db';
import { toActor, type SessionUser } from './auth/current-user';
import { mayHearCall } from './calls/access';
import { callOutcomes } from './call-outcomes';
import { coldRef, subjectHref } from './subject';
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
import type { TwentyOpportunity } from './twenty/types';
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
  person: NonNullable<TaskRow['enrollment']['person']>;
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
  /** Touches and sequence events on one clock, newest first. Twenty's emails and notes are CrmHistory's. */
  timeline: BriefTimelineItem[];
  colleagues: ColleagueRow[];
  nextStep: { step: SequenceStep; plannedDate: LocalDate; description: string } | null;
  /** Steps of the plan (for "move to step") and where the enrollment is. */
  steps: { index: number; day: number; label: string }[];
  currentStep: number;
  enrollment: { id: string; status: string; exitReason: string | null; startDate: string; campaignName: string | null; sequenceName: string; foName: string; shiftDays: number };
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

/** Each module of a step with its copy: the frozen snapshot, else the plan's, with the FO's saved draft on top. */
function renderModules(siblings: TaskRow[], step: SequenceStep | null): Array<{ task: TaskRow; action: RenderedAction }> {
  return siblings.map(t => {
    const snapshot = StepActionSchema.safeParse(t.actionSnapshot);
    const def = snapshot.success ? snapshot.data : step?.actions.find(a => a.id === t.actionId);
    const rendered = def ? render(def) : { type: t.action, label: t.label, subject: null, body: '', html: '<p></p>', rawTemplate: null };
    return { task: t, action: { ...rendered, subject: t.draftSubject ?? rendered.subject, html: t.draftHtml ?? rendered.html } };
  });
}

/** The step after this one and the day it is planned for. */
function nextStepOf(e: { currentStep: number; currentStepId: string | null; scheduleDates: string[]; startDate: string; shiftDays: number }, steps: SequenceStep[], workingDays: number[]): TaskBrief['nextStep'] {
  const next = previewNextStep({ currentStep: e.currentStep, currentStepId: e.currentStepId, steps });
  return next
    ? {
        step: next,
        // A published calendar holds each step's own date; otherwise it follows from the day.
        plannedDate: e.scheduleDates[steps.indexOf(next)] ?? plannedDateForStep(e.startDate, next.day, e.shiftDays, workingDays),
        description: describeStep(next),
      }
    : null;
}

/**
 * Everything an FO needs on the right-hand panel before touching someone:
 * who they are, where we met, what has happened so far, who else we know there,
 * the filled-in template for this step, and what comes next.
 */
export async function getTaskBrief(taskId: string, user: SessionUser): Promise<TaskBrief | null> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: taskRowInclude });
  if (!task) return null;
  // Everyone reads every task; who may act on it is decided where its buttons are drawn.
  void user;

  const [settings, conn, enrollmentFull] = await Promise.all([
    getSettings(),
    getTwentyConnection(),
    prisma.enrollment.findUniqueOrThrow({
      where: { id: task.enrollmentId },
      include: { sequence: true, fo: { select: { name: true } } },
    }),
  ]);
  const person = task.enrollment.person;
  // A cold contact's step has its own brief: getColdTaskBrief.
  if (!person) return null;

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
  const modules = renderModules(siblings, step);

  // Everything here is Cadence's own data, so the task opens without waiting on Twenty.
  const [touches, colleagues, stateEvents, pod, owner] = await Promise.all([
    // 20 feeds both the dot timeline and the merged timeline below it.
    prisma.touch.findMany({ where: { personId: person.id }, orderBy: { occurredAt: 'desc' }, take: 20 }),
    loadColleagues(person.companyId, person.id),
    prisma.auditLog.findMany({
      where: { entityType: 'enrollment', entityId: task.enrollmentId, action: { in: ['enrolled', 'replied', 'meeting', 'exited', 'paused', 'resumed', 'moved_to_step'] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    person.podOwner ? prisma.pod.findUnique({ where: { podOwnerValue: person.podOwner }, select: { name: true } }) : Promise.resolve(null),
    person.ownerMemberId ? prisma.user.findFirst({ where: { twentyMemberId: person.ownerMemberId }, select: { name: true } }) : Promise.resolve(null),
  ]);

  const nextStep = nextStepOf(enrollmentFull, steps, settings.rules.workingDays);

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
    timeline: buildTimeline({
      touches,
      stateEvents,
      crm: { lastCallAt: person.lastCallAt, lastEmailAt: person.lastEmailAt },
    }),
    colleagues,
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

/** One clock for everything known about this person, newest first. */
function buildTimeline(input: {
  touches: Array<{ id: string; channel: string; direction: string; occurredAt: Date; summary: string; actorLabel: string | null }>;
  stateEvents: Array<{ id: string; action: string; createdAt: Date; actorLabel: string | null; details: unknown }>;
  /** Twenty's own last-touch stamps, which exist for people Cadence never worked. */
  crm: { lastCallAt: Date | null; lastEmailAt: Date | null };
}): BriefTimelineItem[] {
  const kindOfChannel = (channel: string): BriefTimelineItem['kind'] => (channel === 'EMAIL' ? 'email' : channel === 'CALL' ? 'call' : channel === 'MEETING' ? 'meeting' : 'linkedin');

  const items: BriefTimelineItem[] = [
    ...input.touches
      .map<BriefTimelineItem>((t) => ({
        id: `t:${t.id}`,
        at: t.occurredAt,
        kind: kindOfChannel(t.channel),
        direction: t.direction === 'INBOUND' ? 'in' : 'out',
        title: t.summary,
        detail: null,
        actor: t.actorLabel,
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
    [input.crm.lastCallAt, 'call' as const, 'Called, according to the CRM'],
    [input.crm.lastEmailAt, 'email' as const, 'Emailed, according to the CRM'],
  ] as const) {
    if (at && !covered(at, kind)) {
      items.push({ id: `crm:${kind}`, at, kind, direction: 'out', title, detail: null, actor: null });
    }
  }

  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 24);
}

/** Open opportunities from Twenty, read after the task is on screen (TaskBriefPanel streams them). */
export async function fetchOpportunities(personId: string): Promise<{ opportunities: TwentyOpportunity[]; error?: string }> {
  try {
    const client = await getTwentyClient();
    const page = await client.listOpportunities({ personId, limit: 10 });
    return { opportunities: page.items };
  } catch (err) {
    return { opportunities: [], error: `The CRM is unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function describeDue(t: { dueDate: string; snoozedTo: string | null; plannedDate: string }): string {
  const parts = [formatLocalDate(t.snoozedTo ?? t.dueDate, 'long')];
  if (t.snoozedTo) parts.push(`(snoozed from ${formatLocalDate(t.dueDate)})`);
  else if (t.plannedDate !== t.dueDate) parts.push(`(planned ${formatLocalDate(t.plannedDate)}, moved by cap)`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// A cold contact's step (cold outreach PLAN 4.3): the same brief, without the CRM
// ---------------------------------------------------------------------------

export type ColdColleague = { key: string; name: string; jobTitle: string | null; href: string; /** A person in the CRM, not a cold contact: "Already in CRM". */ inCrm: boolean };
export type ColdHistoryItem = { id: string; at: Date; kind: 'call' | 'email' | 'note'; direction: 'in' | 'out' | 'neutral'; title: string; detail: string | null; actor: string | null; href: string | null };

export type ColdTaskBrief = {
  kind: 'cold';
  task: TaskRow;
  modules: Array<{ task: TaskRow; action: RenderedAction }>;
  contact: NonNullable<TaskRow['enrollment']['sandboxContact']> & { ownerName: string | null; ownerActive: boolean; podName: string | null; linkedinHref: string | null };
  name: string;
  /** The contact's own page: never a /people page (PLAN 8.13). */
  href: string;
  today: LocalDate;
  stepIndex: number;
  stepCount: number;
  step: SequenceStep | null;
  action: RenderedAction;
  nextStep: TaskBrief['nextStep'];
  steps: TaskBrief['steps'];
  currentStep: number;
  enrollment: TaskBrief['enrollment'];
  /** The firm's other contacts, and the people the CRM holds there. */
  colleagues: ColdColleague[];
  /** Calls with their forms, emails and notes, newest first: the "Cold history" card. */
  history: ColdHistoryItem[];
};

/** A LinkedIn profile as stored (linkedin.com/in/x) or in full, as a link. */
export const profileHref = (url: string | null | undefined) => (url ? (/^https?:\/\//i.test(url) ? url : `https://www.${url.replace(/^www\./i, '')}`) : null);

/**
 * The brief for a cold contact's step (B058): the step's copy and plan as for anyone, the contact's
 * details, the firm's colleagues and the cold history. Null when the task is not a cold contact's.
 */
export async function getColdTaskBrief(taskId: string, user: SessionUser): Promise<ColdTaskBrief | null> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: taskRowInclude });
  const c = task?.enrollment.sandboxContact;
  if (!task || task.enrollment.person || !c) return null;
  const [settings, enrollmentFull, siblings, firm] = await Promise.all([
    getSettings(),
    prisma.enrollment.findUniqueOrThrow({ where: { id: task.enrollmentId }, include: { sequence: true, fo: { select: { name: true } } } }),
    prisma.task.findMany({ where: { enrollmentId: task.enrollmentId, stepId: task.stepId }, include: taskRowInclude, orderBy: { actionIndex: 'asc' } }),
    prisma.sandboxContact.findUniqueOrThrow({ where: { id: c.id }, select: { companyDomain: true, companyCrd: true, owner: { select: { name: true, active: true } }, pod: { select: { name: true } } } }),
  ]);
  const steps = parseSteps(enrollmentFull.sequence.steps);
  const step = steps.find((s) => s.id === task.stepId) ?? steps[task.stepIndex] ?? null;
  const modules = renderModules(siblings, step);
  const [colleagues, history] = await Promise.all([coldColleagues(c, firm), coldHistory(c.id, c.ownerId, toActor(user))]);
  return {
    kind: 'cold',
    task,
    modules,
    contact: { ...c, ownerName: firm.owner?.name ?? null, ownerActive: firm.owner?.active ?? true, podName: firm.pod?.name ?? null, linkedinHref: profileHref(c.linkedinUrl) },
    name: `${c.firstName} ${c.lastName}`.trim() || c.email || 'Unnamed contact',
    href: subjectHref(coldRef(c.id)),
    today: todayIn(user.timezone),
    stepIndex: task.stepIndex,
    stepCount: steps.length,
    step,
    action: modules.find((m) => m.task.id === task.id)?.action ?? { type: task.action, label: task.label, subject: null, body: '', html: '<p></p>', rawTemplate: null },
    nextStep: nextStepOf(enrollmentFull, steps, settings.rules.workingDays),
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
    colleagues,
    history,
  };
}

/**
 * The firm's other live cold contacts (by CRD, else website, else name) and the people the CRM
 * holds there, marked "Already in CRM". Each links to its own page through the subject layer.
 */
async function coldColleagues(c: { id: string; companyName: string | null }, firm: { companyDomain: string | null; companyCrd: string | null }): Promise<ColdColleague[]> {
  const name = c.companyName?.trim() || null;
  const same = firm.companyCrd ? { companyCrd: firm.companyCrd } : firm.companyDomain ? { companyDomain: firm.companyDomain } : name ? { companyName: { equals: name, mode: 'insensitive' as const } } : null;
  if (!same) return [];
  // In the CRM, the same firm is the same name, or an address at the firm's domain.
  const crmWhere = [...(name ? [{ companyName: { equals: name, mode: 'insensitive' as const } }] : []), ...(firm.companyDomain ? [{ emailNorm: { endsWith: `@${firm.companyDomain.toLowerCase()}` } }] : [])];
  const [cold, crm] = await Promise.all([
    prisma.sandboxContact.findMany({ where: { ...same, id: { not: c.id }, status: 'ACTIVE' }, orderBy: { lastName: 'asc' }, take: 25, select: { id: true, firstName: true, lastName: true, jobTitle: true } }),
    crmWhere.length ? prisma.personCache.findMany({ where: { deletedAt: null, OR: crmWhere }, orderBy: { lastName: 'asc' }, take: 25, select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true } }) : Promise.resolve([]),
  ]);
  return [
    ...cold.map((x) => ({ key: `c:${x.id}`, name: `${x.firstName} ${x.lastName}`.trim() || 'Unnamed contact', jobTitle: x.jobTitle, href: subjectHref(coldRef(x.id)), inCrm: false })),
    ...crm.map((p) => ({ key: `p:${p.id}`, name: cachedPersonName(p), jobTitle: p.jobTitle, href: subjectHref({ kind: 'person', id: p.id }), inCrm: true })),
  ];
}

/** Calls with their forms, emails and notes, newest first. A call's notes show only to those who may hear it (N051). */
async function coldHistory(contactId: string, ownerId: string | null, actor: ReturnType<typeof toActor>): Promise<ColdHistoryItem[]> {
  const [settings, calls, emails, notes] = await Promise.all([
    getSettings(),
    prisma.callLog.findMany({ where: { sandboxContactId: contactId, personId: null, discardedAt: null }, orderBy: { createdAt: 'desc' }, take: 20, include: { form: { select: { outcome: true, notes: true } }, user: { select: { name: true } } } }),
    prisma.sandboxEmail.findMany({ where: { sandboxContactId: contactId }, orderBy: { at: 'desc' }, take: 20 }),
    prisma.sandboxNote.findMany({ where: { sandboxContactId: contactId }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  const outcomes = callOutcomes(settings.rules);
  const items: ColdHistoryItem[] = [
    ...calls.map((call) => {
      const outcome = call.form ? outcomes.find((o) => o.key === call.form!.outcome)?.label ?? call.form.outcome : call.formDueAt ? 'Form due' : null;
      const heard = mayHearCall(actor, { userId: call.userId, formUserId: call.formUserId, ownerId });
      return { id: `c:${call.id}`, at: call.startedAt ?? call.createdAt, kind: 'call' as const, direction: call.direction === 'INBOUND' ? 'in' as const : 'out' as const, title: [call.direction === 'INBOUND' ? 'Call received' : 'Call', outcome].filter(Boolean).join(' · '), detail: heard ? call.form?.notes ?? null : null, actor: call.user?.name ?? null, href: `/calls/${call.id}` };
    }),
    ...emails.map((m) => ({ id: `m:${m.id}`, at: m.at, kind: 'email' as const, direction: m.kind === 'SENT' ? 'out' as const : 'in' as const, title: `${m.kind === 'SENT' ? 'Email sent' : m.kind === 'REPLY' ? 'Reply' : m.kind === 'BOUNCE' ? 'Bounced' : 'Auto-reply'}: ${m.subject ?? '(no subject)'}`, detail: null, actor: null, href: null })),
    ...notes.map((n) => ({ id: `n:${n.id}`, at: n.createdAt, kind: 'note' as const, direction: 'neutral' as const, title: 'Note', detail: n.body, actor: n.authorName, href: null })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 24);
}
