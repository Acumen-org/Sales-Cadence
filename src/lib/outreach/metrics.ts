import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { getSettings } from '../settings';
import { callOutcomes } from '../engine/outcomes';
import { ANSWERED_CALL_PREFIX } from '../reply-credit';
import { channelOf } from '../sequences/steps';
import { addDays, startOfLocalDay, todayIn, toLocalDate } from '../dates';
import { workspaceTimezone } from '../workspace';
import { countTaskWhere, countWhere, type AudienceScope } from '../subject';

/**
 * Shared metrics (cold outreach PLAN 8.14): every figure Home and Reports both show, defined once.
 * Each takes a scope (one rep, one pod, everyone), an audience (CRM, Cold outreach, All outreach)
 * and a period [from, to), and reads the audience stamped on each row when it was written (8.4), so
 * Home and Reports agree by construction (B096) and a move never rewrites a past figure (B037).
 * Neither may count these any other way.
 *
 *   sent           outreach steps done: an email sent, a call made, a LinkedIn touch (Task DONE)
 *   dials          outbound calls (CallLog), discarded ones left out (B024)
 *   connects       those the person answered: the form says so, or 30+ seconds of talk before it is in
 *   replies        messages that came back, and calls they answered (the one reply rule)
 *   meetingsBooked post-call forms with "Meeting booked"
 *   meetingsHeld   CRM meetings recorded in Meetings; cold ones are meeting next steps marked done
 *   peopleReached  different people a step was done for or a call was made to
 *
 * One email counts once (PLAN 6 rule 2): the CRM's record of an email to an "Also in CRM" cold
 * contact is a copy of the cold touch (Touch.copyOfTouchId) and is left out of every figure, so
 * All outreach = CRM + Cold holds and the email is counted in Cold, where the work was done.
 *
 * Home's team board asks for every rep at once: repliesByRep, dialsByRep and meetingsByRep give, for
 * each rep, exactly what the single-rep call gives, from the same reads.
 */

export type MetricScope = { kind: 'all' } | { kind: 'pod'; podId: string } | { kind: 'rep'; userId: string };
export type Period = { from: Date; to: Date };
export type Metrics = { sent: number; emails: number; linkedin: number; callSteps: number; dials: number; connects: number; replies: number; meetingsBooked: number; meetingsHeld: number; peopleReached: number };

const between = (p: Period) => ({ gte: p.from, lt: p.to });

async function podUsers(podId: string): Promise<string[]> {
  return (await prisma.userPod.findMany({ where: { podId }, select: { userId: true } })).map((u) => u.userId);
}

/** Steps done in the period, by channel, and who they reached. */
export async function sentSteps(scope: MetricScope, audience: AudienceScope, period: Period) {
  const tasks = await prisma.task.findMany({
    where: { AND: [countTaskWhere(audience), { state: 'DONE', completedAt: between(period) }, scope.kind === 'rep' ? { foUserId: scope.userId } : scope.kind === 'pod' ? { enrollment: { podId: scope.podId } } : {}] },
    select: { action: true, chosenAction: true, enrollment: { select: { personId: true, sandboxContactId: true } } },
  });
  const by = { EMAIL: 0, CALL: 0, LINKEDIN: 0 };
  const people = new Set<string>();
  for (const t of tasks) {
    by[channelOf(t.chosenAction ?? t.action)] += 1;
    people.add(t.enrollment.personId ? `p:${t.enrollment.personId}` : `c:${t.enrollment.sandboxContactId}`);
  }
  return { sent: tasks.length, emails: by.EMAIL, callSteps: by.CALL, linkedin: by.LINKEDIN, people };
}

/** Outbound calls in the period, not discarded (B024), credited to the rep who made them (rule 5). */
const dialWhere = (audience: AudienceScope, period: Period): Prisma.CallLogWhereInput => ({ ...countWhere(audience), direction: 'OUTBOUND', discardedAt: null, startedAt: between(period) });

/** Dials per rep in the period, as callFigures counts them for one. */
export async function dialsByRep(userIds: string[], audience: AudienceScope, period: Period): Promise<Map<string, number>> {
  const rows = userIds.length ? await prisma.callLog.groupBy({ by: ['userId'], where: { ...dialWhere(audience, period), userId: { in: userIds } }, _count: { _all: true } }) : [];
  return new Map(rows.flatMap((r) => (r.userId ? [[r.userId, r._count._all] as const] : [])));
}

/** Outbound calls in the period, and those that connected. */
export async function callFigures(scope: MetricScope, audience: AudienceScope, period: Period) {
  const settings = await getSettings();
  const answered = new Set(callOutcomes(settings.rules).filter((o) => o.answered).map((o) => o.key));
  const calls = await prisma.callLog.findMany({
    where: { ...dialWhere(audience, period), ...(scope.kind === 'rep' ? { userId: scope.userId } : scope.kind === 'pod' ? { podId: scope.podId } : {}) },
    select: { status: true, talkSec: true, personId: true, sandboxContactId: true, form: { select: { outcome: true } } },
  });
  const connected = (c: (typeof calls)[number]) => (c.form ? answered.has(c.form.outcome) : c.status === 'COMPLETED' && (c.talkSec ?? 0) >= settings.calling.connectSeconds);
  const people = new Set(calls.flatMap((c) => (c.personId ? [`p:${c.personId}`] : c.sandboxContactId ? [`c:${c.sandboxContactId}`] : [])));
  return { dials: calls.length, connects: calls.filter(connected).length, people };
}

