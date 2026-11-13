import { workspaceTimezone } from './workspace';
import { prisma } from './db';
import type { SessionUser } from './auth/current-user';
import { isJuniorFo, visiblePodIds } from './auth/rbac';
import { addDays, dayOfWeek, diffDays, formatLocalDate, isLocalDate, startOfLocalDay, toLocalDate, type LocalDate } from './dates';
import { ACTION_LABELS, type ActionType } from './sequences/steps';
import { countTaskWhere, type AudienceScope } from './subject';
import { bookedRows, dialRows, heldRows, inAudience, personKeyOf, peopleSplit, replyRows, sentRows, withPods, type Credit, type Stamp, type Who } from './outreach/metrics';
import { doNotContactEmails } from './mail/cold-email';
import { CHANNELS, NO_PRODUCT, productLabel, productRank, SEVERAL_PRODUCTS, type Channel } from './report-keys';
import { linkedinReport, linkedinRows } from './reports-linkedin';

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

/** Which outreach a report covers (PLAN 6): All outreach, CRM, or Cold outreach. Stored as `?audience=`. */
export const REPORT_AUDIENCES: { key: AudienceScope; label: string }[] = [
  { key: 'all', label: 'All outreach' },
  { key: 'crm', label: 'CRM' },
  { key: 'cold', label: 'Cold outreach' },
];
export const parseReportAudience = (v: string | null | undefined): AudienceScope => (v === 'crm' || v === 'cold' ? v : 'all');

export type ReportFilters = { range: ReportingRange; podId?: string | null; foUserId?: string | null; audience?: AudienceScope };

export { CHANNELS, NO_PRODUCT, SEVERAL_PRODUCTS, productLabel, type Channel };

/**
 * One line of a breakdown. Sent is outreach done (rule 8: a step, a next step, a call that closed
 * none), replies are messages that came back and calls they answered, meetings are those held (in
 * Meetings, or a cold meeting marked done) and booked those the post-call form booked: two figures,
 * never added (rule 7). Both rates are out of what was sent.
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
  booked: number;
  replyRate: number;
  meetingRate: number;
  /** A cold campaign, shown with a badge (PLAN 6 "By campaign includes cold campaigns"). */
  cold?: boolean;
};

/** One bar of the time chart: a day, or a week when the period is long. */
export type SeriesBucket = { from: LocalDate; to: LocalDate; label: string; emails: number; calls: number; linkedin: number; sent: number; replies: number; meetings: number };

export type Slice = { key: string; label: string; value: number };

export type ChannelRow = { action: ActionType; label: string; done: number; observed: number; manual: number; skipped: number; open: number; overdue: number };

/**
 * The activity figures of one side (PLAN 6 "activity tiles"): additive, so All outreach = CRM + Cold,
 * and on calls + Not matched yet.
 */
export type Activity = { sent: number; emails: number; calls: number; linkedin: number; dials: number; connects: number; replies: number; meetings: number; booked: number };
/** A people figure (PLAN 6 "people tiles"): each person once, so All outreach is not CRM + Cold. */
export type People = { all: number; crm: number; cold: number; both: number };

/** Cold outreach's funnel (PLAN 6): what happened to cold contacts in the period, each contact once per stage. */
export type ColdFunnel = { added: number; fromBellwether: number; claimed: number; worked: number; connected: number; booked: number; moved: number; optedOut: number; removed: number };
export type ColdFunnelRow = { key: string; label: string; claimed: number; worked: number; connected: number; booked: number; moved: number };

type Acc = GroupRow & { people: Set<string> };
const emptyRow = (key: string, label: string): Acc => ({ key, label, sent: 0, emails: 0, calls: 0, answered: 0, linkedin: 0, reached: 0, replies: 0, meetings: 0, booked: 0, replyRate: 0, meetingRate: 0, people: new Set() });

