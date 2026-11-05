import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { getSettings } from '../settings';
import { callOutcomes } from '../engine/outcomes';
import { ANSWERED_CALL_PREFIX } from '../reply-credit';
import { channelOf } from '../sequences/steps';
import { toLocalDate } from '../dates';
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

/** Outbound calls in the period, and those that connected. */
export async function callFigures(scope: MetricScope, audience: AudienceScope, period: Period) {
  const settings = await getSettings();
  const answered = new Set(callOutcomes(settings.rules).filter((o) => o.answered).map((o) => o.key));
  const calls = await prisma.callLog.findMany({
    where: { ...countWhere(audience), direction: 'OUTBOUND', discardedAt: null, startedAt: between(period), ...(scope.kind === 'rep' ? { userId: scope.userId } : scope.kind === 'pod' ? { podId: scope.podId } : {}) },
    select: { status: true, talkSec: true, personId: true, sandboxContactId: true, form: { select: { outcome: true } } },
  });
  const connected = (c: (typeof calls)[number]) => (c.form ? answered.has(c.form.outcome) : c.status === 'COMPLETED' && (c.talkSec ?? 0) >= settings.calling.connectSeconds);
  const people = new Set(calls.flatMap((c) => (c.personId ? [`p:${c.personId}`] : c.sandboxContactId ? [`c:${c.sandboxContactId}`] : [])));
  return { dials: calls.length, connects: calls.filter(connected).length, people };
}

/** The one reply rule, for both audiences: an inbound email, call or LinkedIn touch (not an auto-reply), or a call they answered. */
export const REPLY_WHERE: Prisma.TouchWhereInput = {
  OR: [
    { direction: 'INBOUND', channel: { in: ['EMAIL', 'CALL', 'LINKEDIN'] }, NOT: { summary: { startsWith: 'Auto-reply' } } },
    { channel: 'CALL', summary: { startsWith: ANSWERED_CALL_PREFIX } },
  ],
};

/**
 * Replies in the period. A rep or a pod is credited with the reply to the outreach that was running
 * for that person when it came (the latest enrollment started by that day), else the contact's owner.
 */
export async function replyCount(scope: MetricScope, audience: AudienceScope, period: Period): Promise<number> {
  const touches = await prisma.touch.findMany({ where: { AND: [countWhere(audience), REPLY_WHERE, { occurredAt: between(period) }] }, select: { id: true, occurredAt: true, personId: true, sandboxContactId: true } });
  if (scope.kind === 'all' || !touches.length) return touches.length;
  const personIds = [...new Set(touches.flatMap((t) => (t.personId ? [t.personId] : [])))];
  const coldIds = [...new Set(touches.flatMap((t) => (!t.personId && t.sandboxContactId ? [t.sandboxContactId] : [])))];
  const [enrollments, contacts, people] = await Promise.all([
    prisma.enrollment.findMany({ where: { OR: [{ personId: { in: personIds } }, { sandboxContactId: { in: coldIds } }] }, select: { personId: true, sandboxContactId: true, foUserId: true, podId: true, startDate: true }, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }] }),
    coldIds.length ? prisma.sandboxContact.findMany({ where: { id: { in: coldIds } }, select: { id: true, ownerId: true, podId: true } }) : [],
    personIds.length ? prisma.personCache.findMany({ where: { id: { in: personIds } }, select: { id: true, ownerMemberId: true } }) : [],
  ]);
  const owners = await prisma.user.findMany({ where: { twentyMemberId: { in: people.flatMap((p) => (p.ownerMemberId ? [p.ownerMemberId] : [])) } }, select: { id: true, twentyMemberId: true, pods: { select: { podId: true } } } });
  const inPod = scope.kind === 'pod' ? new Set(await podUsers(scope.podId)) : null;
  const tz = workspaceTimezone();
  let n = 0;
  for (const t of touches) {
    const day = toLocalDate(t.occurredAt, tz);
    const e = enrollments.find((x) => (t.personId ? x.personId === t.personId : x.sandboxContactId === t.sandboxContactId) && x.startDate <= day);
    let rep: string | null = e?.foUserId ?? null;
    let pod: string | null = e?.podId ?? null;
    if (!e) {
      if (t.personId) {
        const member = people.find((p) => p.id === t.personId)?.ownerMemberId;
        const owner = owners.find((u) => u.twentyMemberId === member);
        rep = owner?.id ?? null;
        pod = owner?.pods.length === 1 ? owner.pods[0].podId : null;
      } else {
        const c = contacts.find((x) => x.id === t.sandboxContactId);
        rep = c?.ownerId ?? null;
        pod = c?.podId ?? null;
      }
    }
    if (scope.kind === 'rep' ? rep === scope.userId : pod === scope.podId || (!pod && rep !== null && inPod!.has(rep))) n++;
  }
  return n;
}

/** Post-call forms that booked a meeting, credited to the rep who filed them and the call's pod. */
export async function meetingsBooked(scope: MetricScope, audience: AudienceScope, period: Period): Promise<number> {
  return prisma.callForm.count({ where: { ...countWhere(audience), outcome: 'meeting_booked', submittedAt: between(period), ...(scope.kind === 'rep' ? { userId: scope.userId } : scope.kind === 'pod' ? { call: { podId: scope.podId } } : {}) } });
}

/**
 * Meetings that took place in the period (up to `now`). CRM: approved meetings in Meetings, credited
 * to whoever booked them. Cold: a contact's meeting next step marked done (B183).
 */
export async function meetingsHeld(scope: MetricScope, audience: AudienceScope, period: Period, now = new Date()): Promise<number> {
  const until = new Date(Math.min(period.to.getTime(), now.getTime()));
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