/** A touch that counts: not the CRM's copy of an email already counted as cold (PLAN 6 rule 2). */
export const COUNTED_TOUCH: Prisma.TouchWhereInput = { copyOfTouchId: null };

/** The one reply rule, for both audiences: an inbound email, call or LinkedIn touch (not an auto-reply), or a call they answered; each email once. */
export const REPLY_WHERE: Prisma.TouchWhereInput = {
  AND: [
    COUNTED_TOUCH,
    {
      OR: [
        { direction: 'INBOUND', channel: { in: ['EMAIL', 'CALL', 'LINKEDIN'] }, NOT: { summary: { startsWith: 'Auto-reply' } } },
        { channel: 'CALL', summary: { startsWith: ANSWERED_CALL_PREFIX } },
      ],
    },
  ],
};

/**
 * Who each reply in the period is credited to: the rep and pod of the outreach that was running for
 * that person when it came (the latest enrollment started by that day), else the contact's owner.
 */
async function creditedReplies(audience: AudienceScope, period: Period): Promise<Array<{ rep: string | null; pod: string | null }>> {
  const touches = await prisma.touch.findMany({ where: { AND: [countWhere(audience), REPLY_WHERE, { occurredAt: between(period) }] }, select: { id: true, occurredAt: true, personId: true, sandboxContactId: true } });
  if (!touches.length) return [];
  const personIds = [...new Set(touches.flatMap((t) => (t.personId ? [t.personId] : [])))];
  const coldIds = [...new Set(touches.flatMap((t) => (!t.personId && t.sandboxContactId ? [t.sandboxContactId] : [])))];
  const enrollments = await prisma.enrollment.findMany({ where: { OR: [{ personId: { in: personIds } }, { sandboxContactId: { in: coldIds } }] }, select: { personId: true, sandboxContactId: true, foUserId: true, podId: true, startDate: true }, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }] });
  const tz = workspaceTimezone();
  const running = touches.map((t) => {
    const day = toLocalDate(t.occurredAt, tz);
    return enrollments.find((x) => (t.personId ? x.personId === t.personId : x.sandboxContactId === t.sandboxContactId) && x.startDate <= day) ?? null;
  });
  // The owners are read only for replies no outreach explains.
  const orphans = touches.filter((_, i) => !running[i]);
  const orphanPeople = [...new Set(orphans.flatMap((t) => (t.personId ? [t.personId] : [])))];
  const orphanCold = [...new Set(orphans.flatMap((t) => (!t.personId && t.sandboxContactId ? [t.sandboxContactId] : [])))];
  const [contacts, owners] = await Promise.all([
    orphanCold.length ? prisma.sandboxContact.findMany({ where: { id: { in: orphanCold } }, select: { id: true, ownerId: true, podId: true } }) : [],
    // Each person's owner in Cadence (the user behind their CRM owner) and that user's pods, in one read.
    orphanPeople.length ? prisma.$queryRaw<Array<{ personId: string; userId: string | null; podIds: string[] }>>`
      SELECT p."id" AS "personId", u."id" AS "userId", COALESCE(ARRAY(SELECT up."podId" FROM "UserPod" up WHERE up."userId" = u."id"), '{}') AS "podIds"
      FROM "PersonCache" p LEFT JOIN "User" u ON u."twentyMemberId" = p."ownerMemberId"
      WHERE p."id" = ANY(${orphanPeople}::text[])` : [],
  ]);
  return touches.map((t, i) => {
    const e = running[i];
    if (e) return { rep: e.foUserId, pod: e.podId };
    if (t.personId) {
      const owner = owners.find((o) => o.personId === t.personId && o.userId);
      return { rep: owner?.userId ?? null, pod: owner?.podIds.length === 1 ? owner.podIds[0] : null };
    }
    const c = contacts.find((x) => x.id === t.sandboxContactId);
    return { rep: c?.ownerId ?? null, pod: c?.podId ?? null };
  });
}

/** Replies in the period for everyone, one pod, or one rep: credited as creditedReplies says. */
export async function replyCount(scope: MetricScope, audience: AudienceScope, period: Period): Promise<number> {
  if (scope.kind === 'all') return prisma.touch.count({ where: { AND: [countWhere(audience), REPLY_WHERE, { occurredAt: between(period) }] } });
  const credited = await creditedReplies(audience, period);
  if (scope.kind === 'rep') return credited.filter((c) => c.rep === scope.userId).length;
  const inPod = credited.some((c) => !c.pod && c.rep) ? new Set(await podUsers(scope.podId)) : new Set<string>();
  return credited.filter((c) => c.pod === scope.podId || (!c.pod && c.rep !== null && inPod.has(c.rep))).length;
}

