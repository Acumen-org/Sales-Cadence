import { Prisma, type Task } from '@prisma/client';
import { prisma } from '../db';
import { SYSTEM_ACTOR } from '../audit';
import { getSettings, type MatchingSettings } from '../settings';
import { channelOf } from '../sequences/steps';
import { actionTypesFor, classifyNoteTitle } from './matching';
import { completeTask, type EngineContext } from './tasks';

/**
 * Emails and calls Cadence saw in Twenty close the step they belong to (owner, 24 September 2026:
 * "the tasks are not auto closing when emailing or calling has happened"). A touch made before its
 * step opened - a campaign whose batch starts on Monday, emailed on Thursday - is kept and counted
 * the moment the step opens, and a scheduler pass catches any open step whose touch is already in.
 *
 * Only what was observed counts: a synced email (message:<id>) or a logged note (note:<id>). A task
 * marked done by hand writes task:<id>, which is never evidence for another step.
 *
 * One email or call is one touch, however many ways it reaches Cadence. The synced message and the
 * note the team's tool logs for it, a second note for the same call, or the email behind a step the
 * FO already marked done: each of those is the touch already counted, never the next step's.
 */
const OBSERVED = [{ externalId: { startsWith: 'message:' } }, { externalId: { startsWith: 'note:' } }];
const DAY = 86_400_000;
/** How far apart two records of one touch can be: logging lags the send, a Done click lags the call. */
export const SAME_TOUCH_HOURS = 6;
const SAME_TOUCH_MS = SAME_TOUCH_HOURS * 3_600_000;

type TouchLike = { externalId: string; channel: string; occurredAt: Date; summary: string };

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

const near = (a: Date, b: Date, ms = SAME_TOUCH_MS) => Math.abs(a.getTime() - b.getTime()) < ms;
/** "Call Notes [date]" is a call written up, often the next morning: it matches a call up to a day before. */
const writtenUp = (t: Pick<TouchLike, 'summary'>, matching: MatchingSettings) => classifyNoteTitle(t.summary, matching).kind === 'call_notes';
const windowFor = (a: Pick<TouchLike, 'summary' | 'channel'>, matching: MatchingSettings) => (a.channel === 'CALL' && writtenUp(a, matching) ? DAY : SAME_TOUCH_MS);

/**
 * Two records of one touch: an email with the same subject within a few hours (a next-day "Re:"
 * is the next email), or two call records within a few hours (a double log of one call), or a
 * day when one of them is the call's written-up notes.
 */
const sameTouch = (a: TouchLike, b: TouchLike, matching: MatchingSettings) => {
  if (a.externalId === b.externalId || a.channel !== b.channel) return false;
  if (!near(a.occurredAt, b.occurredAt, Math.max(windowFor(a, matching), windowFor(b, matching)))) return false;
  if (a.channel === 'CALL') return true;
  const key = subjectKey(a.summary);
  return a.channel === 'EMAIL' && key !== '' && key === subjectKey(b.summary);
};

type Counted = { ids: Set<string>; touches: TouchLike[]; unbacked: { channel: string; at: Date }[] };

/**
 * What already counted for this person: touches that closed a step, and steps closed without one
 * (marked done in Cadence or in Twenty), whose email or call is still on its way.
 */
async function counted(personId: string): Promise<Counted> {
  const done = await prisma.task.findMany({ where: { enrollment: { personId }, state: 'DONE' }, select: { evidenceId: true, action: true, completedAt: true } });
  const ids = done.flatMap((t) => (t.evidenceId && !t.evidenceId.startsWith('twentyTask:') ? [t.evidenceId] : []));
  const touches = ids.length ? await prisma.touch.findMany({ where: { externalId: { in: ids } }, select: { externalId: true, channel: true, occurredAt: true, summary: true } }) : [];
  const unbacked = done.flatMap((t) => ((!t.evidenceId || t.evidenceId.startsWith('twentyTask:')) && t.completedAt ? [{ channel: channelOf(t.action), at: t.completedAt }] : []));
  return { ids: new Set(ids), touches, unbacked };
}

const isCounted = (t: TouchLike, c: Counted, matching: MatchingSettings) =>
  c.ids.has(t.externalId) || c.touches.some((u) => sameTouch(t, u, matching)) || c.unbacked.some((u) => u.channel === t.channel && near(u.at, t.occurredAt, windowFor(t, matching)));

/** Whether this touch is one already counted for this person, under another record or a Done. */
export async function alreadyCounted(personId: string, touch: TouchLike, matching: MatchingSettings): Promise<boolean> {
  return isCounted(touch, await counted(personId), matching);
}

/**
 * The earliest a touch may be and still count for this task: after the step before it was done,
 * or, for the first step, from when the person joined. An email arriving as it happens may be up
 * to the grace days older than the join (a step open from the start); one kept for a step that
 * opens later never is, so a note sent before the campaign cannot close its first step.
 */