/** A roll-up keyed by FO, pod, campaign or product. */
class Rollup {
  private rows = new Map<string, Acc>();
  constructor(private label: (key: string) => string, private flag?: (key: string) => boolean) {}
  private row(key: string) {
    let r = this.rows.get(key);
    if (!r) { r = emptyRow(key, this.label(key)); if (this.flag?.(key)) r.cold = true; this.rows.set(key, r); }
    return r;
  }
  sent(key: string, channel: Channel, person: string | null, answered: boolean) {
    const r = this.row(key);
    r.sent += 1;
    if (channel === 'EMAIL') r.emails += 1;
    else if (channel === 'CALL') { r.calls += 1; if (answered) r.answered += 1; }
    else r.linkedin += 1;
    if (person) r.people.add(person);
  }
  reply(key: string) { this.row(key).replies += 1; }
  meeting(key: string) { this.row(key).meetings += 1; }
  booked(key: string) { this.row(key).booked += 1; }
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

const emptyActivity = (): Activity => ({ sent: 0, emails: 0, calls: 0, linkedin: 0, dials: 0, connects: 0, replies: 0, meetings: 0, booked: 0 });

export type Reports = Awaited<ReturnType<typeof buildReports>>;

/**
 * The report for one period and one audience (PLAN 6). Every figure is the shared metrics module's
 * (8.14), read once for every audience as rows credited to a rep and a pod at the time (rules 5, 6)
 * with the audience stamped when each was written (rule 1), so a move never rewrites the past
 * (B037), All outreach = CRM + Cold (+ calls not matched yet) for every count of work done (B122),
 * and Home's board reads the same figure for a rep and week (B096). Every read is bounded by the
 * period and every row is bucketed once, so a 90-day or year-long range costs about what a week does.
 */
export async function buildReports(user: SessionUser, today: LocalDate, filters?: ReportFilters, now = new Date()) {
  const range = filters?.range ?? reportingRange(undefined, undefined, today);
  const audience: AudienceScope = filters?.audience ?? 'all';
  const tz = reportingTimezone();
  const podId = filters?.podId ?? null;
  const foUserId = filters?.foUserId ?? null;
  const period = { from: range.fromInstant, to: range.toInstant };
  const junior = isJuniorFo(user);
  const visiblePods = visiblePodIds(user);
  // Who the reader's report covers, then the pod and FO filters, on each row's credit: the rep who
  // did it and the pod at the time (B040). A junior reads their own work.
  const inScope = (c: Credit) =>
    (!junior || c.rep === user.id)
    && (visiblePods === null || c.rep === user.id || (!!c.pod && visiblePods.includes(c.pod)))
    && (!podId || c.pod === podId)
    && (!foUserId || c.rep === foUserId);

  const [sentAll, dialsAll, repliesAll, bookedAll, heldAll, otherRead, users, pods, dncAll, linkedinAll] = await Promise.all([
    sentRows('all', period),
    dialRows('all', period),
    replyRows('all', period),
    bookedRows('all', period),
    heldRows('all', period, now, { full: true }),
    // For the channel table: what was skipped in the period, and what is due in it and still open.
    prisma.task.findMany({
      where: { AND: [countTaskWhere(audience), { OR: [{ state: 'SKIPPED', OR: [{ completedAt: { gte: period.from, lt: period.to } }, { completedAt: null, updatedAt: { gte: period.from, lt: period.to } }] }, { state: 'PENDING', dueDate: { gte: range.from, lte: range.to }, enrollment: { status: { not: 'PAUSED' } } }] }] },
      select: { state: true, action: true, dueDate: true, snoozedTo: true, foUserId: true, enrollment: { select: { podId: true } } },
    }),
    prisma.user.findMany({ select: { id: true, name: true, active: true } }),
    prisma.pod.findMany({ select: { id: true, name: true } }),
    doNotContactEmails(period),
    // LinkedIn requests and messages the Console reported, and LinkedIn tasks open now.
    linkedinRows(period),
  ]);
  const sent = sentAll.filter(inScope);
  const dials = dialsAll.filter(inScope);
  const replies = repliesAll.filter(inScope);
  const booked = bookedAll.filter(inScope);
  const held = heldAll.filter(inScope);
  const other = (await withPods(otherRead.map((t) => ({ ...t, rep: t.foUserId, pod: t.enrollment.podId })))).filter(inScope);
  const dnc = (await withPods(dncAll)).filter(inScope);

  // Each side's activity figures, for the sub-lines of All outreach: "10 · 7 CRM · 3 Cold".
  const activityOf = (stamp: Stamp | 'all'): Activity => {
    const on = (s: Stamp) => stamp === 'all' || s === stamp;
    const a = emptyActivity();
    for (const r of sent) if (on(r.audience)) { a.sent += 1; if (r.channel === 'EMAIL') a.emails += 1; else if (r.channel === 'CALL') a.calls += 1; else a.linkedin += 1; }
    for (const r of dials) if (on(r.audience)) { a.dials += 1; if (r.connected) a.connects += 1; }
    for (const r of replies) if (on(r.audience)) a.replies += 1;
    for (const r of held) if (on(r.audience)) a.meetings += 1;
    for (const r of booked) if (on(r.audience)) a.booked += 1;
    return a;
  };
  const parts = { crm: activityOf('CRM'), cold: activityOf('SANDBOX'), unmatched: activityOf(null) };
  const [reachedPeople, repliedPeople] = await Promise.all([peopleSplit([...sent, ...dials]), peopleSplit(replies)]);

  // From here on, the one audience this report shows.
  const view = <T extends { audience: Stamp }>(rows: T[]) => rows.filter((r) => inAudience(r.audience, audience));
  const vSent = view(sent), vDials = view(dials), vReplies = view(replies), vBooked = view(booked), vHeld = view(held);
  const personKey = await personKeyOf([...vSent, ...vReplies]);

  const campaignIds = new Set<string>();
  for (const r of [...vSent, ...vReplies, ...vBooked, ...vHeld]) if (r.campaignId) campaignIds.add(r.campaignId);
  const campaigns = campaignIds.size ? await prisma.campaign.findMany({ where: { id: { in: [...campaignIds] } }, select: { id: true, name: true, productInterest: true, audience: true } }) : [];

  // N065: a rep who has left keeps their figures, marked "(removed)".
  const userName = new Map(users.map((u) => [u.id, u.active ? u.name : `${u.name} (removed)`]));
  const podName = new Map(pods.map((p) => [p.id, p.name]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const productsOf = (campaignId: string | null) => {
    const list = campaignId ? campaignById.get(campaignId)?.productInterest ?? [] : [];
    return list.length ? list : [NO_PRODUCT];
  };

  const byFo = new Rollup((k) => (k === 'none' ? 'No rep yet' : userName.get(k) ?? 'Unknown'));
  const byPod = new Rollup((k) => (k === 'none' ? 'No pod' : podName.get(k) ?? 'Archived pod'));
  const byCampaign = new Rollup((k) => (k === 'none' ? 'Not in a campaign' : campaignById.get(k)?.name ?? 'Deleted campaign'), (k) => campaignById.get(k)?.audience === 'SANDBOX');
  const byProduct = new Rollup(productLabel);
  const series = buckets(range.from, range.to);
  const dayIndex = (at: Date) => series.of.get(toLocalDate(at, tz));
  const sentBy: Record<Channel, number> = { EMAIL: 0, CALL: 0, LINKEDIN: 0 };
  const reached = new Set<string>();
  let answered = 0;

  for (const r of vSent) {
    const person = personKey(r);
    if (person) reached.add(person);
    sentBy[r.channel] += 1;
    if (r.answered) answered += 1;
    byFo.sent(r.rep ?? 'none', r.channel, person, r.answered);
    byPod.sent(r.pod ?? 'none', r.channel, person, r.answered);
    byCampaign.sent(r.campaignId ?? 'none', r.channel, person, r.answered);
    for (const p of productsOf(r.campaignId)) byProduct.sent(p, r.channel, person, r.answered);
    const i = dayIndex(r.at);
    if (i !== undefined) {
      const b = series.list[i];
      b.sent += 1;
      if (r.channel === 'EMAIL') b.emails += 1; else if (r.channel === 'CALL') b.calls += 1; else b.linkedin += 1;
    }
  }

  const replied = new Set<string>();
  for (const r of vReplies) {
    const person = personKey(r);
    if (person) replied.add(person);
    byFo.reply(r.rep ?? 'none');
    byPod.reply(r.pod ?? 'none');
    byCampaign.reply(r.campaignId ?? 'none');
    for (const p of productsOf(r.campaignId)) byProduct.reply(p);
    const i = dayIndex(r.at);
    if (i !== undefined) series.list[i].replies += 1;
  }

  // A meeting held belongs to whoever booked it, to the campaign that was reaching its contact, and
  // to the products it is tagged with (else that campaign's products).
  const meetingSlices = new Map<string, number>();
  for (const m of vHeld) {
    byFo.meeting(m.rep ?? 'none');
    byPod.meeting(m.pod ?? 'none');
    byCampaign.meeting(m.campaignId ?? 'none');
    const tagged = m.products.length ? [...m.products] : productsOf(m.campaignId).filter((p) => p !== NO_PRODUCT);
    for (const p of tagged.length ? tagged : [NO_PRODUCT]) byProduct.meeting(p);
    const slice = tagged.length === 1 ? tagged[0] : tagged.length ? SEVERAL_PRODUCTS : NO_PRODUCT;
    meetingSlices.set(slice, (meetingSlices.get(slice) ?? 0) + 1);
    const i = dayIndex(m.at);
    if (i !== undefined) series.list[i].meetings += 1;
  }
  for (const f of vBooked) {
    byFo.booked(f.rep ?? 'none');
    byPod.booked(f.pod ?? 'none');
    byCampaign.booked(f.campaignId ?? 'none');
    for (const p of productsOf(f.campaignId)) byProduct.booked(p);
  }

  // Each channel: what was done and how we know, what was skipped, and what is still open.
  const doneBy = new Map<string, number>();
  const observed = new Map<string, number>();
  const manual = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of vSent) {
    bump(doneBy, r.action);
    if (r.source?.startsWith('OBSERVED')) bump(observed, r.action);
    else if (r.source === 'MANUAL') bump(manual, r.action);
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
  const total = sentBy.EMAIL + sentBy.CALL + sentBy.LINKEDIN;
  const connects = vDials.filter((d) => d.connected).length;
  const cold = audience === 'cold' ? await coldFunnel(period, inScope, { sent: vSent, dials: vDials, booked: vBooked }, userName) : null;

  return {
    today,
    audience,
    range: { from: range.from, to: range.to },
    unit: series.unit,
    series: series.list,
    totals: {
      sent: total, emails: sentBy.EMAIL, calls: sentBy.CALL, answered, linkedin: sentBy.LINKEDIN, reached: reached.size,
      replies: vReplies.length, repliedPeople: replied.size, meetings: vHeld.length, booked: vBooked.length,
      dials: vDials.length, connects, replyRate: total ? vReplies.length / total : 0, meetingRate: total ? vHeld.length / total : 0,
      /** N016: emails sent to people who must not be contacted, seen in the period. */
      doNotContactEmails: dnc.filter((d) => inAudience(d.audience, audience)).length,
    },
    /** All outreach's sub-lines: each side's activity (additive), and the people figures (each person once). */
    parts,
    people: { reached: reachedPeople, replied: repliedPeople },
    sentByChannel: CHANNELS.map((c) => ({ key: c.key, label: c.label, value: sentBy[c.key] })) as Slice[],
    meetingsByProduct: [...meetingSlices.entries()].map(([key, value]) => ({ key, label: productLabel(key), value })).sort((a, b) => sliceOrder(a.key) - sliceOrder(b.key)) as Slice[],
    byFo: byFo.list(),
    byPod: byPod.list(),
    byCampaign: byCampaign.list(),
    byProduct: products,
    channels,
    cold,
    /** LinkedIn per rep and in total (reports-linkedin.ts); its replies are part of Replies above, not added to them. */
    linkedin: linkedinReport(linkedinAll, vReplies, { audience, inScope, today, userName }),
  };
}

/**
 * Cold outreach's funnel (PLAN 6): Added → Claimed → Worked → Connected → Meeting booked → Moved to
 * CRM, plus Opted out and Removed, each a number of contacts. Claimed is the first real claim, never a
 * push (B194); moves, opt-outs and removals are read from the audit log, so an Undo or a lift later
 * never changes a past period. Worked, Connected and Meeting booked are contacts, not calls (B194).
 * By rep: who claimed (the owner), worked, called, booked and moved them.
 */
async function coldFunnel(period: { from: Date; to: Date }, inScope: (c: Credit) => boolean, rows: { sent: Array<Who & Credit>; dials: Array<Who & Credit & { connected: boolean }>; booked: Array<Who & Credit> }, userName: Map<string, string>): Promise<{ funnel: ColdFunnel; byRep: ColdFunnelRow[] }> {
  const between = { gte: period.from, lt: period.to };
  const [created, claimed, audits] = await Promise.all([
    prisma.sandboxContact.findMany({ where: { createdAt: between }, select: { id: true, ownerId: true, podId: true, source: true } }),
    prisma.sandboxContact.findMany({ where: { firstClaimedAt: between }, select: { id: true, ownerId: true, podId: true } }),
    prisma.auditLog.findMany({ where: { entityType: 'sandbox_contact', action: { in: ['sandbox_moved', 'opted_out', 'removed'] }, createdAt: between }, select: { entityId: true, action: true, actorId: true } }),
  ]);
  const contacts = new Map((audits.length ? await prisma.sandboxContact.findMany({ where: { id: { in: [...new Set(audits.map((a) => a.entityId))] } }, select: { id: true, ownerId: true, podId: true } }) : []).map((c) => [c.id, c]));
  const ofContact = (c: { ownerId: string | null; podId: string | null }): Credit => ({ rep: c.ownerId, pod: c.podId });
  const audited = (action: string, credit: (a: (typeof audits)[number]) => Credit) => {
    const ids = new Map<string, Credit>();
    for (const a of audits) if (a.action === action && !ids.has(a.entityId)) { const c = credit(a); if (inScope(c)) ids.set(a.entityId, c); }
    return ids;
  };
  const moved = audited('sandbox_moved', (a) => ({ rep: a.actorId, pod: contacts.get(a.entityId)?.podId ?? null }));
  const optedOut = audited('opted_out', (a) => ofContact(contacts.get(a.entityId) ?? { ownerId: null, podId: null }));
  const removed = audited('removed', (a) => ofContact(contacts.get(a.entityId) ?? { ownerId: null, podId: null }));
  const added = created.filter((c) => inScope(ofContact(c)));
  const claims = claimed.filter((c) => inScope(ofContact(c)));
  // One contact per stage, credited to the first rep seen doing it.
  const contactsBy = (list: Array<Who & Credit>) => {
    const m = new Map<string, string | null>();
    for (const r of list) if (r.sandboxContactId && !m.has(r.sandboxContactId)) m.set(r.sandboxContactId, r.rep);
    return m;
  };
  const worked = contactsBy([...rows.sent, ...rows.dials]);
  const connected = contactsBy(rows.dials.filter((d) => d.connected));
  const booked = contactsBy(rows.booked);

  const by = new Map<string, ColdFunnelRow>();
  const row = (rep: string | null) => {
    const key = rep ?? 'none';
    let r = by.get(key);
    if (!r) { r = { key, label: rep ? userName.get(rep) ?? 'Unknown' : 'Nobody', claimed: 0, worked: 0, connected: 0, booked: 0, moved: 0 }; by.set(key, r); }
    return r;
  };
  for (const c of claims) row(c.ownerId).claimed += 1;
  for (const rep of worked.values()) row(rep).worked += 1;
  for (const rep of connected.values()) row(rep).connected += 1;
  for (const rep of booked.values()) row(rep).booked += 1;
  for (const c of moved.values()) row(c.rep).moved += 1;
  return {
    funnel: { added: added.length, fromBellwether: added.filter((c) => c.source === 'BELLWETHER').length, claimed: claims.length, worked: worked.size, connected: connected.size, booked: booked.size, moved: moved.size, optedOut: optedOut.size, removed: removed.size },
    byRep: [...by.values()].sort((a, b) => b.worked - a.worked || b.claimed - a.claimed || a.label.localeCompare(b.label)),
  };
}