/** Replies per rep in the period, as replyCount counts them for one. */
export async function repliesByRep(userIds: string[], audience: AudienceScope, period: Period): Promise<Map<string, number>> {
  const wanted = new Set(userIds);
  const by = new Map<string, number>();
  for (const c of await creditedReplies(audience, period)) if (c.rep && wanted.has(c.rep)) by.set(c.rep, (by.get(c.rep) ?? 0) + 1);
  return by;
}

/** Post-call forms that booked a meeting, credited to the rep who filed them and the call's pod. */
export async function meetingsBooked(scope: MetricScope, audience: AudienceScope, period: Period): Promise<number> {
  return prisma.callForm.count({ where: { ...countWhere(audience), outcome: 'meeting_booked', submittedAt: between(period), ...(scope.kind === 'rep' ? { userId: scope.userId } : scope.kind === 'pod' ? { call: { podId: scope.podId } } : {}) } });
}

/**
 * The end of the window for meetings held: the period's end, or the end of today if sooner. A meeting
 * carries its day only (Meetings stores it at midday), so one held today counts all day (B096: Home
 * and Reports use this one window).
 */
function heldUntil(period: Period, now: Date): Date {
  const tz = workspaceTimezone();
  return new Date(Math.min(period.to.getTime(), startOfLocalDay(addDays(todayIn(tz, now), 1), tz).getTime()));
}

/**
 * Meetings that took place in the period (up to today). CRM: approved meetings in Meetings, credited
 * to whoever booked them. Cold: a contact's meeting next step marked done (B183).
 */
export async function meetingsHeld(scope: MetricScope, audience: AudienceScope, period: Period, now = new Date()): Promise<number> {
  const until = heldUntil(period, now);
  let n = 0;
  if (audience !== 'cold') {
    const users = scope.kind === 'rep' ? [scope.userId] : scope.kind === 'pod' ? await podUsers(scope.podId) : null;
    n += await prisma.meeting.count({ where: { review: 'APPROVED', occurredAt: { gte: period.from, lt: until }, ...(users ? { OR: [{ bookedById: { in: users } }, { bookedById: null, createdById: { in: users } }] } : {}) } });
  }
  if (audience !== 'crm') {
    n += await prisma.nextAction.count({ where: { audience: 'SANDBOX', kind: 'MEETING', state: 'DONE', lastDoneAt: { gte: period.from, lt: until }, ...(scope.kind === 'rep' ? { foUserId: scope.userId } : scope.kind === 'pod' ? { sandboxContact: { podId: scope.podId } } : {}) } });
  }
  return n;
}

/** Meetings booked and held per rep in the period, as meetingsBooked and meetingsHeld count them for one. Never added together (rule 7). */
export async function meetingsByRep(userIds: string[], audience: AudienceScope, period: Period, now = new Date()): Promise<{ booked: Map<string, number>; held: Map<string, number> }> {
  const booked = new Map<string, number>();
  const held = new Map<string, number>();
  if (!userIds.length) return { booked, held };
  const until = heldUntil(period, now);
  const add = (m: Map<string, number>, id: string | null) => { if (id) m.set(id, (m.get(id) ?? 0) + 1); };
  const [forms, meetings, cold] = await Promise.all([
    prisma.callForm.findMany({ where: { ...countWhere(audience), outcome: 'meeting_booked', submittedAt: between(period), userId: { in: userIds } }, select: { userId: true } }),
    audience !== 'cold' ? prisma.meeting.findMany({ where: { review: 'APPROVED', occurredAt: { gte: period.from, lt: until }, OR: [{ bookedById: { in: userIds } }, { bookedById: null, createdById: { in: userIds } }] }, select: { bookedById: true, createdById: true } }) : Promise.resolve([]),
    audience !== 'crm' ? prisma.nextAction.findMany({ where: { audience: 'SANDBOX', kind: 'MEETING', state: 'DONE', lastDoneAt: { gte: period.from, lt: until }, foUserId: { in: userIds } }, select: { foUserId: true } }) : Promise.resolve([]),
  ]);
  for (const f of forms) add(booked, f.userId);
  for (const m of meetings) add(held, m.bookedById ?? m.createdById);
  for (const x of cold) add(held, x.foUserId);
  return { booked, held };
}

/** Every figure at once. */
export async function outreachMetrics(scope: MetricScope, audience: AudienceScope, period: Period, now = new Date()): Promise<Metrics> {
  const [steps, calls, replies, booked, held] = await Promise.all([
    sentSteps(scope, audience, period), callFigures(scope, audience, period), replyCount(scope, audience, period), meetingsBooked(scope, audience, period), meetingsHeld(scope, audience, period, now),
  ]);
  return {
    sent: steps.sent, emails: steps.emails, linkedin: steps.linkedin, callSteps: steps.callSteps,
    dials: calls.dials, connects: calls.connects, replies, meetingsBooked: booked, meetingsHeld: held,
    peopleReached: new Set([...steps.people, ...calls.people]).size,
  };
}
