import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { getSettings, type RulesSettings } from '../settings';
import { callOutcomes } from '../call-outcomes';
import { ANSWERED_CALL_PREFIX, enrollmentByReply, type CreditedEnrollment } from '../reply-credit';
import { channelOf, type Channel } from '../report-keys';
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
 *   sent           outreach done, each once (PLAN 6 rule 8, B039, B123): steps done (Task DONE),
 *                  next steps done (not meetings), and outbound calls that closed no step
 *   dials          outbound calls (CallLog), discarded ones left out (B024)
 *   connects       those the person answered: the form says so, or 30+ seconds of talk before it is in
 *   replies        messages that came back, and calls they answered (the one reply rule)
 *   meetingsBooked post-call forms with "Meeting booked"
 *   meetingsHeld   CRM meetings recorded in Meetings; cold ones are meeting next steps marked done
 *   peopleReached  different people a step was done for or a call was made to; a cold contact and
 *                  the CRM person it is (moved, or "Also in CRM") are one person (PLAN 6, "1 in both")
 *
 * Each figure is read as rows (sentRows, dialRows, replyRows, bookedRows, heldRows), every row with
 * who it is credited to and where (Credit: the rep and the pod at the time, rules 5 and 6) and its
 * stamped audience. The single figures below and Reports' breakdowns add up the same rows.
 *
 * One email counts once (PLAN 6 rule 2): the CRM's record of an email to an "Also in CRM" cold
 * contact is a copy of the cold touch (Touch.copyOfTouchId) and is left out of every figure, so
 * All outreach = CRM + Cold holds and the email is counted in Cold, where the work was done. A
 * rep's "They replied" and the reply Outlook tracks are joined the same way (cold-email.ts).
 *
 * Home's team board asks for every rep at once: repliesByRep, dialsByRep and meetingsByRep give, for
 * each rep, exactly what the single-rep call gives, from the same reads.
 */

export type MetricScope = { kind: 'all' } | { kind: 'pod'; podId: string } | { kind: 'rep'; userId: string };
export type Period = { from: Date; to: Date };
export type Metrics = { sent: number; emails: number; linkedin: number; callSteps: number; dials: number; connects: number; replies: number; meetingsBooked: number; meetingsHeld: number; peopleReached: number };

/** The stamp on a row: CRM, Cold outreach, or none yet (a call not matched to anyone, rule 4). */
export type Stamp = 'CRM' | 'SANDBOX' | null;
/** Who an activity counts for: the rep who did it (rule 5) and the pod at the time (rule 6). */
export type Credit = { rep: string | null; pod: string | null };
/** Who it was about. A moved contact's rows carry the CRM person too. */
export type Who = { personId: string | null; sandboxContactId: string | null };
type Row = Credit & Who & { audience: Stamp; at: Date; campaignId: string | null };

/** One piece of outreach done (rule 8). `answered`: a call the person picked up. */
export type SentRow = Row & { kind: 'step' | 'next_step' | 'call'; channel: Channel; action: string; answered: boolean; source: string | null };
export type DialRow = Row & { connected: boolean };
/** `channel`: what came back on (EMAIL, CALL, LINKEDIN), so Reports can show LinkedIn's part of Replies. */
export type ReplyRow = Row & { channel: string };
export type BookedRow = Row;
export type HeldRow = Row & { products: string[] };

type RowOptions = { /** Fill each row's pod (one more read); the per-rep figures do not need it. */ pods?: boolean };

const between = (p: Period) => ({ gte: p.from, lt: p.to });

/** Whether a row of this stamp belongs to the audience: All outreach takes every row, calls not matched yet included. */
export const inAudience = (stamp: Stamp, audience: AudienceScope) => audience === 'all' || (audience === 'crm' ? stamp === 'CRM' : stamp === 'SANDBOX');

/** Whether a credit falls in the scope. */
export function creditIn(scope: MetricScope, c: Credit): boolean {
  return scope.kind === 'all' || (scope.kind === 'rep' ? c.rep === scope.userId : c.pod === scope.podId);
}

