import type { Prisma } from '@prisma/client';
import { workspaceTimezone } from './workspace';
import { prisma } from './db';
import { enrollmentByReply, REPLY_TOUCH_WHERE, type CreditedEnrollment } from './reply-credit';
import type { SessionUser } from './auth/current-user';
import { isJuniorFo, visiblePodIds } from './auth/rbac';
import { addDays, dayOfWeek, diffDays, formatLocalDate, isLocalDate, startOfLocalDay, toLocalDate, type LocalDate } from './dates';
import { ACTION_LABELS, type ActionType } from './sequences/steps';
import { channelOf, CHANNELS, NO_PRODUCT, productLabel, productRank, SEVERAL_PRODUCTS, type Channel } from './report-keys';

export const reportingTimezone = () => workspaceTimezone();
export type ReportingRange = { from: LocalDate; to: LocalDate; fromInstant: Date; toInstant: Date; error: string | null };

/** Inclusive calendar dates, translated to a half-open Central Time interval (including DST). */
export function reportingRange(from: string | undefined, to: string | undefined, today: LocalDate, defaultDays = 28): ReportingRange {
  let first = from || addDays(today, 1 - defaultDays);
  let last = to || today;
  let error: string | null = null;
  if (!isLocalDate(first) || !isLocalDate(last) || first > last) {
    error = 'Choose valid dates with the start on or before the end.';
    first = addDays(today, 1 - defaultDays);
    last = today;
  }
  return { from: first, to: last, fromInstant: startOfLocalDay(first, reportingTimezone()), toInstant: startOfLocalDay(addDays(last, 1), reportingTimezone()), error };
}

/**
 * The period a range is read against. A week to date (from a Monday or a Sunday) is compared with
 * the same days a week before, so a Monday is never set against a weekend; a whole month with the
 * whole month before; a month to date with the same days of the month before; any other few days
 * with the same days a week before. Anything longer: the same number of days just before it.
 */
export function comparisonRange(from: LocalDate, to: LocalDate): { from: LocalDate; to: LocalDate } {
  const length = diffDays(from, to) + 1;
  const weekStart = dayOfWeek(from) === 0 || dayOfWeek(from) === 1;
  if (weekStart && length <= 7) return { from: addDays(from, -7), to: addDays(to, -7) };
  if (from.endsWith('-01') && to.slice(0, 7) === from.slice(0, 7)) {
    const lastMonthEnd = addDays(from, -1), lastMonth = lastMonthEnd.slice(0, 7);
    if (addDays(to, 1).endsWith('-01')) return { from: `${lastMonth}-01`, to: lastMonthEnd };
    const day = Math.min(Number(to.slice(8)), Number(lastMonthEnd.slice(8)));
    return { from: `${lastMonth}-01`, to: `${lastMonth}-${String(day).padStart(2, '0')}` };
  }
  if (length <= 7) return { from: addDays(from, -7), to: addDays(to, -7) };
  return { from: addDays(from, -length), to: addDays(from, -1) };
}

export type ReportFilters = { range: ReportingRange; podId?: string | null; foUserId?: string | null };

export { CHANNELS, NO_PRODUCT, SEVERAL_PRODUCTS, productLabel, type Channel };

/**
 * One line of a breakdown. Sent is outreach done (an email sent, a call made, a LinkedIn touch),
 * replies are messages that came back (reply-credit.ts), meetings are the meetings recorded in
 * Meetings. Both rates are out of what was sent.
 */
export type GroupRow = {
  key: string;
  label: string;
  sent: number;
  emails: number;
  calls: number;
  answered: number;
  linkedin: number;
  /** Different people the outreach went to. */
  reached: number;
  replies: number;
  meetings: number;
  replyRate: number;
  meetingRate: number;
};

/** One bar of the time chart: a day, or a week when the period is long. */
export type SeriesBucket = { from: LocalDate; to: LocalDate; label: string; emails: number; calls: number; linkedin: number; sent: number; replies: number; meetings: number };

export type Slice = { key: string; label: string; value: number };

export type ChannelRow = { action: ActionType; label: string; done: number; observed: number; manual: number; skipped: number; open: number; overdue: number };

function enrollmentScope(user: SessionUser): Prisma.EnrollmentWhereInput {
  if (isJuniorFo(user)) return { foUserId: user.id };
  const pods = visiblePodIds(user);
  if (pods === null) return {};
  return { OR: [{ podId: { in: pods } }, { foUserId: user.id }] };
}

