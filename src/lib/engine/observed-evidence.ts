import { Prisma, type Task } from '@prisma/client';
import { prisma } from '../db';
import { SYSTEM_ACTOR } from '../audit';
import { getSettings, type MatchingSettings } from '../settings';
import { isLocalDate, startOfLocalDay } from '../dates';
import { workspaceTimezone } from '../workspace';
import { actionTypesFor, classifyNoteTitle } from './matching';
import { completeTask, type EngineContext } from './tasks';

/**
 * Emails and calls Cadence saw in Twenty close the step they belong to, whoever on the team made
 * them (owner, 9 October 2026: "if a task is due or overdue and an email was to be sent and it got
 * sent, or a call was to be made, or both, once that is synced into the CRM ... the task should be
 * done"). A step opens on its date, and only what happens from that date counts for it: an email
 * sent the day before was not this step (owner, 25 September).
 *
 * Only what was observed counts: a synced email (message:<id>) or a logged note (note:<id>).
 *
 * One email or call is one touch, however many ways it reaches Cadence. Once a touch has counted -
 * it closed a step, it is a second record of one that did (the note a tool logs for a synced email,
 * a call logged twice), or it is the one behind a step someone marked done by hand - the step it
 * counted for is stored on it, so it is judged once and never offered to another step.
 */
const OBSERVED = [{ externalId: { startsWith: 'message:' } }, { externalId: { startsWith: 'note:' } }];
const DAY = 86_400_000;
/** How far apart a synced email and the note a tool logs for it can be, and how long before a Done its email can go. */
export const SAME_TOUCH_HOURS = 6;
const SAME_TOUCH_MS = SAME_TOUCH_HOURS * 3_600_000;
/** Two logs of one call land within minutes; a call a quarter of an hour later is another call. */
const DOUBLE_LOG_MS = 15 * 60_000;
/** A Done clicked just before the email went out or the call was logged. */
const AFTER_DONE_MS = 30 * 60_000;

export type TouchLike = { externalId: string; channel: string; occurredAt: Date; summary: string };