/**
 * The pod a row with none of its own counts for: its rep's pod, their first by name when they are in
 * several (the rule S3 settled for pushes). Filled in place, one read for every rep.
 */
async function fillPods<T extends Credit>(rows: T[], opts: RowOptions = {}): Promise<T[]> {
  if (opts.pods === false) return rows;
  const reps = [...new Set(rows.flatMap((r) => (!r.pod && r.rep ? [r.rep] : [])))];
  if (!reps.length) return rows;
  const links = await prisma.userPod.findMany({ where: { userId: { in: reps } }, select: { userId: true, pod: { select: { id: true, name: true } } }, orderBy: { pod: { name: 'asc' } } });
  const first = new Map<string, string>();
  for (const l of links) if (!first.has(l.userId)) first.set(l.userId, l.pod.id);
  for (const r of rows) if (!r.pod && r.rep) r.pod = first.get(r.rep) ?? null;
  return rows;
}

/** Rows read elsewhere (Reports' open and skipped steps) take their pod by the same rule. */
export const withPods = <T extends Credit>(rows: T[]) => fillPods(rows);

const answeredKeys = (rules: Pick<RulesSettings, 'callDispositions'>) => new Set(callOutcomes(rules).filter((o) => o.answered).map((o) => o.key));

/** Outbound calls in the period, not discarded (B024), credited to the rep who made them (rule 5). */
const dialWhere = (audience: AudienceScope, period: Period): Prisma.CallLogWhereInput => ({ ...countWhere(audience), direction: 'OUTBOUND', discardedAt: null, startedAt: between(period) });

/** A call connected: the form says the person answered, or, before the form, 30+ seconds of talk. Reports > Calls uses it too. */
export function connectedBy(settings: Awaited<ReturnType<typeof getSettings>>) {
  const answered = answeredKeys(settings.rules);
  return (c: { status: string; talkSec: number | null; form: { outcome: string } | null }) => (c.form ? answered.has(c.form.outcome) : c.status === 'COMPLETED' && (c.talkSec ?? 0) >= settings.calling.connectSeconds);
}

/**
 * Outreach done in the period (rule 8), each piece once: a step done, a next step done (a meeting
 * is not outreach), and an outbound call that closed no step. A call that closed a step is that
 * step, so it is never counted twice.
 */
export async function sentRows(audience: AudienceScope, period: Period, opts: RowOptions = {}): Promise<SentRow[]> {
  const settings = await getSettings();
  const answered = answeredKeys(settings.rules);
  const connected = connectedBy(settings);
  const [tasks, nexts, calls] = await Promise.all([
    prisma.task.findMany({
      where: { AND: [countTaskWhere(audience), { state: 'DONE', completedAt: between(period) }] },
      select: { action: true, chosenAction: true, disposition: true, completedAt: true, completionSource: true, foUserId: true, enrollment: { select: { personId: true, sandboxContactId: true, podId: true, campaignId: true, audience: true } } },
    }),
    prisma.nextAction.findMany({
      where: { ...countWhere(audience), kind: 'ACTION', lastDoneAt: between(period) },
      select: { action: true, lastDoneAt: true, foUserId: true, personId: true, sandboxContactId: true, audience: true, sandboxContact: { select: { podId: true } } },
    }),
    prisma.callLog.findMany({
      where: { ...dialWhere(audience, period), taskId: null, nextActionId: null },
      select: { startedAt: true, userId: true, podId: true, campaignId: true, personId: true, sandboxContactId: true, audience: true, status: true, talkSec: true, form: { select: { outcome: true } } },
    }),
  ]);
  const rows: SentRow[] = [
    ...tasks.map((t): SentRow => {
      const action = t.chosenAction ?? t.action;
      const channel = channelOf(action);
      return { kind: 'step', channel, action, at: t.completedAt!, rep: t.foUserId, pod: t.enrollment.podId, campaignId: t.enrollment.campaignId, personId: t.enrollment.personId, sandboxContactId: t.enrollment.sandboxContactId, audience: t.enrollment.audience, answered: channel === 'CALL' && !!t.disposition && answered.has(t.disposition), source: t.completionSource };
    }),
    ...nexts.map((n): SentRow => ({ kind: 'next_step', channel: channelOf(n.action), action: n.action, at: n.lastDoneAt!, rep: n.foUserId, pod: n.sandboxContact?.podId ?? null, campaignId: null, personId: n.personId, sandboxContactId: n.sandboxContactId, audience: n.audience, answered: false, source: null })),
    ...calls.map((c): SentRow => ({ kind: 'call', channel: 'CALL', action: 'CALL', at: c.startedAt!, rep: c.userId, pod: c.podId, campaignId: c.campaignId, personId: c.personId, sandboxContactId: c.sandboxContactId, audience: c.audience, answered: connected(c), source: null })),
  ];
  return fillPods(rows, opts);
}