type Acc = GroupRow & { people: Set<string> };
const emptyRow = (key: string, label: string): Acc => ({ key, label, sent: 0, emails: 0, calls: 0, answered: 0, linkedin: 0, reached: 0, replies: 0, meetings: 0, replyRate: 0, meetingRate: 0, people: new Set() });

/** A roll-up keyed by FO, pod, campaign or product. */
class Rollup {
  private rows = new Map<string, Acc>();
  constructor(private label: (key: string) => string) {}
  private row(key: string) {
    let r = this.rows.get(key);
    if (!r) { r = emptyRow(key, this.label(key)); this.rows.set(key, r); }
    return r;
  }
  sent(key: string, channel: Channel, personId: string, answered: boolean) {
    const r = this.row(key);
    r.sent += 1;
    if (channel === 'EMAIL') r.emails += 1;
    else if (channel === 'CALL') { r.calls += 1; if (answered) r.answered += 1; }
    else r.linkedin += 1;
    r.people.add(personId);
  }
  reply(key: string) { this.row(key).replies += 1; }
  meeting(key: string) { this.row(key).meetings += 1; }
  list(order?: (a: GroupRow, b: GroupRow) => number): GroupRow[] {
    return [...this.rows.values()]
      .map(({ people, ...r }) => ({ ...r, reached: people.size, replyRate: r.sent ? r.replies / r.sent : 0, meetingRate: r.sent ? r.meetings / r.sent : 0 }))
      .sort(order ?? ((a, b) => b.sent - a.sent || b.replies - a.replies || a.label.localeCompare(b.label)));
  }
}