export async function windowStart(task: Pick<Task, 'enrollmentId' | 'stepIndex'>, matching: MatchingSettings, options: { grace: boolean } = { grace: true }): Promise<Date> {
  const [previous, enrollment] = await Promise.all([
    prisma.task.aggregate({ where: { enrollmentId: task.enrollmentId, stepIndex: { lt: task.stepIndex } }, _max: { completedAt: true } }),
    prisma.enrollment.findUniqueOrThrow({ where: { id: task.enrollmentId }, select: { createdAt: true } }),
  ]);
  return previous._max.completedAt ?? new Date(enrollment.createdAt.getTime() - (options.grace ? matching.evidenceGraceDays * DAY : 0));
}

/** A note counts only for the channel its title says (a call note never closes an email). */
const countsFor = (t: TouchLike, action: Task['action'], matching: MatchingSettings) =>
  t.externalId.startsWith('message:') ? action === 'EMAIL' : (actionTypesFor(classifyNoteTitle(t.summary, matching).kind, matching) as string[]).includes(action);

/**
 * Close these open email and call tasks from touches already recorded for the person. Returns the
 * ids closed. Each touch closes one step, the oldest first. Closed as what it is - Cadence reading
 * Twenty - never as whoever's click started this, and never moving a plan on by hand.
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
    const [touches, already] = await Promise.all([
      prisma.touch.findMany({ where: { personId, direction: 'OUTBOUND', channel: channelOf(task.action), occurredAt: { gte: since, lte: now }, OR: OBSERVED }, orderBy: { occurredAt: 'asc' }, select: { externalId: true, channel: true, occurredAt: true, summary: true } }),
      counted(personId),
    ]);
    const touch = touches.find((t) => !isCounted(t, already, matching) && countsFor(t, task.action, matching));
    if (!touch) continue;
    const r = await completeTask({ taskId: task.id, source: touch.externalId.startsWith('message:') ? 'OBSERVED_MESSAGE' : 'OBSERVED_NOTE', evidenceId: touch.externalId, chosenAction: task.action, occurredAt: touch.occurredAt }, observed);
    if (r.ok) closed.push(task.id);
  }
  return closed;
}

/**
 * Every open email or call whose touch is already in: an email that came in while its step was
 * still ahead, or before this rule existed. One query finds them, leaving out touches that are a
 * second record of one already counted so the same ones are not tried every minute; most ticks
 * find none. The earliest due first.
 */
export async function catchUpObservedEvidence(ctx: EngineContext): Promise<number> {
  const { rules } = await getSettings();
  const since = new Date((ctx.now ?? new Date()).getTime() - Math.max(rules.reconcileLookbackDays, 7) * DAY);
  const window = Prisma.sql`make_interval(hours => ${SAME_TOUCH_HOURS}::int)`;
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT t.id FROM "Task" t
    JOIN "Enrollment" e ON e.id = t."enrollmentId"
    WHERE t.state = 'PENDING' AND t.action::text IN ('EMAIL', 'CALL') AND e.status = 'ACTIVE'
      AND EXISTS (
        SELECT 1 FROM "Touch" x
        WHERE x."personId" = e."personId" AND x.direction = 'OUTBOUND' AND x.channel::text = t.action::text
          AND (x."externalId" LIKE 'message:%' OR x."externalId" LIKE 'note:%')
          AND x."occurredAt" >= ${since}
          AND x."occurredAt" >= COALESCE(
            (SELECT max(p."completedAt") FROM "Task" p WHERE p."enrollmentId" = e.id AND p."stepIndex" < t."stepIndex"),
            e."createdAt")
          AND NOT EXISTS (SELECT 1 FROM "Task" u WHERE u."evidenceId" = x."externalId")
          AND NOT EXISTS (
            SELECT 1 FROM "Task" u JOIN "Enrollment" ue ON ue.id = u."enrollmentId" JOIN "Touch" c ON c."externalId" = u."evidenceId"
            WHERE ue."personId" = x."personId" AND c.channel = x.channel
              AND c."occurredAt" BETWEEN x."occurredAt" - ${window} AND x."occurredAt" + ${window})
          AND NOT EXISTS (
            SELECT 1 FROM "Task" m JOIN "Enrollment" me ON me.id = m."enrollmentId"
            WHERE me."personId" = x."personId" AND m.state = 'DONE' AND m.action::text = x.channel::text
              AND (m."evidenceId" IS NULL OR m."evidenceId" LIKE 'twentyTask:%')
              AND m."completedAt" BETWEEN x."occurredAt" - ${window} AND x."occurredAt" + ${window}))
    ORDER BY t."dueDate" ASC, t.id ASC
    LIMIT 500`);
  return (await completeFromEarlierEvidence(rows.map((r) => r.id), ctx)).length;
}
