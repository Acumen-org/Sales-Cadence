import type { CallSource, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { getSettings } from '../settings';
import { callOutcomes } from '../call-outcomes';
import { workspaceTimezone } from '../workspace';
import { countWhere, loadSubjects, refKey, refOf, type AudienceScope, type LoadedSubject } from '../subject';
import { connectedBy } from '../outreach/metrics';

/**
 * Reports > Calls (PLAN 6). Every figure is defined once, here and in the shared metrics module
 * (dials, connects: 8.14), and follows the report's audience: All outreach = CRM + Cold + Not matched
 * yet (B122). A call counts for the rep who made it (rule 5) and the pod it was stamped with at the
 * time (rule 6, B040), or its rep's first pod when it has none.
 */

export type CallFilters = { from: Date; to: Date; podId?: string | null; foUserId?: string | null; campaignId?: string | null; direction?: 'OUTBOUND' | 'INBOUND' | null; source?: CallSource | null };
/** The parts of All outreach on calls. */
export type CallPart = 'crm' | 'cold' | 'unmatched';

export type CallTotals = {
  dials: number; inbound: number;
  /** Outbound calls the person answered (B126): connects and the connect rate count the same calls. */
  connects: number; connectRate: number;
  /** Incoming calls that were answered: their own line, never in the connect rate (B126). */
  inboundAnswered: number;
  conversations: number; talkSec: number; avgTalkPerConnect: number; meetings: number; avgRating: number | null;
  formsOutstanding: number; medianMinutesToForm: number | null; costUsd: number;
  /** B029: calls to someone who had opted out, from the form's flag. */
  calledOptedOut: number;
  /** Voicemails left over two minutes long (S4's flag). */
  longVoicemails: number;
};

/** Calls on one page of the list, and of the Unmatched list (B124, B196: paged, never cut silently). */
export const CALLS_PAGE = 50;

/**
 * N046: forms waiting now, whatever the period, by whoever holds them (the rep, or whom it was handed
 * to), with the oldest one's due time: the backlog leaders chase. Scoped by pod or rep only.
 */
export async function formsWaiting(f: { podId?: string | null; foUserId?: string | null; campaignId?: string | null; direction?: 'OUTBOUND' | 'INBOUND' | null; part?: CallPart | null } = {}): Promise<Map<string, { count: number; oldest: Date }>> {
  const podUsers = f.podId ? (await prisma.userPod.findMany({ where: { podId: f.podId }, select: { userId: true } })).map((u) => u.userId) : null;
  // M36: the backlog follows the report's audience, campaign and direction too.
  const scope: Prisma.CallLogWhereInput = { ...(f.campaignId ? { campaignId: f.campaignId } : {}), ...(f.direction ? { direction: f.direction } : {}), ...(f.part ? { audience: f.part === 'crm' ? 'CRM' : f.part === 'cold' ? 'SANDBOX' : null } : {}) };
  const rows = await prisma.callLog.findMany({ where: { formDueAt: { not: null }, formDoneAt: null, discardedAt: null, ...scope }, select: { userId: true, formUserId: true, formDueAt: true } });
  const by = new Map<string, { count: number; oldest: Date }>();
  for (const r of rows) {
    const holder = r.formUserId ?? r.userId;
    if (!holder || (f.foUserId && holder !== f.foUserId) || (podUsers && !podUsers.includes(holder))) continue;
    const cur = by.get(holder);
    if (!cur) by.set(holder, { count: 1, oldest: r.formDueAt! });
    else { cur.count++; if (r.formDueAt! < cur.oldest) cur.oldest = r.formDueAt!; }
  }
  return by;
}

/** The reps whose calls with no pod of their own count for this pod: those whose first pod by name it is. */
async function firstPodReps(podId: string): Promise<string[]> {
  const links = await prisma.userPod.findMany({ where: { user: { pods: { some: { podId } } } }, select: { userId: true, pod: { select: { id: true, name: true } } }, orderBy: { pod: { name: 'asc' } } });
  const first = new Map<string, string>();
  for (const l of links) if (!first.has(l.userId)) first.set(l.userId, l.pod.id);
  return [...first].filter(([, p]) => p === podId).map(([u]) => u);
}

/** The calls of the filters: the rep who made them, the pod at the time (B040), a campaign, a direction, a source. */
async function callScope(f: CallFilters): Promise<Prisma.CallLogWhereInput> {
  const pod: Prisma.CallLogWhereInput = f.podId ? { OR: [{ podId: f.podId }, { podId: null, userId: { in: await firstPodReps(f.podId) } }] } : {};
  return {
    AND: [pod],
    // A call discarded as a mistake counts nowhere (B024).
    discardedAt: null,
    ...(f.foUserId ? { userId: f.foUserId } : {}),
    ...(f.campaignId ? { campaignId: f.campaignId } : {}),
    ...(f.direction ? { direction: f.direction } : {}),
    ...(f.source ? { source: f.source } : {}),
  };
}

const callInclude = { form: { select: { outcome: true, rating: true, flags: true } }, user: { select: { id: true, name: true } } } satisfies Prisma.CallLogInclude;
type CallRow = Prisma.CallLogGetPayload<{ include: typeof callInclude }>;
/** M38: the figures read only what they need from each call of the period, not every column. */
const statSelect = { id: true, direction: true, status: true, talkSec: true, formDueAt: true, formDoneAt: true, priceUsd: true, audience: true, userId: true, startedAt: true, form: { select: { outcome: true, rating: true, flags: true } }, user: { select: { timezone: true } } } satisfies Prisma.CallLogSelect;
type StatRow = Prisma.CallLogGetPayload<{ select: typeof statSelect }>;
const partOf = (c: Pick<CallRow, 'audience'>): CallPart => (c.audience === 'CRM' ? 'crm' : c.audience === 'SANDBOX' ? 'cold' : 'unmatched');
const inPart = (audience: AudienceScope) => (c: Pick<CallRow, 'audience'>) => audience === 'all' || (audience === 'crm' ? c.audience === 'CRM' : c.audience === 'SANDBOX');

function totals(calls: StatRow[], connected: (c: StatRow) => boolean, conversationSeconds: number): CallTotals {
  const outbound = calls.filter((c) => c.direction === 'OUTBOUND');
  const connects = outbound.filter(connected);
  const talk = connects.reduce((n, c) => n + (c.talkSec ?? 0), 0);
  const rated = calls.filter((c) => c.form?.rating);
  // M39: only forms filled in count (a form a leader closed without one does not), and an even count takes the mean of the middle two.
  const waits = calls.filter((c) => c.form && c.formDoneAt && c.formDueAt).map((c) => (c.formDoneAt!.getTime() - c.formDueAt!.getTime()) / 60_000).sort((a, b) => a - b);
  const mid = waits.length / 2;
  const median = waits.length ? (waits.length % 2 ? waits[Math.floor(mid)] : (waits[mid - 1] + waits[mid]) / 2) : null;
  return {
    dials: outbound.length,
    inbound: calls.length - outbound.length,
    connects: connects.length,
    connectRate: outbound.length ? connects.length / outbound.length : 0,
    inboundAnswered: calls.filter((c) => c.direction === 'INBOUND' && connected(c)).length,
    conversations: connects.filter((c) => (c.talkSec ?? 0) >= conversationSeconds).length,
    talkSec: talk,
    avgTalkPerConnect: connects.length ? Math.round(talk / connects.length) : 0,
    meetings: calls.filter((c) => c.form?.outcome === 'meeting_booked').length,
    avgRating: rated.length ? Math.round((rated.reduce((n, c) => n + (c.form!.rating ?? 0), 0) / rated.length) * 10) / 10 : null,
    formsOutstanding: calls.filter((c) => c.formDueAt && !c.formDoneAt).length,
    medianMinutesToForm: median == null ? null : Math.round(median),
    costUsd: Math.round(calls.reduce((n, c) => n + Number(c.priceUsd ?? 0), 0) * 100) / 100,
    calledOptedOut: calls.filter((c) => c.form?.flags.includes('called_opted_out')).length,
    longVoicemails: calls.filter((c) => c.form?.flags.includes('long_voicemail')).length,
  };
}

/** A call's status in words (B124), never Twilio's raw value. */
export function callStatusWords(c: { status: string; direction: string; formDueAt?: Date | null; formDoneAt?: Date | null }): string {
  if (c.formDueAt && !c.formDoneAt) return 'Form due';
  switch (c.status) {
    case 'COMPLETED': return c.direction === 'INBOUND' ? 'Answered' : 'Completed';
    case 'NO_ANSWER': return 'Not answered';
    case 'BUSY': return 'Busy';
    case 'FAILED': return 'Did not go through';
    case 'CANCELED': return 'Cancelled before it rang';
    case 'IN_PROGRESS': return 'In progress';
    case 'RINGING': return 'Ringing';
    default: return 'Starting';
  }
}

/** One row of the Calls list or the Unmatched list: who it was with by name and firm (B124). */
export type CallListRow = CallRow & { subject: LoadedSubject | null };

async function withSubjects(calls: CallRow[]): Promise<CallListRow[]> {
  const loaded = await loadSubjects(calls.flatMap((c) => { const r = refOf(c); return r ? [r] : []; }));
  return calls.map((c) => { const r = refOf(c); return { ...c, subject: r ? loaded.get(refKey(r)) ?? null : null }; });
}

/**
 * Reports > Calls for one audience. `previous` is the period Outreach compares with, named the same
 * way (B195). The list and the Unmatched list are paged (B124, B196).
 */
export async function callReport(f: CallFilters & { audience?: AudienceScope; previous?: { from: Date; to: Date } | null; page?: number; unmatchedPage?: number }) {
  const audience = f.audience ?? 'all';
  const settings = await getSettings();
  const outcomes = callOutcomes(settings.rules);
  const connected = connectedBy(settings);
  const where = await callScope(f);
  const period = (from: Date, to: Date): Prisma.CallLogWhereInput => ({ AND: [where, { startedAt: { gte: from, lt: to } }] });
  const listWhere: Prisma.CallLogWhereInput = { AND: [period(f.from, f.to), countWhere(audience)] };
  // Calls to nobody yet, or by nobody yet: shown whatever the filters when they have no rep (B196);
  // in the CRM or Cold view, those whose contact is found and whose rep is missing.
  const unmatchedWhere: Prisma.CallLogWhereInput = {
    startedAt: { gte: f.from, lt: f.to }, discardedAt: null,
    OR: [{ userId: null }, { matchedBy: { in: ['none', 'ambiguous'] } }],
    AND: [{ OR: [{ userId: null }, where] }, countWhere(audience)],
  };
  const waitingScope = { podId: f.podId, foUserId: f.foUserId, campaignId: f.campaignId, direction: f.direction };
  const page = Math.max(1, f.page ?? 1);
  const unmatchedPage = Math.max(1, f.unmatchedPage ?? 1);
  const [calls, previousCalls, users, waiting, listTotal, listPage, unmatchedTotal, unmatchedRows] = await Promise.all([
    prisma.callLog.findMany({ where: period(f.from, f.to), select: statSelect, orderBy: { startedAt: 'desc' } }),
    f.previous ? prisma.callLog.findMany({ where: { AND: [period(f.previous.from, f.previous.to), countWhere(audience)] }, select: statSelect }) : Promise.resolve(null),
    prisma.user.findMany({ select: { id: true, name: true, active: true } }),
    formsWaiting({ ...waitingScope, part: audience === 'all' ? null : audience }),
    prisma.callLog.count({ where: listWhere }),
    prisma.callLog.findMany({ where: listWhere, include: callInclude, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * CALLS_PAGE, take: CALLS_PAGE }),
    prisma.callLog.count({ where: unmatchedWhere }),
    prisma.callLog.findMany({ where: unmatchedWhere, include: callInclude, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], skip: (unmatchedPage - 1) * CALLS_PAGE, take: CALLS_PAGE }),
  ]);
  const t = (list: StatRow[]) => totals(list, connected, settings.calling.conversationSeconds);
  const split: Record<CallPart | 'all', CallTotals> = { crm: t(calls.filter((c) => partOf(c) === 'crm')), cold: t(calls.filter((c) => partOf(c) === 'cold')), unmatched: t(calls.filter((c) => partOf(c) === 'unmatched')), all: t(calls) };
  const shown = calls.filter(inPart(audience));
  const head = audience === 'all' ? split.all : split[audience];
  // N046: forms outstanding are the backlog now, never only the period's; M36: in every column of the split, each its own part's.
  const backlog = async (part: CallPart | null) => [...(await formsWaiting({ ...waitingScope, part })).values()].reduce((n, w) => n + w.count, 0);
  [split.crm.formsOutstanding, split.cold.formsOutstanding, split.unmatched.formsOutstanding, split.all.formsOutstanding] = await Promise.all([backlog('crm'), backlog('cold'), backlog('unmatched'), backlog(null)]);
  // N065: a rep who has left keeps their row, marked "(removed)".
  const nameOf = (id: string) => { const u = users.find((x) => x.id === id); return u ? (u.active ? u.name : `${u.name} (removed)`) : 'Unknown'; };
  const repIds = new Set([...shown.map((c) => c.userId).filter((id): id is string => Boolean(id)), ...waiting.keys()]);
  const byRep = [...repIds].map((id) => ({ userId: id, name: nameOf(id), ...t(shown.filter((c) => c.userId === id)), formsOutstanding: waiting.get(id)?.count ?? 0, oldestFormDue: waiting.get(id)?.oldest ?? null })).sort((a, b) => b.dials - a.dials || b.formsOutstanding - a.formsOutstanding);
  const byOutcome = outcomes.map((o) => ({ key: o.key, label: o.label, count: shown.filter((c) => c.form?.outcome === o.key).length })).filter((o) => o.count);
  // M37: each call's hour on its rep's own clock, not the workspace's.
  const formats = new Map<string, Intl.DateTimeFormat>();
  const hourFmt = (tz: string) => { let fmt = formats.get(tz); if (!fmt) { try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', weekday: 'short', hour12: false }); } catch { fmt = new Intl.DateTimeFormat('en-US', { timeZone: workspaceTimezone(), hour: 'numeric', weekday: 'short', hour12: false }); } formats.set(tz, fmt); } return fmt; };
  const hours = new Map<string, { dials: number; connects: number }>();
  for (const c of shown) {
    if (c.direction !== 'OUTBOUND' || !c.startedAt) continue;
    const parts = hourFmt(c.user?.timezone || workspaceTimezone()).formatToParts(c.startedAt);
    const key = `${parts.find((p) => p.type === 'weekday')?.value} ${Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24}`;
    const cell = hours.get(key) ?? { dials: 0, connects: 0 };
    cell.dials++;
    if (connected(c)) cell.connects++;
    hours.set(key, cell);
  }
  const bestHours = [...hours.entries()].map(([slot, v]) => ({ slot, ...v, rate: v.dials ? v.connects / v.dials : 0 })).filter((h) => h.dials >= 3).sort((a, b) => b.rate - a.rate).slice(0, 6);
  const [list, unmatched] = await Promise.all([withSubjects(listPage), withSubjects(unmatchedRows)]);
  return {
    audience,
    totals: head,
    previous: previousCalls ? t(previousCalls) : null,
    split,
    byRep,
    byOutcome,
    bestHours,
    calls: list,
    callsTotal: listTotal,
    page,
    pages: Math.max(1, Math.ceil(listTotal / CALLS_PAGE)),
    unmatched,
    unmatchedTotal,
    unmatchedPage,
    unmatchedPages: Math.max(1, Math.ceil(unmatchedTotal / CALLS_PAGE)),
    outcomes,
  };
}

export type CallReport = Awaited<ReturnType<typeof callReport>>;