/** Days for a short period, Monday weeks for a few months, calendar months beyond a year. */
function buckets(from: LocalDate, to: LocalDate): { list: SeriesBucket[]; unit: 'day' | 'week' | 'month'; of: Map<LocalDate, number> } {
  const days = diffDays(from, to) + 1;
  const unit = days <= 35 ? 'day' : days <= 370 ? 'week' : 'month';
  const list: SeriesBucket[] = [];
  const of = new Map<LocalDate, number>();
  let start = from;
  while (start <= to) {
    let end: LocalDate;
    if (unit === 'day') end = start;
    else if (unit === 'week') end = addDays(start, 6 - ((dayOfWeek(start) + 6) % 7));
    else end = addDays(`${addDays(`${start.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);
    if (end > to) end = to;
    const label = unit === 'month' ? formatLocalDate(start, 'month') : formatLocalDate(start);
    list.push({ from: start, to: end, label, emails: 0, calls: 0, linkedin: 0, sent: 0, replies: 0, meetings: 0 });
    for (let d = start; d <= end; d = addDays(d, 1)) of.set(d, list.length - 1);
    start = addDays(end, 1);
  }
  return { list, unit, of };
}


export type Reports = Awaited<ReturnType<typeof buildReports>>;

/**
 * The report for one period. Every read is bounded by the period, and every record is bucketed
 * once, so a 90-day or year-long range costs about what a week does.
 */
export async function buildReports(user: SessionUser, today: LocalDate, filters?: ReportFilters) {
  const range = filters?.range ?? reportingRange(undefined, undefined, today);
  const tz = reportingTimezone();
  const podId = filters?.podId ?? null;
  const foUserId = filters?.foUserId ?? null;
  const scope: Prisma.EnrollmentWhereInput = { AND: [enrollmentScope(user), ...(podId ? [{ podId }] : []), ...(foUserId ? [{ foUserId }] : [])] };
  const between = { gte: range.fromInstant, lt: range.toInstant };
  const junior = isJuniorFo(user);
  const visiblePods = visiblePodIds(user);
  // The same test in code, for what is credited after the read (replies, meetings).
  const inScope = (e: { foUserId: string; podId: string | null }) =>
    (!junior || e.foUserId === user.id)
    && (visiblePods === null || e.foUserId === user.id || (!!e.podId && visiblePods.includes(e.podId)))
    && (!podId || e.podId === podId)
    && (!foUserId || e.foUserId === foUserId);

  const [done, other, replyTouches, meetings, users, pods, settings] = await Promise.all([
    prisma.task.findMany({
      where: { state: 'DONE', completedAt: between, enrollment: scope },
      select: { action: true, chosenAction: true, disposition: true, completedAt: true, completionSource: true, foUserId: true, enrollment: { select: { personId: true, podId: true, campaignId: true } } },
    }),
    // For the channel table: what was skipped in the period, and what is due in it and still open.
    prisma.task.findMany({
      where: { AND: [{ enrollment: scope }, { OR: [{ state: 'SKIPPED', OR: [{ completedAt: between }, { completedAt: null, updatedAt: between }] }, { state: 'PENDING', dueDate: { gte: range.from, lte: range.to }, enrollment: { status: { not: 'PAUSED' } } }] }] },
      select: { state: true, action: true, dueDate: true, snoozedTo: true },
    }),
    // Replies: what came back from people we reached out to - see reply-credit.ts.
    prisma.touch.findMany({
      where: { AND: [REPLY_TOUCH_WHERE, { occurredAt: between, person: { deletedAt: null, enrollments: { some: scope } } }] },
      select: { id: true, occurredAt: true, personId: true },
    }),
    prisma.meeting.findMany({
      where: { review: 'APPROVED', occurredAt: between },
      select: { id: true, occurredAt: true, products: true, bookedById: true, createdById: true, attendees: { where: { personId: { not: null } }, select: { personId: true } } },
    }),
    prisma.user.findMany({ select: { id: true, name: true, pods: { select: { podId: true } } } }),
    prisma.pod.findMany({ select: { id: true, name: true } }),
    import('./settings').then((m) => m.getSettings()),
  ]);

  // Credit replies, and meetings, to the outreach that was running for that person at the time.
  const meetingKeys = meetings.flatMap((m) => m.attendees.map((a) => ({ id: `${m.id}:${a.personId}`, personId: a.personId!, occurredAt: m.occurredAt })));
  const [creditedReplies, creditedMeetings] = await Promise.all([enrollmentByReply(replyTouches), enrollmentByReply(meetingKeys)]);
  const campaignIds = new Set<string>();
  for (const t of done) if (t.enrollment.campaignId) campaignIds.add(t.enrollment.campaignId);
  for (const e of [...creditedReplies.values(), ...creditedMeetings.values()]) if (e.campaignId) campaignIds.add(e.campaignId);
  const campaigns = campaignIds.size ? await prisma.campaign.findMany({ where: { id: { in: [...campaignIds] } }, select: { id: true, name: true, productInterest: true } }) : [];

  const userName = new Map(users.map((u) => [u.id, u.name]));
  const userPod = new Map(users.map((u) => [u.id, u.pods[0]?.podId ?? null]));
  const podName = new Map(pods.map((p) => [p.id, p.name]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const productsOf = (campaignId: string | null) => {
    const list = campaignId ? campaignById.get(campaignId)?.productInterest ?? [] : [];
    return list.length ? list : [NO_PRODUCT];
  };
  const answeredKeys = new Set(settings.rules.callDispositions.filter((d) => d.answered).map((d) => d.key));

  const byFo = new Rollup((k) => userName.get(k) ?? 'Unknown');
  const byPod = new Rollup((k) => (k === 'none' ? 'No pod' : podName.get(k) ?? 'Archived pod'));
  const byCampaign = new Rollup((k) => (k === 'none' ? 'Not in a campaign' : campaignById.get(k)?.name ?? 'Deleted campaign'));
  const byProduct = new Rollup(productLabel);
  const series = buckets(range.from, range.to);
  const dayIndex = (at: Date) => series.of.get(toLocalDate(at, tz));
  const people = new Set<string>();
  const sentBy: Record<Channel, number> = { EMAIL: 0, CALL: 0, LINKEDIN: 0 };
  let answered = 0;

  for (const t of done) {
    const action = t.chosenAction ?? t.action;
    const channel = channelOf(action);
    const isAnswered = channel === 'CALL' && !!t.disposition && answeredKeys.has(t.disposition);
    const personId = t.enrollment.personId;
    people.add(personId);
    sentBy[channel] += 1;
    if (isAnswered) answered += 1;
    byFo.sent(t.foUserId, channel, personId, isAnswered);
    byPod.sent(t.enrollment.podId ?? 'none', channel, personId, isAnswered);
    byCampaign.sent(t.enrollment.campaignId ?? 'none', channel, personId, isAnswered);
    for (const p of productsOf(t.enrollment.campaignId)) byProduct.sent(p, channel, personId, isAnswered);
    const i = t.completedAt ? dayIndex(t.completedAt) : undefined;
    if (i !== undefined) {
      const b = series.list[i];
      b.sent += 1;
      if (channel === 'EMAIL') b.emails += 1; else if (channel === 'CALL') b.calls += 1; else b.linkedin += 1;
    }
  }

  let replies = 0;
  const repliedPeople = new Set<string>();
  for (const r of replyTouches) {
    const e = creditedReplies.get(r.id);
    // Only replies to outreach: a message from someone nobody reached out to answers nothing here.
    if (!e || !inScope(e)) continue;
    replies += 1;
    repliedPeople.add(r.personId);
    byFo.reply(e.foUserId);
    byPod.reply(e.podId ?? 'none');
    byCampaign.reply(e.campaignId ?? 'none');
    for (const p of productsOf(e.campaignId)) byProduct.reply(p);
    const i = dayIndex(r.occurredAt);
    if (i !== undefined) series.list[i].replies += 1;
  }

  // A meeting belongs to the FO who booked it, to the campaign that was reaching its contact, and
  // to the products it is tagged with (else that campaign's products).
  let meetingCount = 0;
  const meetingSlices = new Map<string, number>();
  for (const m of meetings) {
    const credit: CreditedEnrollment | undefined = m.attendees.map((a) => creditedMeetings.get(`${m.id}:${a.personId}`)).find(Boolean);
    const fo = m.bookedById ?? m.createdById ?? credit?.foUserId ?? null;
    if (!fo) continue;
    const pod = credit?.podId ?? userPod.get(fo) ?? null;
    if (!inScope({ foUserId: fo, podId: pod })) continue;
    meetingCount += 1;
    byFo.meeting(fo);
    byPod.meeting(pod ?? 'none');
    byCampaign.meeting(credit?.campaignId ?? 'none');
    const tagged = m.products.length ? [...m.products] : productsOf(credit?.campaignId ?? null).filter((p) => p !== NO_PRODUCT);
    for (const p of tagged.length ? tagged : [NO_PRODUCT]) byProduct.meeting(p);
    const slice = tagged.length === 1 ? tagged[0] : tagged.length ? SEVERAL_PRODUCTS : NO_PRODUCT;
    meetingSlices.set(slice, (meetingSlices.get(slice) ?? 0) + 1);
    const i = dayIndex(m.occurredAt);
    if (i !== undefined) series.list[i].meetings += 1;
  }

  const observed = new Map<string, number>();
  const manual = new Map<string, number>();
  const doneBy = new Map<string, number>();
  for (const t of done) {
    const a = t.chosenAction ?? t.action;
    doneBy.set(a, (doneBy.get(a) ?? 0) + 1);
    if (t.completionSource?.startsWith('OBSERVED')) observed.set(a, (observed.get(a) ?? 0) + 1);
    else if (t.completionSource === 'MANUAL') manual.set(a, (manual.get(a) ?? 0) + 1);
  }
  const channels: ChannelRow[] = (Object.keys(ACTION_LABELS) as ActionType[]).map((action) => {
    const mine = other.filter((t) => t.action === action);
    const open = mine.filter((t) => t.state === 'PENDING');
    return {
      action,
      label: ACTION_LABELS[action],
      done: doneBy.get(action) ?? 0,
      observed: observed.get(action) ?? 0,
      manual: manual.get(action) ?? 0,
      skipped: mine.filter((t) => t.state === 'SKIPPED').length,
      open: open.length,
      overdue: open.filter((t) => (t.snoozedTo ?? t.dueDate) < today).length,
    };
  });

  const products = byProduct.list((a, b) => (a.key === NO_PRODUCT ? 1 : 0) - (b.key === NO_PRODUCT ? 1 : 0) || productRank(a.key) - productRank(b.key));
  const sliceOrder = (k: string) => (k === NO_PRODUCT ? 99 : k === SEVERAL_PRODUCTS ? 98 : productRank(k));
  const sent = sentBy.EMAIL + sentBy.CALL + sentBy.LINKEDIN;

  return {
    today,
    range: { from: range.from, to: range.to },
    unit: series.unit,
    series: series.list,
    totals: { sent, emails: sentBy.EMAIL, calls: sentBy.CALL, answered, linkedin: sentBy.LINKEDIN, reached: people.size, replies, repliedPeople: repliedPeople.size, meetings: meetingCount, replyRate: sent ? replies / sent : 0, meetingRate: sent ? meetingCount / sent : 0 },
    sentByChannel: CHANNELS.map((c) => ({ key: c.key, label: c.label, value: sentBy[c.key] })) as Slice[],
    meetingsByProduct: [...meetingSlices.entries()].map(([key, value]) => ({ key, label: productLabel(key), value })).sort((a, b) => sliceOrder(a.key) - sliceOrder(b.key)) as Slice[],
    byFo: byFo.list(),
    byPod: byPod.list(),
    byCampaign: byCampaign.list(),
    byProduct: products,
    channels,
  };
}