/** Outbound calls in the period, and whether each connected. */
export async function dialRows(audience: AudienceScope, period: Period, opts: RowOptions = {}): Promise<DialRow[]> {
  const settings = await getSettings();
  const connected = connectedBy(settings);
  const calls = await prisma.callLog.findMany({
    where: dialWhere(audience, period),
    select: { startedAt: true, userId: true, podId: true, campaignId: true, personId: true, sandboxContactId: true, audience: true, status: true, talkSec: true, form: { select: { outcome: true } } },
  });
  return fillPods(calls.map((c) => ({ at: c.startedAt!, rep: c.userId, pod: c.podId, campaignId: c.campaignId, personId: c.personId, sandboxContactId: c.sandboxContactId, audience: c.audience, connected: connected(c) })), opts);
}

/** Dials per rep in the period, as dialRows counts them for one. */
export async function dialsByRep(userIds: string[], audience: AudienceScope, period: Period): Promise<Map<string, number>> {
  const rows = userIds.length ? await prisma.callLog.groupBy({ by: ['userId'], where: { ...dialWhere(audience, period), userId: { in: userIds } }, _count: { _all: true } }) : [];
  return new Map(rows.flatMap((r) => (r.userId ? [[r.userId, r._count._all] as const] : [])));
}

/** Outbound calls in the period, and those that connected. */
export async function callFigures(scope: MetricScope, audience: AudienceScope, period: Period) {
  const calls = (await dialRows(audience, period, { pods: scope.kind === 'pod' })).filter((c) => creditIn(scope, c));
  return { dials: calls.length, connects: calls.filter((c) => c.connected).length, people: calls };
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
 * Replies in the period, each credited (rule 5): a call they answered to the rep who made it, with
 * the call's pod and campaign (B121); anything else to the rep and pod of the outreach that was
 * running for that person when it came (the latest enrollment started by that day), else the
 * contact's owner.
 */
export async function replyRows(audience: AudienceScope, period: Period, opts: RowOptions = {}): Promise<ReplyRow[]> {
  const touches = await prisma.touch.findMany({ where: { AND: [countWhere(audience), REPLY_WHERE, { occurredAt: between(period) }] }, select: { id: true, occurredAt: true, personId: true, sandboxContactId: true, audience: true, channel: true, summary: true, actorUserId: true } });
  if (!touches.length) return [];
  const isAnswered = (t: (typeof touches)[number]) => t.channel === 'CALL' && t.summary.startsWith(ANSWERED_CALL_PREFIX);
  // The call is read for its pod and campaign (Reports), or for its rep when the touch has none.
  const answered = touches.filter((t) => isAnswered(t) && (opts.pods !== false || !t.actorUserId));
  const calls = answered.length ? await prisma.callLog.findMany({ where: { touchId: { in: answered.map((t) => t.id) } }, select: { touchId: true, userId: true, podId: true, campaignId: true } }) : [];
  const callOf = new Map(calls.map((c) => [c.touchId!, c]));
  const caller = (t: (typeof touches)[number]) => (isAnswered(t) ? t.actorUserId ?? callOf.get(t.id)?.userId ?? null : null);
  const rest = touches.filter((t) => !caller(t));
  const personIds = [...new Set(rest.flatMap((t) => (t.personId ? [t.personId] : [])))];
  const coldIds = [...new Set(rest.flatMap((t) => (!t.personId && t.sandboxContactId ? [t.sandboxContactId] : [])))];
  const enrollments = rest.length ? await prisma.enrollment.findMany({ where: { OR: [{ personId: { in: personIds } }, { sandboxContactId: { in: coldIds } }] }, select: { personId: true, sandboxContactId: true, foUserId: true, podId: true, campaignId: true, startDate: true }, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }] }) : [];
  const tz = workspaceTimezone();
  const running = new Map(rest.map((t) => {
    const day = toLocalDate(t.occurredAt, tz);
    return [t.id, enrollments.find((x) => (t.personId ? x.personId === t.personId : x.sandboxContactId === t.sandboxContactId) && x.startDate <= day) ?? null] as const;
  }));
  // The owners are read only for replies no outreach explains.
  const orphans = rest.filter((t) => !running.get(t.id));
  const orphanPeople = [...new Set(orphans.flatMap((t) => (t.personId ? [t.personId] : [])))];
  const orphanCold = [...new Set(orphans.flatMap((t) => (!t.personId && t.sandboxContactId ? [t.sandboxContactId] : [])))];
  const [contacts, owners] = await Promise.all([
    orphanCold.length ? prisma.sandboxContact.findMany({ where: { id: { in: orphanCold } }, select: { id: true, ownerId: true, podId: true } }) : [],
    // Each person's owner in Cadence: the user behind their CRM owner, in one read.
    orphanPeople.length ? prisma.$queryRaw<Array<{ personId: string; userId: string | null }>>`
      SELECT p."id" AS "personId", u."id" AS "userId"
      FROM "PersonCache" p LEFT JOIN "User" u ON u."twentyMemberId" = p."ownerMemberId"
      WHERE p."id" = ANY(${orphanPeople}::text[])` : [],
  ]);
  const rows = touches.map((t): ReplyRow => {
    const base = { at: t.occurredAt, personId: t.personId, sandboxContactId: t.sandboxContactId, audience: t.audience, channel: t.channel as string };
    const rep = caller(t);
    if (rep) {
      const call = callOf.get(t.id);
      return { ...base, rep, pod: call?.podId ?? null, campaignId: call?.campaignId ?? null };
    }
    const e = running.get(t.id);
    if (e) return { ...base, rep: e.foUserId, pod: e.podId, campaignId: e.campaignId };
    if (t.personId) return { ...base, rep: owners.find((o) => o.personId === t.personId)?.userId ?? null, pod: null, campaignId: null };
    const c = contacts.find((x) => x.id === t.sandboxContactId);
    return { ...base, rep: c?.ownerId ?? null, pod: c?.podId ?? null, campaignId: null };
  });
  return fillPods(rows, opts);
}