/** "Email sent: Re: Q2 update" and "[Email] Outbound email: Q2 update" are the same email. */
export function subjectKey(summary: string): string {
  let s = summary.replace(/^\s*(?:email sent|reply|auto-reply)\s*:\s*/i, '').replace(/^\s*\[email\]\s*outbound email\b\s*:?\s*/i, '');
  for (;;) {
    const next = s.replace(/^\s*(?:re|fwd?)\s*:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

const near = (a: Date, b: Date, ms: number) => Math.abs(a.getTime() - b.getTime()) <= ms;
const isMessage = (t: Pick<TouchLike, 'externalId'>) => t.externalId.startsWith('message:');
/** "Call Notes [date]" is a call written up, often the next morning. */
const writtenUp = (t: Pick<TouchLike, 'summary' | 'externalId'>, matching: MatchingSettings) => !isMessage(t) && classifyNoteTitle(t.summary, matching).kind === 'call_notes';

/**
 * Two records of one touch. Two emails Twenty synced are two emails, whatever their subject; an
 * email and the note logged for it share a subject and land within hours. Two logs of one call land
 * within minutes, and a call's written-up notes within a day.
 */
export function sameTouch(a: TouchLike, b: TouchLike, matching: MatchingSettings): boolean {
  if (a.channel !== b.channel) return false;
  if (a.externalId === b.externalId) return true;
  if (a.channel === 'EMAIL') {
    if (isMessage(a) && isMessage(b)) return false;
    const key = subjectKey(a.summary);
    return key !== '' && key === subjectKey(b.summary) && near(a.occurredAt, b.occurredAt, SAME_TOUCH_MS);
  }
  if (a.channel === 'CALL') {
    const wa = writtenUp(a, matching), wb = writtenUp(b, matching);
    return near(a.occurredAt, b.occurredAt, wa !== wb ? DAY : DOUBLE_LOG_MS);
  }
  return false;
}

async function claim(externalId: string, taskId: string) {
  await prisma.touch.updateMany({ where: { externalId, countedForTaskId: null }, data: { countedForTaskId: taskId } });
}

export type Verdict = { kind: 'free' } | { kind: 'counted'; taskId: string };

/**
 * Whether an email or call is still free to close a step, or already counted: it closed one, it is
 * a second record of one that did, or it is the one behind a step marked done by hand (the nearest
 * to that Done, sent up to six hours before it or half an hour after). A counted verdict is stored.
 */
export async function judgeTouch(personId: string, touch: TouchLike, matching: MatchingSettings): Promise<Verdict> {
  const stored = await prisma.touch.findUnique({ where: { externalId: touch.externalId }, select: { countedForTaskId: true } });
  if (stored?.countedForTaskId) return { kind: 'counted', taskId: stored.countedForTaskId };
  const closed = await prisma.task.findFirst({ where: { evidenceId: touch.externalId }, select: { id: true } });
  if (closed) { await claim(touch.externalId, closed.id); return { kind: 'counted', taskId: closed.id }; }
  if (touch.channel !== 'EMAIL' && touch.channel !== 'CALL') return { kind: 'free' };

  const at = touch.occurredAt.getTime();
  const nearby = await prisma.touch.findMany({
    where: { personId, channel: touch.channel as 'EMAIL' | 'CALL', direction: 'OUTBOUND', externalId: { not: touch.externalId }, countedForTaskId: { not: null }, occurredAt: { gte: new Date(at - DAY), lte: new Date(at + DAY) } },
    select: { externalId: true, channel: true, occurredAt: true, summary: true, countedForTaskId: true },
  });
  const twin = nearby.find((u) => sameTouch(touch, u, matching));
  if (twin?.countedForTaskId) { await claim(touch.externalId, twin.countedForTaskId); return { kind: 'counted', taskId: twin.countedForTaskId }; }

  // A step marked done in Cadence or in Twenty, with no email or call behind it yet.
  const lateBy = writtenUp(touch, matching) ? DAY : AFTER_DONE_MS;
  const byHand = await prisma.task.findMany({
    where: {
      enrollment: { personId }, state: 'DONE', action: touch.channel as 'EMAIL' | 'CALL',
      completedAt: { gte: new Date(at - lateBy), lte: new Date(at + SAME_TOUCH_MS) },
      OR: [{ evidenceId: null }, { evidenceId: { startsWith: 'twentyTask:' } }],
      countedTouches: { none: {} },
    },
    select: { id: true, completedAt: true },
  });
  const nearest = byHand
    .map((t) => ({ id: t.id, after: t.completedAt!.getTime() >= at ? 0 : 1, gap: Math.abs(t.completedAt!.getTime() - at) }))
    .sort((a, b) => a.after - b.after || a.gap - b.gap)[0];
  if (nearest) { await claim(touch.externalId, nearest.id); return { kind: 'counted', taskId: nearest.id }; }
  return { kind: 'free' };
}

/** Whether this touch is one already counted for this person, under another record or a Done. */
export async function alreadyCounted(personId: string, touch: TouchLike, matching: MatchingSettings): Promise<boolean> {
  return (await judgeTouch(personId, touch, matching)).kind === 'counted';
}

/**
 * The earliest a touch may be and still count for this task: the start of the step's day (its
 * planned date, or the day it is due), or when it opened if that was earlier - never when Cadence
 * happened to get round to opening it, which for a late step can be days after its date. Never
 * before the person joined the campaign; the live path also takes an email sent up to the grace
 * days before a first step that opened as the person was enrolled (the FO wrote, then enrolled).
 */
export async function windowStart(task: Pick<Task, 'enrollmentId' | 'stepIndex' | 'createdAt' | 'plannedDate' | 'dueDate'>, matching: MatchingSettings, options: { grace: boolean } = { grace: true }): Promise<Date> {
  const enrollment = await prisma.enrollment.findUniqueOrThrow({ where: { id: task.enrollmentId }, select: { createdAt: true } });
  const tz = workspaceTimezone();
  const days = [task.plannedDate, task.dueDate].filter((d) => isLocalDate(d)).map((d) => startOfLocalDay(d, tz).getTime());
  let opened = Math.min(task.createdAt.getTime(), ...days);
  const grace = options.grace ? matching.evidenceGraceDays * DAY : 0;
  const openedOnJoining = task.stepIndex === 0 && Math.abs(task.createdAt.getTime() - enrollment.createdAt.getTime()) < 10 * 60_000;
  if (openedOnJoining) opened = Math.min(opened, enrollment.createdAt.getTime() - grace);
  return new Date(Math.max(opened, enrollment.createdAt.getTime() - grace));
}

/** A note counts only for the channel its title says (a call note never closes an email). */
const countsFor = (t: TouchLike, action: Task['action'], matching: MatchingSettings) =>
  isMessage(t) ? action === 'EMAIL' : (actionTypesFor(classifyNoteTitle(t.summary, matching).kind, matching) as string[]).includes(action);

/**
 * Close the earliest open email or call step of this person's running campaign that a touch just
 * seen can count for. Returns a result code for the Activity log.
 */
export async function closeFromTouch(params: { personId: string; types: Array<'EMAIL' | 'CALL'>; touch: TouchLike; source: 'OBSERVED_NOTE' | 'OBSERVED_MESSAGE'; matching: MatchingSettings; ctx: EngineContext }): Promise<{ code: string; taskId?: string }> {
  const { personId, types, touch, matching } = params;
  const enrollment = await prisma.enrollment.findFirst({ where: { personId, status: 'ACTIVE' } });
  if (!enrollment) return { code: 'no_active_enrollment' };
  if (touch.occurredAt.getTime() < enrollment.createdAt.getTime() - matching.evidenceGraceDays * DAY) return { code: 'stale_evidence' };
  const tasks = await prisma.task.findMany({ where: { enrollmentId: enrollment.id, state: 'PENDING', action: { in: types } }, orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }] });
  const verdict = await judgeTouch(personId, touch, matching);
  if (verdict.kind === 'counted') return { code: 'same_touch', taskId: verdict.taskId };
  if (!tasks.length) return { code: 'no_pending_task' };
  for (const task of tasks) {
    if (touch.occurredAt < (await windowStart(task, matching))) continue;
    const r = await completeTask({ taskId: task.id, source: params.source, evidenceId: touch.externalId, chosenAction: task.action, occurredAt: touch.occurredAt }, params.ctx);
    if (!r.ok) return { code: r.reason, taskId: task.id };
    await claim(touch.externalId, task.id);
    return { code: 'completed', taskId: task.id };
  }
  return { code: 'before_step_opened' };
}

/**
 * Close these open email and call tasks from touches already recorded for the person since each
 * step opened. Returns the ids closed. The oldest free touch closes the oldest step. Closed as what
 * it is - Cadence reading Twenty - never as whoever's click started this.
 */
export async function completeFromEarlierEvidence(taskIds: string[], ctx: EngineContext): Promise<string[]> {
  if (!taskIds.length) return [];
  const tasks = await prisma.task.findMany({
    where: { id: { in: taskIds }, state: 'PENDING', action: { in: ['EMAIL', 'CALL'] }, enrollment: { status: 'ACTIVE' } },
    include: { enrollment: { select: { personId: true } } },
    orderBy: [{ stepIndex: 'asc' }, { actionIndex: 'asc' }],
  });
  if (!tasks.length) return [];
  const { matching } = await getSettings();
  const now = ctx.now ?? new Date();
  const observed: EngineContext = { ...ctx, actor: SYSTEM_ACTOR, forceGenerate: false, deferAdvance: false };
  const closed: string[] = [];
  for (const task of tasks) {
    const personId = task.enrollment.personId;
    const since = await windowStart(task, matching, { grace: false });
    const touches = await prisma.touch.findMany({
      where: { personId, direction: 'OUTBOUND', channel: task.action === 'CALL' ? 'CALL' : 'EMAIL', countedForTaskId: null, occurredAt: { gte: since, lte: now }, OR: OBSERVED },
      orderBy: { occurredAt: 'asc' },
      select: { externalId: true, channel: true, occurredAt: true, summary: true },
    });
    for (const touch of touches) {
      if (!countsFor(touch, task.action, matching)) continue;
      if ((await judgeTouch(personId, touch, matching)).kind === 'counted') continue;
      const r = await completeTask({ taskId: task.id, source: isMessage(touch) ? 'OBSERVED_MESSAGE' : 'OBSERVED_NOTE', evidenceId: touch.externalId, chosenAction: task.action, occurredAt: touch.occurredAt }, observed);
      if (r.ok) { await claim(touch.externalId, task.id); closed.push(task.id); }
      break;
    }
  }
  return closed;
}

/**
 * Every open email or call that a touch already in could close: one that came in while the step
 * was not open yet in Cadence (a late step opens after its date), while the campaign was paused, or
 * before this rule existed. One query finds the candidates - an uncounted email or call to the
 * person since the step's day began - and the rules above decide. The earliest due first.
 */
export async function catchUpObservedEvidence(ctx: EngineContext): Promise<number> {
  const { rules } = await getSettings();
  const since = new Date((ctx.now ?? new Date()).getTime() - Math.max(rules.reconcileLookbackDays, 14) * DAY);
  const tz = workspaceTimezone();
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT t.id FROM "Task" t
    JOIN "Enrollment" e ON e.id = t."enrollmentId"
    WHERE t.state = 'PENDING' AND t.action::text IN ('EMAIL', 'CALL') AND e.status = 'ACTIVE'
      AND EXISTS (
        SELECT 1 FROM "Touch" x
        WHERE x."personId" = e."personId" AND x.direction = 'OUTBOUND' AND x.channel::text = t.action::text
          AND (x."externalId" LIKE 'message:%' OR x."externalId" LIKE 'note:%')
          AND x."countedForTaskId" IS NULL
          AND x."occurredAt" >= ${since}
          AND x."occurredAt" >= e."createdAt"
          AND x."occurredAt" >= LEAST(t."createdAt", (t."plannedDate" || ' 00:00')::timestamp AT TIME ZONE ${tz}, (t."dueDate" || ' 00:00')::timestamp AT TIME ZONE ${tz})
          AND NOT EXISTS (SELECT 1 FROM "Task" u WHERE u."evidenceId" = x."externalId"))
    ORDER BY t."dueDate" ASC, t.id ASC
    LIMIT 500`);
  return (await completeFromEarlierEvidence(rows.map((r) => r.id), ctx)).length;
}