/** Replies in the period for everyone, one pod, or one rep: credited as replyRows says. */
export async function replyCount(scope: MetricScope, audience: AudienceScope, period: Period): Promise<number> {
  if (scope.kind === 'all') return prisma.touch.count({ where: { AND: [countWhere(audience), REPLY_WHERE, { occurredAt: between(period) }] } });
  return (await replyRows(audience, period, { pods: scope.kind === 'pod' })).filter((r) => creditIn(scope, r)).length;
}

/** Replies per rep in the period, as replyCount counts them for one. */
export async function repliesByRep(userIds: string[], audience: AudienceScope, period: Period): Promise<Map<string, number>> {
  const wanted = new Set(userIds);
  const by = new Map<string, number>();
  for (const c of await replyRows(audience, period, { pods: false })) if (c.rep && wanted.has(c.rep)) by.set(c.rep, (by.get(c.rep) ?? 0) + 1);
  return by;
}

/** Post-call forms that booked a meeting, credited to the rep who filed them and the call's pod. */
export async function bookedRows(audience: AudienceScope, period: Period, opts: RowOptions = {}): Promise<BookedRow[]> {
  const forms = await prisma.callForm.findMany({ where: { ...countWhere(audience), outcome: 'meeting_booked', submittedAt: between(period) }, select: { userId: true, audience: true, submittedAt: true, call: { select: { podId: true, campaignId: true, personId: true, sandboxContactId: true } } } });
  return fillPods(forms.map((f) => ({ at: f.submittedAt, rep: f.userId, pod: f.call.podId, campaignId: f.call.campaignId, personId: f.call.personId, sandboxContactId: f.call.sandboxContactId, audience: f.audience })), opts);
}

export async function meetingsBooked(scope: MetricScope, audience: AudienceScope, period: Period): Promise<number> {
  return (await bookedRows(audience, period, { pods: scope.kind === 'pod' })).filter((r) => creditIn(scope, r)).length;
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
 * to whoever booked them, else whoever added them, else the rep of the outreach that was reaching an
 * attendee (B096: one credit for Home and Reports); its pod and campaign are that outreach's. Cold: a
 * contact's meeting next step marked done (B183).
 */
export async function heldRows(audience: AudienceScope, period: Period, now = new Date(), opts: RowOptions & { /** Read each meeting's outreach even when someone booked it (Reports' pods and campaigns). */ full?: boolean } = {}): Promise<HeldRow[]> {
  const until = heldUntil(period, now);
  const [meetings, cold] = await Promise.all([
    audience !== 'cold' ? prisma.meeting.findMany({ where: { review: 'APPROVED', occurredAt: { gte: period.from, lt: until } }, select: { id: true, occurredAt: true, products: true, bookedById: true, createdById: true } }) : Promise.resolve([]),
    // The contact's pod is read only when pods are wanted (Home's board needs none).
    audience !== 'crm' ? prisma.nextAction.findMany({ where: { audience: 'SANDBOX', kind: 'MEETING', state: 'DONE', lastDoneAt: { gte: period.from, lt: until } }, select: { lastDoneAt: true, foUserId: true, personId: true, sandboxContactId: true, ...(opts.pods === false ? {} : { sandboxContact: { select: { podId: true } } }) } }) : Promise.resolve([]),
  ]);
  // The attendees, and the outreach reaching them, are read only for what needs them.
  const needs = meetings.filter((m) => opts.full || !(m.bookedById ?? m.createdById));
  const attendees = needs.length ? await prisma.meetingAttendee.findMany({ where: { meetingId: { in: needs.map((m) => m.id) }, personId: { not: null } }, select: { meetingId: true, personId: true }, orderBy: { id: 'asc' } }) : [];
  const at = new Map(meetings.map((m) => [m.id, m.occurredAt]));
  const keys = attendees.map((a) => ({ id: `${a.meetingId}:${a.personId}`, personId: a.personId!, occurredAt: at.get(a.meetingId)! }));
  const credited: Map<string, CreditedEnrollment> = keys.length ? await enrollmentByReply(keys) : new Map();
  const rows: HeldRow[] = [
    ...meetings.map((m): HeldRow => {
      const mine = attendees.filter((a) => a.meetingId === m.id);
      const e = mine.map((a) => credited.get(`${m.id}:${a.personId}`)).find(Boolean) ?? null;
      return { at: m.occurredAt, rep: m.bookedById ?? m.createdById ?? e?.foUserId ?? null, pod: e?.podId ?? null, campaignId: e?.campaignId ?? null, personId: mine[0]?.personId ?? null, sandboxContactId: null, audience: 'CRM', products: m.products };
    }),
    ...cold.map((x): HeldRow => ({ at: x.lastDoneAt!, rep: x.foUserId, pod: (x as { sandboxContact?: { podId: string | null } | null }).sandboxContact?.podId ?? null, campaignId: null, personId: x.personId, sandboxContactId: x.sandboxContactId, audience: 'SANDBOX', products: [] })),
  ];
  return fillPods(rows, opts);
}

export async function meetingsHeld(scope: MetricScope, audience: AudienceScope, period: Period, now = new Date()): Promise<number> {
  return (await heldRows(audience, period, now, { pods: scope.kind === 'pod' })).filter((r) => creditIn(scope, r)).length;
}

/** Meetings booked and held per rep in the period, as meetingsBooked and meetingsHeld count them for one. Never added together (rule 7). */
export async function meetingsByRep(userIds: string[], audience: AudienceScope, period: Period, now = new Date()): Promise<{ booked: Map<string, number>; held: Map<string, number> }> {
  const booked = new Map<string, number>();
  const held = new Map<string, number>();
  if (!userIds.length) return { booked, held };
  const wanted = new Set(userIds);
  const add = (m: Map<string, number>, id: string | null) => { if (id && wanted.has(id)) m.set(id, (m.get(id) ?? 0) + 1); };
  const [forms, meetings] = await Promise.all([bookedRows(audience, period, { pods: false }), heldRows(audience, period, now, { pods: false })]);
  for (const f of forms) add(booked, f.rep);
  for (const m of meetings) add(held, m.rep);
  return { booked, held };
}

/** One key per person for these rows: a cold contact with a CRM twin (moved, or "Also in CRM") takes the twin's. One read. */
export async function personKeyOf(rows: Who[]): Promise<(r: Who) => string | null> {
  const coldOnly = [...new Set(rows.flatMap((r) => (!r.personId && r.sandboxContactId ? [r.sandboxContactId] : [])))];
  const twins = coldOnly.length ? await prisma.sandboxContact.findMany({ where: { id: { in: coldOnly } }, select: { id: true, twentyPersonId: true, crmMatchPersonId: true, crmAutoPersonId: true } }) : [];
  const twinOf = new Map(twins.map((c) => [c.id, c.twentyPersonId ?? c.crmMatchPersonId ?? c.crmAutoPersonId ?? null]));
  return (r: Who) => {
    if (r.personId) return `p:${r.personId}`;
    if (!r.sandboxContactId) return null;
    const twin = twinOf.get(r.sandboxContactId);
    return twin ? `p:${twin}` : `c:${r.sandboxContactId}`;
  };
}

/**
 * People tiles count each person once (PLAN 6): a cold contact and the CRM person it is (moved, or
 * "Also in CRM") are one person, so All outreach reads "10 people · 7 CRM · 4 Cold · 1 in both" and
 * is not CRM + Cold. A row with no one (a call not matched yet) is nobody.
 */
export async function peopleSplit(rows: Array<Who & { audience: Stamp }>): Promise<{ all: number; crm: number; cold: number; both: number }> {
  const key = await personKeyOf(rows);
  const all = new Set<string>(), crm = new Set<string>(), cold = new Set<string>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    all.add(k);
    if (r.audience === 'CRM') crm.add(k);
    else if (r.audience === 'SANDBOX') cold.add(k);
  }
  return { all: all.size, crm: crm.size, cold: cold.size, both: [...crm].filter((k) => cold.has(k)).length };
}

/** Outreach done in the period (rule 8), by channel, and who it reached. */
export async function sentSteps(scope: MetricScope, audience: AudienceScope, period: Period) {
  const rows = (await sentRows(audience, period, { pods: scope.kind === 'pod' })).filter((r) => creditIn(scope, r));
  const by = { EMAIL: 0, CALL: 0, LINKEDIN: 0 };
  for (const r of rows) by[r.channel] += 1;
  return { sent: rows.length, emails: by.EMAIL, callSteps: by.CALL, linkedin: by.LINKEDIN, people: rows };
}

/** Every figure at once. */
export async function outreachMetrics(scope: MetricScope, audience: AudienceScope, period: Period, now = new Date()): Promise<Metrics> {
  const [steps, calls, replies, booked, held] = await Promise.all([
    sentSteps(scope, audience, period), callFigures(scope, audience, period), replyCount(scope, audience, period), meetingsBooked(scope, audience, period), meetingsHeld(scope, audience, period, now),
  ]);
  const reached = await peopleSplit([...steps.people, ...calls.people]);
  return {
    sent: steps.sent, emails: steps.emails, linkedin: steps.linkedin, callSteps: steps.callSteps,
    dials: calls.dials, connects: calls.connects, replies, meetingsBooked: booked, meetingsHeld: held,
    peopleReached: audience === 'crm' ? reached.crm : audience === 'cold' ? reached.cold : reached.all,
  };
}
